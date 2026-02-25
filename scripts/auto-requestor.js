#!/usr/bin/env node
// auto-requestor.js — Watches for bids on your listings, auto-accepts first valid bid.
// First come, first served: first bid meeting criteria wins.
// Creates escrow, XMTP group, sends task, monitors for results, releases payment.
//
// Reads from swarm.config.json (or --config <path>).

import { encodeText } from '@xmtp/agent-sdk';
import { MessageType } from '../src/protocol.js';
import { createSwarmAgent, sendProtocolMessage, createSwarmGroup } from '../src/agent.js';
import fs from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = join(__dirname, '..');

// Parse --config flag
const args = process.argv.slice(2);
let configPath = join(SKILL_DIR, 'swarm.config.json');
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--config') configPath = join(SKILL_DIR, args[++i]);
}

if (!fs.existsSync(configPath)) {
  console.error(`Config not found: ${configPath}`);
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
if (config.wallet?.privateKey?.startsWith('env:')) {
  config.wallet.privateKey = process.env[config.wallet.privateKey.slice(4)];
}

const BOARD_ID = config.board?.id;
const POLL_INTERVAL = 5000;
const DRY_RUN = args.includes('--dry-run');

const log = (label, ...args) => {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] [${label}]`, ...args);
};

// ─── State ───

const TASK_LOG_PATH = join(SKILL_DIR, 'tasks.json');
const STATE_FILE = join(SKILL_DIR, 'data', 'auto-requestor-state.json');

function loadTaskLog() {
  if (fs.existsSync(TASK_LOG_PATH)) {
    try { return JSON.parse(fs.readFileSync(TASK_LOG_PATH, 'utf-8')); } catch {}
  }
  return { tasks: {}, bids: {} };
}

function saveTaskLog(taskLog) {
  fs.writeFileSync(TASK_LOG_PATH, JSON.stringify(taskLog, null, 2));
}

const seenMessages = new Set();
const acceptedTasks = new Set(); // tasks that already have an accepted bid

// Load persisted state
try {
  if (fs.existsSync(STATE_FILE)) {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    (state.messages || []).forEach(id => seenMessages.add(id));
    (state.acceptedTasks || []).forEach(id => acceptedTasks.add(id));
  }
} catch {}

function persistState() {
  try {
    fs.mkdirSync(join(SKILL_DIR, 'data'), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      messages: [...seenMessages].slice(-1000),
      acceptedTasks: [...acceptedTasks],
    }));
  } catch {}
}

async function main() {
  console.log(`
╔═══════════════════════════════════════════════════╗
║  AUTO-REQUESTOR — Watches bids, auto-accepts.     ║
║  First valid bid wins. Creates escrow + assigns.   ║
╚═══════════════════════════════════════════════════╝
`);

  if (!BOARD_ID) {
    log('ERROR', 'No board ID in config.');
    process.exit(1);
  }

  const { ethers } = await import('ethers');
  const wallet = new ethers.Wallet(config.wallet.privateKey);
  const dbName = config.xmtp?.dbPath || `.xmtp-${wallet.address.slice(2, 10).toLowerCase()}`;
  const dbPath = dbName.startsWith('/') ? dbName : join(SKILL_DIR, dbName);

  const { agent, address } = await createSwarmAgent(config.wallet.privateKey, {
    env: config.xmtp?.env || 'production',
    dbPath,
  });
  await agent.start();

  log('INIT', `Requestor: ${address}`);
  log('INIT', `Board: ${BOARD_ID}`);
  log('INIT', `Dry run: ${DRY_RUN}`);

  const client = agent.client || agent;
  await client.conversations.syncAll();
  const convos = await client.conversations.list();
  const board = convos.find(c => c.id === BOARD_ID);

  if (!board) {
    log('ERROR', 'Board not found.');
    await agent.stop();
    process.exit(1);
  }

  // Load our open listings
  const taskLog = loadTaskLog();
  const myOpenTasks = Object.values(taskLog.tasks).filter(
    t => t.requestor === address && t.status === 'open'
  );
  log('INIT', `Open listings: ${myOpenTasks.length}`);
  for (const t of myOpenTasks) {
    log('INIT', `  "${t.title}" — $${t.budget} USDC [${t.id}]`);
  }

  log('READY', `Watching for bids...`);

  async function poll() {
    try {
      await board.sync();
      const msgs = await board.messages({ limit: 50 });

      for (const m of msgs) {
        if (seenMessages.has(m.id)) continue;
        seenMessages.add(m.id);
        if (m.senderInboxId === client.inboxId) continue;

        let parsed;
        try {
          const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
          parsed = JSON.parse(text);
        } catch { continue; }
        if (!parsed?.type) continue;

        // Handle bids on our listings
        if (parsed.type === 'bid' || parsed.type === MessageType.BID) {
          const taskId = parsed.taskId;
          const task = taskLog.tasks[taskId];

          // Is this a bid on one of our tasks?
          if (!task || task.requestor !== address) continue;

          // Already accepted a bid for this task? First come, first served.
          if (acceptedTasks.has(taskId)) {
            log('BID', `"${task.title}" — bid from ${parsed.worker?.slice(0, 10)} REJECTED (already accepted — first come first served)`);
            // Notify the late bidder
            if (!DRY_RUN) {
              try {
                await board.send(encodeText(JSON.stringify({
                  type: 'bid_reject',
                  taskId,
                  worker: parsed.worker,
                  reason: 'Task already assigned to another worker (first come, first served).',
                })));
              } catch {}
            }
            continue;
          }

          const bidPrice = parseFloat(parsed.price);
          const budget = parseFloat(task.budget);

          log('BID', `"${task.title}" — $${parsed.price} from ${parsed.worker?.slice(0, 10)}`);

          // Criteria check: price must be within budget
          if (bidPrice > budget) {
            log('EVAL', `  REJECTED: bid $${bidPrice} exceeds budget $${budget}`);
            continue;
          }

          // First valid bid wins
          log('EVAL', `  ACCEPTED: $${parsed.price} ≤ $${task.budget} budget`);
          acceptedTasks.add(taskId);

          if (DRY_RUN) {
            log('DRY-RUN', `  Would accept bid and create escrow`);
            persistState();
            continue;
          }

          const workerAddr = parsed.worker;
          const amount = parsed.price;
          const deadlineHours = parseInt(config.escrow?.defaultDeadlineHours || 24);
          const deadline = Math.floor(Date.now() / 1000) + (deadlineHours * 3600);

          // 1. Create escrow on-chain
          try {
            const { loadWallet } = await import('../src/wallet.js');
            const w = loadWallet(config.wallet.privateKey);
            const { createMilestoneEscrow, getDefaultMilestoneEscrowAddress } = await import('../src/milestone-escrow.js');

            log('ESCROW', `Creating escrow: $${amount} USDC for ${workerAddr.slice(0, 10)}...`);
            const escrowAddr = config.milestoneEscrow?.address || getDefaultMilestoneEscrowAddress();
              const { txHash } = await createMilestoneEscrow(w, escrowAddr, {
              taskId,
              worker: workerAddr,
              milestones: [{ amount, deadline }],
            });
            log('ESCROW', `Created: ${txHash}`);

            // 2. Send bid_accept to board
            await board.send(encodeText(JSON.stringify({
              type: MessageType.BID_ACCEPT,
              taskId,
              worker: workerAddr,
              amount,
            })));
            log('ACCEPT', `Bid accepted on board`);

            // 3. Create private XMTP group with worker
            const group = await createSwarmGroup(agent, [workerAddr], `Task: ${task.title}`);
            log('GROUP', `Private group created: ${group.id}`);

            // 4. Send task to private group
            await sendProtocolMessage(group, {
              type: MessageType.TASK,
              id: taskId,
              title: task.title,
              description: task.description || task.title,
              budget: amount,
              subtasks: [{ id: `${taskId}-s1`, title: task.title }],
            });

            // 5. Send escrow_created to private group
            await sendProtocolMessage(group, {
              type: MessageType.ESCROW_CREATED,
              taskId,
              txHash,
              amount,
              deadline,
            });
            log('TASK', `Task assigned to ${workerAddr.slice(0, 10)}`);

            // Update task log
            task.status = 'accepted';
            task.worker = workerAddr;
            task.groupId = group.id;
            task.escrowTx = txHash;
            task.deadline = deadline;
            saveTaskLog(taskLog);

          } catch (err) {
            log('ERROR', `Escrow/accept failed: ${err.message?.slice(0, 100)}`);
            acceptedTasks.delete(taskId); // allow retry
          }

          persistState();
        }

        // Handle results (worker delivered)
        if (parsed.type === 'result' || parsed.type === MessageType.RESULT) {
          const taskId = parsed.taskId;
          const task = taskLog.tasks[taskId];
          if (!task || task.requestor !== address) continue;

          log('RESULT', `"${task.title}" — delivery from ${parsed.worker?.slice(0, 10)}`);

          // Auto-release escrow
          if (!DRY_RUN && task.escrowTx) {
            try {
              const { loadWallet } = await import('../src/wallet.js');
              const w = loadWallet(config.wallet.privateKey);
              const { releaseMilestone, getDefaultMilestoneEscrowAddress } = await import('../src/milestone-escrow.js');

              log('RELEASE', `Releasing milestone payment...`);
              const escrowAddr2 = config.milestoneEscrow?.address || getAddr();
                const releaseAddr = config.milestoneEscrow?.address || getDefaultMilestoneEscrowAddress();
                const { txHash } = await releaseMilestone(w, releaseAddr, taskId, 0);
              log('RELEASE', `Paid: ${txHash}`);

              // Send payment confirmation
              await board.send(encodeText(JSON.stringify({
                type: MessageType.PAYMENT,
                taskId,
                worker: parsed.worker,
                amount: task.budget,
                txHash,
              })));

              task.status = 'paid';
              task.releaseTx = txHash;
              saveTaskLog(taskLog);

            } catch (err) {
              log('ERROR', `Release failed: ${err.message?.slice(0, 100)}`);
            }
          }
        }
      }
    } catch (e) {
      log('ERROR', e.message?.slice(0, 100));
    }
  }

  // Also watch private groups for results
  async function pollGroups() {
    try {
      await client.conversations.syncAll();
      const allConvos = await client.conversations.list();
      for (const c of allConvos) {
        if (c.id === BOARD_ID) continue;
        await c.sync();
        const msgs = await c.messages({ limit: 10 });
        for (const m of msgs) {
          if (seenMessages.has(m.id)) continue;
          seenMessages.add(m.id);
          if (m.senderInboxId === client.inboxId) continue;

          let parsed;
          try {
            const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
            parsed = JSON.parse(text);
          } catch { continue; }
          if (!parsed?.type) continue;

          if (parsed.type === 'result' || parsed.type === MessageType.RESULT) {
            const taskId = parsed.taskId;
            const task = taskLog.tasks[taskId];
            if (!task || task.requestor !== address) continue;
            if (task.status === 'paid') continue;

            log('RESULT', `"${task.title}" — delivery in private group`);

            if (!DRY_RUN && task.escrowTx) {
              try {
                const { loadWallet } = await import('../src/wallet.js');
                const w = loadWallet(config.wallet.privateKey);
                const mEscrow = await import('../src/milestone-escrow.js');

                log('RELEASE', `Releasing milestone payment...`);
                const escrowAddr2 = config.milestoneEscrow?.address || getAddr();
                const releaseAddr = config.milestoneEscrow?.address || getDefaultMilestoneEscrowAddress();
                const { txHash } = await releaseMilestone(w, releaseAddr, taskId, 0);
                log('RELEASE', `Paid: ${txHash}`);

                await board.send(encodeText(JSON.stringify({
                  type: MessageType.PAYMENT,
                  taskId,
                  worker: parsed.worker,
                  amount: task.budget,
                  txHash,
                })));

                task.status = 'paid';
                task.releaseTx = txHash;
                saveTaskLog(taskLog);
              } catch (err) {
                log('ERROR', `Release failed: ${err.message?.slice(0, 100)}`);
              }
            }
          }
        }
      }
    } catch (e) {
      log('ERROR', `Group poll: ${e.message?.slice(0, 80)}`);
    }
  }

  await poll();
  setInterval(poll, POLL_INTERVAL);
  setInterval(pollGroups, POLL_INTERVAL * 3);
  setInterval(persistState, 30000);

  process.on('SIGINT', async () => { persistState(); await agent.stop(); process.exit(0); });
  process.on('SIGTERM', async () => { persistState(); await agent.stop(); process.exit(0); });
}

main().catch(err => { console.error('Auto-requestor failed:', err.message); process.exit(1); });
