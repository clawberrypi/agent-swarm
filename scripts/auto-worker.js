#!/usr/bin/env node
// auto-worker.js — Autonomous worker agent that sits on the bulletin board,
// polls for new listings, evaluates against its skills, and auto-bids.
// Reads from swarm.config.json (or --config <path>).

import { encodeText } from '@xmtp/agent-sdk';
import { MessageType, createClaim, createResult } from '../src/protocol.js';
import { createSwarmAgent } from '../src/agent.js';
import { createProfile, broadcastProfile } from '../src/profile.js';
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
  console.error('Run: node cli.js setup init');
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
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
const POLL_INTERVAL = 5000; // 5 seconds

const DRY_RUN = args.includes('--dry-run');
const SCAN_ONLY = args.includes('--scan-only');

const log = (label, ...args) => {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] [${label}]`, ...args);
};

const seenMessages = new Set();
const seenListings = new Set();

// Load persisted seen state
const SEEN_FILE = join(SKILL_DIR, 'data', 'auto-work-state.json');
try {
  if (fs.existsSync(SEEN_FILE)) {
    const state = JSON.parse(fs.readFileSync(SEEN_FILE, 'utf-8'));
    (state.messages || []).forEach(id => seenMessages.add(id));
    (state.listings || []).forEach(id => seenListings.add(id));
  }
} catch {}

function persistSeen() {
  try {
    fs.mkdirSync(join(SKILL_DIR, 'data'), { recursive: true });
    fs.writeFileSync(SEEN_FILE, JSON.stringify({
      messages: [...seenMessages].slice(-1000),
      listings: [...seenListings].slice(-500),
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

  // Use createSwarmAgent for deterministic XMTP db reuse
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
    log('ERROR', `Looking for: ${BOARD_ID}`);
    log('ERROR', `Found ${convos.length} conversations`);
    await agent.stop();
    process.exit(1);
  }

  // Post profile
  const profile = createProfile(address, {
    skills: MY_SKILLS,
    rates: MY_RATES,
    description: 'OpenClaw agent ready for work.',
  });
  await broadcastProfile(board, profile);
  log('BOARD', 'profile posted');

  log('READY', `polling board every ${POLL_INTERVAL / 1000}s for new listings...`);

  async function poll() {
    try {
      await board.sync();
      const msgs = await board.messages({ limit: 30 });

      for (const m of msgs) {
        const msgId = m.id;
        if (seenMessages.has(msgId)) continue;
        seenMessages.add(msgId);

        if (m.senderInboxId === client.inboxId) continue;

        let parsed;
        try {
          const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
          parsed = JSON.parse(text);
        } catch (e) { continue; }

        if (!parsed || !parsed.type) continue;

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
            persistSeen();
          } else if (DRY_RUN) {
            log('DRY-RUN', `would bid $${bidPrice.toFixed(2)} for "${parsed.title}"`);
          } else {
            log('MANUAL', `auto-bid disabled — skipping`);
          }
        }

        // Handle tasks (assigned work)
        if (!SCAN_ONLY && (parsed.type === 'task' || parsed.type === MessageType.TASK)) {
          log('TASK', `received: "${parsed.title}"`);
          if (parsed.subtasks?.length > 0) {
            const sub = parsed.subtasks[0];
            const claim = createClaim({ taskId: parsed.id, subtaskId: sub.id, worker: address });
            await board.send(encodeText(JSON.stringify(claim)));
            log('CLAIM', `claimed: "${sub.title}"`);

            await new Promise(r => setTimeout(r, 2000));
            const result = createResult({
              taskId: parsed.id, subtaskId: sub.id, worker: address,
              result: { status: 'completed', deliverable: `completed: ${sub.title}`, completedAt: new Date().toISOString() },
            });
            await board.send(encodeText(JSON.stringify(result)));
            log('RESULT', `delivered: "${sub.title}"`);
          }
        }

        // Handle payment confirmations
        if (parsed.type === 'payment' || parsed.type === MessageType.PAYMENT) {
          log('PAID', `received $${parsed.amount} USDC | tx: ${parsed.txHash}`);
        }
      }
    } catch (e) {
      log('ERROR', e.message?.slice(0, 100));
    }
  }

  // Initial poll
  await poll();

  // Continuous polling
  setInterval(poll, POLL_INTERVAL);
  // Persist seen state periodically
  setInterval(persistSeen, 30000);

  process.on('SIGINT', async () => {
    log('SHUTDOWN', 'stopping...');
    persistSeen();
    await agent.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    log('SHUTDOWN', 'stopping...');
    persistSeen();
    await agent.stop();
    process.exit(0);
  });
}

main().catch(err => { console.error('Auto-worker failed:', err.message); process.exit(1); });
