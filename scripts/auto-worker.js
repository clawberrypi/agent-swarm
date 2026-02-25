#!/usr/bin/env node
// auto-worker.js — Autonomous worker agent that sits on the bulletin board,
// polls for new listings, evaluates against its skills, auto-bids,
// and monitors private groups for task assignments to execute and deliver.

import { encodeText } from '@xmtp/agent-sdk';
import { MessageType, createClaim, createResult } from '../src/protocol.js';
import { createSwarmAgent } from '../src/agent.js';
import { createProfile, broadcastProfile } from '../src/profile.js';
import fs from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = join(__dirname, '..');

// Parse flags
const args = process.argv.slice(2);
let configPath = join(SKILL_DIR, 'swarm.config.json');
let keyOverride = null;
const DRY_RUN = args.includes('--dry-run');
const SCAN_ONLY = args.includes('--scan-only');
const WORK_ONLY = args.includes('--work-only');
const ONCE = args.includes('--once');

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--config') configPath = join(SKILL_DIR, args[++i]);
  if (args[i] === '--key') keyOverride = args[++i];
}

if (!fs.existsSync(configPath)) {
  console.error(`Config not found: ${configPath}`);
  console.error('Run: node cli.js setup init');
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
if (keyOverride) config.wallet.privateKey = keyOverride;
if (config.wallet?.privateKey?.startsWith('env:')) {
  config.wallet.privateKey = process.env[config.wallet.privateKey.slice(4)];
}

const WORKER_KEY = config.wallet.privateKey;
const BOARD_ID = config.board?.id;
const MY_SKILLS = config.worker?.skills || ['coding', 'research'];
const MY_RATES = config.worker?.rates || {};
const MAX_BID = parseFloat(config.worker?.maxBid || '20.00');
const MIN_BID = parseFloat(config.worker?.minBid || '0.50');
const AUTO_ACCEPT = config.worker?.autoAccept || false;
const POLL_INTERVAL = 5000;
const GROUP_POLL_INTERVAL = 8000;

const log = (label, ...a) => {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] [${label}]`, ...a);
};

// ─── State ───

const STATE_FILE = join(SKILL_DIR, 'data', 'auto-work-state.json');
const seenMessages = new Set();
const seenListings = new Set();
const activeTasks = new Map(); // taskId → { groupId, title, status }

try {
  if (fs.existsSync(STATE_FILE)) {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    (state.messages || []).forEach(id => seenMessages.add(id));
    (state.listings || []).forEach(id => seenListings.add(id));
    if (state.activeTasks) {
      for (const [k, v] of Object.entries(state.activeTasks)) activeTasks.set(k, v);
    }
  }
} catch {}

function persistState() {
  try {
    fs.mkdirSync(join(SKILL_DIR, 'data'), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      messages: [...seenMessages].slice(-1000),
      listings: [...seenListings].slice(-500),
      activeTasks: Object.fromEntries(activeTasks),
    }));
  } catch {}
}

async function main() {
  console.log(`
╔════════════════════════════════════════════════╗
║  AUTO-WORKER — Autonomous Agent on the Board   ║
║  Watches listings. Evaluates. Bids. Works.     ║
╚════════════════════════════════════════════════╝
`);

  if (!BOARD_ID) {
    log('ERROR', 'No board ID in config. Run: node cli.js board connect --id <id>');
    process.exit(1);
  }

  const { ethers } = await import('ethers');
  const wallet = new ethers.Wallet(WORKER_KEY);
  const dbName = config.xmtp?.dbPath || `.xmtp-${wallet.address.slice(2, 10).toLowerCase()}`;
  const dbPath = dbName.startsWith('/') ? dbName : join(SKILL_DIR, dbName);

  const { agent, address } = await createSwarmAgent(WORKER_KEY, {
    env: config.xmtp?.env || 'production',
    dbPath,
  });
  await agent.start();

  log('INIT', `Worker: ${address}`);
  log('INIT', `Skills: ${MY_SKILLS.join(', ')}`);
  log('INIT', `Board: ${BOARD_ID}`);
  log('INIT', `Auto-bid: ${AUTO_ACCEPT} | Dry run: ${DRY_RUN}`);

  const client = agent.client || agent;
  await client.conversations.syncAll();
  const convos = await client.conversations.list();
  const board = convos.find(c => c.id === BOARD_ID);

  if (!board) {
    log('ERROR', 'Board not found in conversations. Make sure you are a member.');
    await agent.stop();
    process.exit(1);
  }

  // Post profile
  if (!WORK_ONLY) {
    const profile = createProfile(address, {
      skills: MY_SKILLS,
      rates: MY_RATES,
      description: 'OpenClaw agent ready for work.',
    });
    await broadcastProfile(board, profile);
    log('BOARD', 'profile posted');
  }

  log('READY', `polling board every ${POLL_INTERVAL / 1000}s for new listings...`);

  // ─── Board polling: scan listings and bid ───

  async function pollBoard() {
    if (WORK_ONLY) return;
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

        // Handle listings
        if (parsed.type === 'listing' || parsed.type === MessageType.LISTING) {
          if (seenListings.has(parsed.taskId)) continue;
          seenListings.add(parsed.taskId);

          log('BOARD', `new listing: "${parsed.title}"`);
          log('BOARD', `  budget: $${parsed.budget} USDC | skills: ${(parsed.skills_needed || []).join(', ')}`);

          const needed = parsed.skills_needed || [];
          const matches = needed.length === 0 ? MY_SKILLS : needed.filter(s => MY_SKILLS.includes(s));
          const budget = parseFloat(parsed.budget);

          if (matches.length === 0 && needed.length > 0) {
            log('EVAL', `skip: no skill match`);
            continue;
          }
          if (budget > MAX_BID || budget < MIN_BID) {
            log('EVAL', `skip: budget $${budget} out of range $${MIN_BID}-$${MAX_BID}`);
            continue;
          }

          let bidPrice = budget;
          if (matches.length > 0) {
            const avgRate = matches.reduce((sum, s) => sum + parseFloat(MY_RATES[s] || '2.00'), 0) / matches.length;
            bidPrice = Math.min(budget, avgRate);
          }

          log('EVAL', `match: ${matches.length}/${Math.max(needed.length, 1)} skills | bidding $${bidPrice.toFixed(2)}`);

          if (AUTO_ACCEPT && !DRY_RUN) {
            const bid = {
              type: MessageType.BID,
              taskId: parsed.taskId,
              worker: address,
              price: bidPrice.toFixed(2),
              estimatedTime: '1h',
              skills: matches,
            };
            await board.send(encodeText(JSON.stringify(bid)));
            log('BID', `bid posted: $${bidPrice.toFixed(2)} for "${parsed.title}"`);
          } else if (DRY_RUN) {
            log('DRY-RUN', `would bid $${bidPrice.toFixed(2)} for "${parsed.title}"`);
          } else {
            log('MANUAL', `auto-bid disabled — skipping`);
          }
        }

        // Handle bid acceptance on the board
        if (parsed.type === 'bid_accept' || parsed.type === MessageType.BID_ACCEPT) {
          if (parsed.worker === address) {
            log('ACCEPTED', `bid accepted for task ${parsed.taskId} — waiting for private group assignment`);
            activeTasks.set(parsed.taskId, { status: 'accepted', title: parsed.taskId });
          }
        }

        // Handle bid rejection
        if (parsed.type === 'bid_reject' && parsed.worker === address) {
          log('REJECTED', `bid rejected for ${parsed.taskId}: ${parsed.reason || 'no reason'}`);
        }

        // Handle payment on board
        if ((parsed.type === 'payment' || parsed.type === MessageType.PAYMENT) && parsed.worker === address) {
          log('PAID', `💰 received $${parsed.amount} USDC | tx: ${parsed.txHash}`);
        }
      }
    } catch (e) {
      log('ERROR', `Board poll: ${e.message?.slice(0, 100)}`);
    }
  }

  // ─── Private group polling: pick up task assignments, execute, deliver ───

  async function pollGroups() {
    if (SCAN_ONLY) return;
    try {
      await client.conversations.syncAll();
      const allConvos = await client.conversations.list();

      for (const c of allConvos) {
        if (c.id === BOARD_ID) continue;

        await c.sync();
        const msgs = await c.messages({ limit: 20 });

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

          // Task assignment in private group
          if (parsed.type === 'task' || parsed.type === MessageType.TASK) {
            log('TASK', `📋 received: "${parsed.title}" in private group ${c.id.slice(0, 8)}`);

            activeTasks.set(parsed.id, {
              status: 'working',
              title: parsed.title,
              groupId: c.id,
            });

            if (parsed.subtasks?.length > 0) {
              const sub = parsed.subtasks[0];

              // Claim the subtask
              const claim = createClaim({ taskId: parsed.id, subtaskId: sub.id, worker: address });
              await c.send(encodeText(JSON.stringify(claim)));
              log('CLAIM', `claimed: "${sub.title}"`);

              // Simulate work
              await new Promise(r => setTimeout(r, 3000));

              // Deliver result
              const result = createResult({
                taskId: parsed.id, subtaskId: sub.id, worker: address,
                result: {
                  status: 'completed',
                  deliverable: `Completed: ${sub.title}`,
                  completedAt: new Date().toISOString(),
                },
              });
              await c.send(encodeText(JSON.stringify(result)));
              log('RESULT', `✅ delivered: "${sub.title}"`);

              activeTasks.set(parsed.id, { ...activeTasks.get(parsed.id), status: 'delivered' });
            }
          }

          // Escrow created notification
          if (parsed.type === 'escrow_created' || parsed.type === MessageType.ESCROW_CREATED) {
            log('ESCROW', `🔒 $${parsed.amount} USDC locked | tx: ${parsed.txHash?.slice(0, 16)}...`);
          }

          // Payment in private group
          if ((parsed.type === 'payment' || parsed.type === MessageType.PAYMENT) && parsed.worker === address) {
            log('PAID', `💰 $${parsed.amount} USDC released | tx: ${parsed.txHash?.slice(0, 16)}...`);
            const task = activeTasks.get(parsed.taskId);
            if (task) task.status = 'paid';
          }
        }
      }
    } catch (e) {
      log('ERROR', `Group poll: ${e.message?.slice(0, 100)}`);
    }
  }

  // ─── Run ───

  await pollBoard();
  await pollGroups();

  if (ONCE) {
    log('DONE', 'single poll complete');
    persistState();
    await agent.stop();
    process.exit(0);
  }

  const boardTimer = setInterval(pollBoard, POLL_INTERVAL);
  const groupTimer = setInterval(pollGroups, GROUP_POLL_INTERVAL);
  const stateTimer = setInterval(persistState, 30000);

  const shutdown = async () => {
    log('SHUTDOWN', 'stopping...');
    clearInterval(boardTimer);
    clearInterval(groupTimer);
    clearInterval(stateTimer);
    persistState();
    await agent.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(err => { console.error('Auto-worker failed:', err.message); process.exit(1); });
