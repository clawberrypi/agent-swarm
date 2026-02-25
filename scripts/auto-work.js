#!/usr/bin/env node
// auto-work.js — Single-run board scanner + task executor for cron use
//
// Two phases:
//   1. SCAN: Check board for new listings, auto-bid on matching ones
//   2. WORK: Check private groups for accepted tasks, auto-stake, execute, deliver
//
// Usage: node scripts/auto-work.js [--config path] [--dry-run] [--scan-only] [--work-only]
//
// Designed to be called by OpenClaw cron every 10 minutes.
// State persisted in data/auto-work-state.json to avoid double-bidding and re-executing.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SKILL_DIR = join(__dirname, '..');
// Detect layout: flat clone (src/ at root) vs nested ClawHub install (skills/agent-swarm/src/)
const CLI_DIR = existsSync(join(SKILL_DIR, 'src', 'agent.js'))
  ? SKILL_DIR
  : join(SKILL_DIR, 'skills', 'agent-swarm');
const STATE_PATH = join(SKILL_DIR, 'data', 'auto-work-state.json');

// ─── Parse args ───
const args = process.argv.slice(2);
const flags = {};
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) {
    const key = args[i].slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith('--')) { flags[key] = next; i++; }
    else flags[key] = true;
  }
}

const DRY_RUN = flags['dry-run'] === true;
const SCAN_ONLY = flags['scan-only'] === true;
const WORK_ONLY = flags['work-only'] === true;
const STAKE_PERCENT = parseFloat(flags['stake-percent'] || '25') / 100; // default 25%
const CONFIG_PATH = flags.config
  ? join(process.cwd(), flags.config)
  : join(CLI_DIR, 'swarm.config.json');

// ─── State ───
function loadState() {
  try {
    if (existsSync(STATE_PATH)) return JSON.parse(readFileSync(STATE_PATH, 'utf-8'));
  } catch {}
  return {
    seenListings: [],
    bidsPlaced: [],
    tasksExecuted: [],
    tasksStaked: [],
    lastRun: null,
  };
}

function saveState(state) {
  const dir = dirname(STATE_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // Cap arrays to prevent unbounded growth
  const CAP = 200;
  for (const key of ['seenListings', 'bidsPlaced', 'tasksExecuted', 'tasksStaked']) {
    if (state[key]?.length > CAP) state[key] = state[key].slice(-CAP);
  }
  state.lastRun = new Date().toISOString();
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

// ─── Config ───
function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    console.error(`Config not found: ${CONFIG_PATH}`);
    process.exit(1);
  }
  const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
  if (config.wallet?.privateKey?.startsWith('env:')) {
    const envVar = config.wallet.privateKey.slice(4);
    config.wallet.privateKey = process.env[envVar];
    if (!config.wallet.privateKey) {
      console.error(`Environment variable ${envVar} not set.`);
      process.exit(1);
    }
  }
  return config;
}

// ─── Wallet helper ───
async function getWallet(config) {
  const { loadWallet } = await import(join(CLI_DIR, 'src', 'wallet.js'));
  return loadWallet(config.wallet.privateKey);
}

// ─── Guard check ───
async function checkGuard(config, opts) {
  const workdir = dirname(CONFIG_PATH);
  const guardPath = join(workdir, '.wallet-guard.json');
  if (!existsSync(guardPath)) return true;
  try {
    const { guardWallet } = await import(join(CLI_DIR, 'src', 'wallet-guard.js'));
    const { appendFileSync } = await import('fs');
    const wallet = await getWallet(config);
    const guarded = guardWallet(wallet, { workdir });
    const result = guarded.checkGuardrails(opts);
    const logLine = JSON.stringify({
      timestamp: new Date().toISOString(),
      ...opts,
      allowed: result.allowed,
      reason: result.reason,
    }) + '\n';
    try { appendFileSync(join(workdir, '.wallet-audit.log'), logLine); } catch {}
    if (!result.allowed) {
      console.log(`  [guard] BLOCKED: ${result.reason}`);
      return false;
    }
  } catch (err) {
    console.log(`  [guard] Error: ${err.message?.slice(0, 60)}`);
    return false;
  }
  return true;
}

// ─── Main ───
async function main() {
  const config = loadConfig();
  const state = loadState();
  const seenSet = new Set(state.seenListings);
  const bidsSet = new Set(state.bidsPlaced);
  const executedSet = new Set(state.tasksExecuted);
  const stakedSet = new Set(state.tasksStaked || []);

  if (!config.board?.id) {
    console.error('No board configured.');
    process.exit(1);
  }

  const mySkills = config.worker?.skills || [];
  const myRates = config.worker?.rates || {};
  const maxBid = parseFloat(config.worker?.maxBid || '20.00');
  const minBid = parseFloat(config.worker?.minBid || '0.50');
  const autoAccept = config.worker?.autoAccept !== false;
  const stakingAddr = config.staking?.address;

  // Connect to XMTP
  const { createSwarmAgent } = await import(join(CLI_DIR, 'src', 'agent.js'));
  const { ethers } = await import('ethers');
  const walletObj = new ethers.Wallet(config.wallet.privateKey);
  const dbName = config.xmtp?.dbPath || `.xmtp-${walletObj.address.slice(2, 10).toLowerCase()}`;
  const dbPath = join(CLI_DIR, dbName);

  const { agent, address } = await createSwarmAgent(config.wallet.privateKey, {
    env: config.xmtp?.env || 'production',
    dbPath,
  });
  await agent.start();

  const client = agent.client || agent;
  await client.conversations.syncAll();
  const conversations = await client.conversations.list();
  const board = conversations.find(c => c.id === config.board.id);

  if (!board) {
    console.error(`[auto-work] Board not found: ${config.board.id}`);
    await agent.stop();
    process.exit(1);
  }

  console.log(`[auto-work] Agent: ${address}`);
  console.log(`[auto-work] Skills: ${mySkills.join(', ')} | Budget: $${minBid}-$${maxBid} | Stake: ${STAKE_PERCENT * 100}%`);

  let totalBids = 0;
  let totalTasksExecuted = 0;
  const newBids = [];
  const completedTasks = [];

  // ═══════════════════════════════════════════
  // PHASE 1: SCAN BOARD → BID ON LISTINGS
  // ═══════════════════════════════════════════
  if (!WORK_ONLY) {
    console.log('\n── Phase 1: Scanning board for listings ──');
    await board.sync();
    const msgs = await board.messages({ limit: 50 });
    const listings = [];

    for (const m of msgs) {
      try {
        const parsed = JSON.parse(typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
        if (parsed?.type === 'listing' && !seenSet.has(parsed.taskId)) {
          listings.push(parsed);
        }
      } catch {}
    }

    console.log(`Found ${listings.length} new listing(s)`);

    for (const listing of listings) {
      seenSet.add(listing.taskId);
      state.seenListings.push(listing.taskId);

      const budget = parseFloat(listing.budget);
      const needed = listing.skills_needed || [];
      const matches = needed.length === 0 ? mySkills : needed.filter(s => mySkills.includes(s));

      console.log(`\n  [${listing.taskId}] "${listing.title}" — $${listing.budget} USDC`);
      console.log(`    Skills: ${needed.join(', ') || 'any'} | Match: ${matches.length}/${Math.max(needed.length, 1)}`);

      if (matches.length === 0 && needed.length > 0) {
        console.log('    → Skip (no skill match)');
        continue;
      }
      if (budget > maxBid || budget < minBid) {
        console.log('    → Skip (budget out of range)');
        continue;
      }
      if (bidsSet.has(listing.taskId)) {
        console.log('    → Skip (already bid)');
        continue;
      }

      let bidPrice = budget;
      if (matches.length > 0) {
        const avgRate = matches.reduce((sum, s) => sum + parseFloat(myRates[s] || '2.00'), 0) / matches.length;
        bidPrice = Math.min(budget, avgRate);
      }

      if (DRY_RUN) {
        console.log(`    → Would bid: $${bidPrice.toFixed(2)} (dry run)`);
        continue;
      }
      if (!autoAccept) {
        console.log('    → Match found, but auto-accept disabled.');
        continue;
      }

      try {
        const { encodeText } = await import('@xmtp/agent-sdk');
        const bid = {
          type: 'bid',
          taskId: listing.taskId,
          worker: address,
          price: bidPrice.toFixed(2),
          estimatedTime: '1h',
          skills: matches,
        };
        await board.send(encodeText(JSON.stringify(bid)));
        console.log(`    → Bid placed: $${bidPrice.toFixed(2)}`);
        state.bidsPlaced.push(listing.taskId);
        bidsSet.add(listing.taskId);
        newBids.push({ taskId: listing.taskId, title: listing.title, price: bidPrice.toFixed(2) });
        totalBids++;
      } catch (err) {
        console.error(`    → Bid failed: ${err.message?.slice(0, 80)}`);
      }
    }
  }

  // ═══════════════════════════════════════════
  // PHASE 2: CHECK PRIVATE GROUPS → STAKE → EXECUTE → DELIVER
  // ═══════════════════════════════════════════
  if (!SCAN_ONLY) {
    console.log('\n── Phase 2: Checking for accepted tasks ──');

    const allConvos = await client.conversations.list();
    const privateGroups = allConvos.filter(c => c.id !== config.board.id);
    let pendingTasks = [];

    for (const group of privateGroups) {
      try {
        await group.sync();
        const msgs = await group.messages({ limit: 20 });

        for (const m of msgs) {
          if (m.senderInboxId === client.inboxId) continue;
          try {
            const parsed = JSON.parse(typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
            if (parsed?.type === 'task' && parsed?.id && !executedSet.has(parsed.id)) {
              pendingTasks.push({ task: parsed, group, messageId: m.id });
            }
          } catch {}
        }
      } catch {}
    }

    console.log(`Found ${pendingTasks.length} pending task(s)`);

    for (const { task, group } of pendingTasks) {
      console.log(`\n  [${task.id}] "${task.title}" — $${task.budget || '?'} USDC`);

      // ─── Auto-Stake (25% of budget) ───
      const budget = parseFloat(task.budget || '0');
      const stakeAmount = (budget * STAKE_PERCENT).toFixed(2);

      if (stakingAddr && budget > 0 && !stakedSet.has(task.id) && parseFloat(stakeAmount) > 0) {
        console.log(`    Staking $${stakeAmount} USDC (${STAKE_PERCENT * 100}% of $${budget})...`);

        if (DRY_RUN) {
          console.log('    → Would stake (dry run)');
        } else {
          try {
            const wallet = await getWallet(config);
            const guardOk = await checkGuard(config, {
              to: stakingAddr,
              usdcAmount: stakeAmount,
              action: 'auto-work-stake',
            });
            if (!guardOk) {
              console.log('    → Stake blocked by guard. Skipping task.');
              continue;
            }

            const { depositStake } = await import(join(CLI_DIR, 'src', 'staking.js'));
            const { txHash } = await depositStake(wallet, stakingAddr, stakeAmount);
            console.log(`    → Staked: ${txHash.slice(0, 18)}...`);
            state.tasksStaked = state.tasksStaked || [];
            state.tasksStaked.push(task.id);
            stakedSet.add(task.id);
          } catch (err) {
            console.error(`    → Stake failed: ${err.message?.slice(0, 80)}`);
            // Don't skip the task if staking fails (e.g. insufficient balance)
            // The work itself is still valuable
            console.log('    → Continuing without stake');
          }
        }
      }

      // ─── Execute Task ───
      if (DRY_RUN) {
        console.log('    → Would execute (dry run)');
        continue;
      }

      console.log('    Executing...');
      try {
        const { execute } = await import(join(CLI_DIR, 'src', 'executor.js'));
        const result = await execute(task, config);

        // Submit result to the private group
        const { sendProtocolMessage } = await import(join(CLI_DIR, 'src', 'agent.js'));
        const subtaskId = task.subtasks?.[0]?.id || `${task.id}-s1`;
        await sendProtocolMessage(group, {
          type: 'result',
          taskId: task.id,
          subtaskId,
          worker: address,
          result,
        });

        // Submit deliverable hash on-chain
        try {
          const wallet = await getWallet(config);
          const registryAddr = config.verification?.registry;
          if (registryAddr) {
            const { submitDeliverable } = await import(join(CLI_DIR, 'src', 'verification.js'));
            const deliverableStr = JSON.stringify(result);
            const { txHash: dvTx, deliverableHash } = await submitDeliverable(wallet, registryAddr, task.id, deliverableStr);
            console.log(`    → Deliverable on-chain: ${deliverableHash.slice(0, 18)}...`);

            await sendProtocolMessage(group, {
              type: 'deliverable_submitted',
              taskId: task.id,
              deliverableHash,
              txHash: dvTx,
              registry: registryAddr,
            });
          }
        } catch (vErr) {
          console.log(`    → Verification skipped: ${vErr.message?.slice(0, 60)}`);
        }

        state.tasksExecuted.push(task.id);
        executedSet.add(task.id);
        totalTasksExecuted++;
        completedTasks.push({ taskId: task.id, title: task.title });
        console.log(`    → Result submitted`);
      } catch (err) {
        console.error(`    → Execution failed: ${err.message?.slice(0, 100)}`);
      }
    }
  }

  // ─── Save & Summary ───
  saveState(state);
  await agent.stop();

  console.log(`\n[auto-work] Done. ${totalBids} bid(s), ${totalTasksExecuted} task(s) executed.`);

  const summary = {
    timestamp: new Date().toISOString(),
    bidsPlaced: totalBids,
    tasksExecuted: totalTasksExecuted,
    newBids,
    completedTasks,
    dryRun: DRY_RUN,
  };
  console.log(`\n__SUMMARY__${JSON.stringify(summary)}`);
}

main().catch(err => {
  console.error(`[auto-work] Fatal: ${err.message}`);
  process.exit(1);
});
