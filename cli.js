#!/usr/bin/env node
// cli.js — Agent Swarm CLI: board, listing, worker, escrow, task commands
// Usage: node cli.js <command> <subcommand> [--flags]

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, 'swarm.config.json');
const TASK_LOG_PATH = join(__dirname, 'tasks.json');

// ─── Config ───

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    console.error('No swarm.config.json found. Create one first (see SKILL.md).');
    process.exit(1);
  }
  const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
  // Resolve env: references
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

function loadTaskLog() {
  if (!existsSync(TASK_LOG_PATH)) return { tasks: {}, bids: {} };
  return JSON.parse(readFileSync(TASK_LOG_PATH, 'utf-8'));
}

function saveTaskLog(log) {
  writeFileSync(TASK_LOG_PATH, JSON.stringify(log, null, 2));
}

// ─── Parse Args ───

function parseArgs(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(args[i]);
    }
  }
  return { flags, positional };
}

// ─── Lazy Imports (heavy deps loaded only when needed) ───

async function getAgent(config) {
  const { createSwarmAgent } = await import('./src/agent.js');
  const { agent, address } = await createSwarmAgent(config.wallet.privateKey, {
    env: config.xmtp?.env || 'production',
    dbPath: join(__dirname, '.xmtp-cli'),
  });
  return { agent, address };
}

async function getBoard(agent, config) {
  const { joinBoard, createBoard: createBoardFn } = await import('./src/board.js');
  if (config.board?.id) {
    return await joinBoard(agent, config.board.id);
  }
  return null;
}

async function getWallet(config) {
  const { loadWallet } = await import('./src/wallet.js');
  return loadWallet(config.wallet.privateKey);
}

// ─── Commands ───

const commands = {
  // ─── Board Commands ───
  board: {
    async create(config, flags) {
      const { agent, address } = await getAgent(config);
      await agent.start();
      console.log(`Agent: ${address}`);

      const { createBoard: createBoardFn } = await import('./src/board.js');
      const board = await createBoardFn(agent);
      const boardId = board.id;
      console.log(`Board created: ${boardId}`);

      // Save to config
      config.board = config.board || {};
      config.board.id = boardId;
      writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
      console.log('Board ID saved to swarm.config.json');

      await agent.stop();
    },

    async connect(config, flags) {
      if (!config.board?.id && !flags.id) {
        console.error('No board ID. Use --id <boardId> or run: node cli.js board create');
        process.exit(1);
      }
      const boardId = flags.id || config.board.id;
      const { agent, address } = await getAgent(config);
      await agent.start();
      console.log(`Agent: ${address}`);

      const board = await getBoard(agent, { ...config, board: { id: boardId } });
      if (!board) {
        console.error('Board not found. Agent may need to be added to the group.');
        process.exit(1);
      }
      console.log(`Connected to board: ${boardId}`);

      // Save if new
      if (flags.id) {
        config.board = config.board || {};
        config.board.id = boardId;
        writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
      }

      await agent.stop();
    },

    async listings(config, flags) {
      const { agent } = await getAgent(config);
      await agent.start();
      const board = await getBoard(agent, config);
      if (!board) { console.error('No board configured.'); process.exit(1); }

      await board.sync();
      const msgs = await board.messages({ limit: 50 });
      const listings = new Map();

      for (const m of msgs) {
        try {
          const parsed = JSON.parse(typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
          if (parsed.type === 'listing') {
            listings.set(parsed.taskId, parsed);
          }
        } catch {}
      }

      if (listings.size === 0) {
        console.log('No active listings on the board.');
      } else {
        console.log(`\n${listings.size} listing(s):\n`);
        for (const [id, l] of listings) {
          console.log(`  [${id}] ${l.title}`);
          console.log(`    Budget: $${l.budget} USDC | Skills: ${(l.skills_needed || []).join(', ') || 'any'}`);
          console.log(`    Requestor: ${l.requestor}`);
          console.log('');
        }
      }
      await agent.stop();
    },

    async workers(config, flags) {
      const { agent } = await getAgent(config);
      await agent.start();
      const board = await getBoard(agent, config);
      if (!board) { console.error('No board configured.'); process.exit(1); }

      const { findWorkers } = await import('./src/profile.js');
      const skill = flags.skill || null;

      await board.sync();
      const msgs = await board.messages({ limit: 100 });
      const profiles = new Map();

      for (const m of msgs) {
        try {
          const parsed = JSON.parse(typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
          if (parsed.type === 'profile') {
            profiles.set(parsed.agent, parsed);
          }
        } catch {}
      }

      let results = [...profiles.values()];
      if (skill) {
        results = results.filter(p => p.skills?.some(s => s.toLowerCase() === skill.toLowerCase()));
      }

      if (results.length === 0) {
        console.log(skill ? `No workers with skill "${skill}".` : 'No workers on the board.');
      } else {
        console.log(`\n${results.length} worker(s):\n`);
        for (const p of results) {
          console.log(`  ${p.agent}`);
          console.log(`    Skills: ${(p.skills || []).join(', ')}`);
          console.log(`    Rates: ${JSON.stringify(p.rates || {})}`);
          console.log('');
        }
      }
      await agent.stop();
    },

    async profile(config, flags) {
      const { agent, address } = await getAgent(config);
      await agent.start();
      const board = await getBoard(agent, config);
      if (!board) { console.error('No board configured.'); process.exit(1); }

      const { createProfile, broadcastProfile } = await import('./src/profile.js');
      const profile = createProfile(address, {
        skills: config.worker?.skills || [],
        rates: config.worker?.rates || {},
        description: flags.description || 'OpenClaw agent ready for work.',
      });
      await broadcastProfile(board, profile);
      console.log(`Profile posted for ${address}`);
      console.log(`  Skills: ${profile.skills.join(', ')}`);
      await agent.stop();
    },

    async 'find-workers'(config, flags) {
      return this.workers(config, flags);
    },
  },

  // ─── Listing Commands ───
  listing: {
    async post(config, flags) {
      if (!flags.title) { console.error('--title required'); process.exit(1); }
      if (!flags.budget) { console.error('--budget required'); process.exit(1); }

      const { agent, address } = await getAgent(config);
      await agent.start();
      const board = await getBoard(agent, config);
      if (!board) { console.error('No board configured.'); process.exit(1); }

      const { postListing } = await import('./src/board.js');
      const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const skills = flags.skills ? flags.skills.split(',').map(s => s.trim()) : [];

      const listing = await postListing(board, {
        taskId,
        title: flags.title,
        description: flags.description || '',
        budget: flags.budget,
        skills_needed: skills,
        requestor: address,
        category: flags.category || 'custom',
      });

      console.log(`Listing posted: ${taskId}`);
      console.log(`  Title: ${flags.title}`);
      console.log(`  Budget: $${flags.budget} USDC`);

      // Save to task log
      const log = loadTaskLog();
      log.tasks[taskId] = {
        id: taskId,
        title: flags.title,
        description: flags.description || '',
        budget: flags.budget,
        skills: skills,
        category: flags.category || 'custom',
        requestor: address,
        status: 'open',
        createdAt: new Date().toISOString(),
      };
      saveTaskLog(log);

      await agent.stop();
    },

    async bids(config, flags) {
      if (!flags['task-id']) { console.error('--task-id required'); process.exit(1); }

      const { agent } = await getAgent(config);
      await agent.start();
      const board = await getBoard(agent, config);
      if (!board) { console.error('No board configured.'); process.exit(1); }

      await board.sync();
      const msgs = await board.messages({ limit: 100 });
      const bids = [];

      for (const m of msgs) {
        try {
          const parsed = JSON.parse(typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
          if (parsed.type === 'bid' && parsed.taskId === flags['task-id']) {
            bids.push(parsed);
          }
        } catch {}
      }

      if (bids.length === 0) {
        console.log(`No bids yet for ${flags['task-id']}.`);
      } else {
        console.log(`\n${bids.length} bid(s):\n`);
        for (const b of bids) {
          console.log(`  Worker: ${b.worker}`);
          console.log(`  Price: $${b.price} USDC | ETA: ${b.estimatedTime || 'unspecified'}`);
          console.log('');
        }
      }
      await agent.stop();
    },

    async accept(config, flags) {
      if (!flags['task-id']) { console.error('--task-id required'); process.exit(1); }
      if (!flags.worker) { console.error('--worker required'); process.exit(1); }

      const taskId = flags['task-id'];
      const workerAddr = flags.worker;
      const log = loadTaskLog();
      const task = log.tasks[taskId];
      if (!task) { console.error(`Task ${taskId} not found in local log.`); process.exit(1); }

      const amount = flags.amount || task.budget;
      const deadlineHours = parseInt(flags.deadline || config.escrow?.defaultDeadlineHours || 24);

      const { agent, address } = await getAgent(config);
      await agent.start();

      // 1. Create escrow on-chain
      console.log(`Creating escrow: $${amount} USDC for ${workerAddr}...`);
      const wallet = await getWallet(config);
      const { createEscrow, hashTaskId } = await import('./src/escrow.js');
      const escrowAddr = config.escrow?.address || '0xE2b1D96dfbd4E363888c4c4f314A473E7cA24D2f';
      const deadline = Math.floor(Date.now() / 1000) + (deadlineHours * 3600);

      const { txHash, taskIdHash } = await createEscrow(wallet, escrowAddr, {
        taskId,
        worker: workerAddr,
        amount,
        deadline,
      });
      console.log(`Escrow created: ${txHash}`);

      // 2. Create private XMTP group with worker
      const { createSwarmGroup, sendProtocolMessage } = await import('./src/agent.js');
      const group = await createSwarmGroup(agent, [workerAddr], `Task: ${task.title}`);
      console.log(`Private group created: ${group.id}`);

      // 3. Send bid_accept to board
      const board = await getBoard(agent, config);
      if (board) {
        await sendProtocolMessage(board, {
          type: 'bid_accept',
          taskId,
          worker: workerAddr,
          amount,
        });
      }

      // 4. Send task + escrow_created to private group
      await sendProtocolMessage(group, {
        type: 'task',
        id: taskId,
        title: task.title,
        description: task.description,
        budget: amount,
        category: task.category || 'custom',
        subtasks: [{ id: `${taskId}-s1`, title: task.title, description: task.description }],
      });

      await sendProtocolMessage(group, {
        type: 'escrow_created',
        taskId,
        escrowContract: escrowAddr,
        txHash,
        amount,
        deadline,
        taskIdHash,
      });

      // 5. Update local log
      task.status = 'in-progress';
      task.worker = workerAddr;
      task.groupId = group.id;
      task.escrowTx = txHash;
      task.deadline = deadline;
      saveTaskLog(log);

      console.log(`\nTask assigned to ${workerAddr}`);
      console.log(`Escrow: $${amount} USDC locked until ${new Date(deadline * 1000).toISOString()}`);
      console.log(`Monitor: node cli.js task monitor --task-id ${taskId}`);

      await agent.stop();
    },
  },

  // ─── Task Commands ───
  task: {
    async monitor(config, flags) {
      if (!flags['task-id']) { console.error('--task-id required'); process.exit(1); }

      const taskId = flags['task-id'];
      const log = loadTaskLog();
      const task = log.tasks[taskId];
      if (!task?.groupId) { console.error('Task has no group. Was it accepted?'); process.exit(1); }

      const { agent } = await getAgent(config);
      await agent.start();

      await agent.client.conversations.sync();
      const convos = await agent.client.conversations.list();
      const group = convos.find(c => c.id === task.groupId);
      if (!group) { console.error('Group not found.'); process.exit(1); }

      console.log(`Monitoring task ${taskId}: "${task.title}"`);
      console.log(`Worker: ${task.worker}`);
      console.log(`Polling for results...\n`);

      const seen = new Set();
      const poll = async () => {
        await group.sync();
        const msgs = await group.messages({ limit: 30 });
        for (const m of msgs) {
          if (seen.has(m.id)) continue;
          seen.add(m.id);
          try {
            const parsed = JSON.parse(typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
            if (parsed.type === 'progress') {
              console.log(`[PROGRESS] ${parsed.percent || '?'}% — ${parsed.message || ''}`);
            }
            if (parsed.type === 'result') {
              console.log(`[RESULT] Task completed.`);
              console.log(JSON.stringify(parsed.result, null, 2));
              task.status = 'completed';
              task.result = parsed.result;
              saveTaskLog(log);
              return true;
            }
            if (parsed.type === 'cancel') {
              console.log(`[CANCELLED] by ${parsed.cancelledBy}: ${parsed.reason || 'no reason'}`);
              task.status = 'cancelled';
              saveTaskLog(log);
              return true;
            }
          } catch {}
        }
        return false;
      };

      // Poll for up to 30 minutes
      const maxPolls = 360;
      for (let i = 0; i < maxPolls; i++) {
        const done = await poll();
        if (done) break;
        if (i % 12 === 0 && i > 0) console.log(`  still waiting... (${i * 5}s)`);
        await new Promise(r => setTimeout(r, 5000));
      }

      await agent.stop();
    },

    async list(config, flags) {
      const log = loadTaskLog();
      const tasks = Object.values(log.tasks);
      if (tasks.length === 0) {
        console.log('No tasks.');
        return;
      }
      console.log(`\n${tasks.length} task(s):\n`);
      for (const t of tasks) {
        console.log(`  [${t.id}] ${t.title}`);
        console.log(`    Status: ${t.status} | Budget: $${t.budget} | Worker: ${t.worker || 'none'}`);
        console.log('');
      }
    },
  },

  // ─── Escrow Commands ───
  escrow: {
    async status(config, flags) {
      if (!flags['task-id']) { console.error('--task-id required'); process.exit(1); }
      const { getEscrowStatus } = await import('./src/escrow.js');
      const wallet = await getWallet(config);
      const escrowAddr = config.escrow?.address || '0xE2b1D96dfbd4E363888c4c4f314A473E7cA24D2f';
      const status = await getEscrowStatus(wallet, escrowAddr, flags['task-id']);
      console.log(`Escrow for ${flags['task-id']}:`);
      console.log(`  Requestor: ${status.requestor}`);
      console.log(`  Worker: ${status.worker}`);
      console.log(`  Amount: $${status.amount} USDC`);
      console.log(`  Deadline: ${new Date(status.deadline * 1000).toISOString()}`);
      console.log(`  Status: ${status.status}`);
    },

    async release(config, flags) {
      if (!flags['task-id']) { console.error('--task-id required'); process.exit(1); }
      const { releaseEscrow } = await import('./src/escrow.js');
      const wallet = await getWallet(config);
      const escrowAddr = config.escrow?.address || '0xE2b1D96dfbd4E363888c4c4f314A473E7cA24D2f';
      console.log('Releasing escrow...');
      const { txHash } = await releaseEscrow(wallet, escrowAddr, flags['task-id']);
      console.log(`Released: ${txHash}`);

      // Notify via XMTP if we have a group
      const log = loadTaskLog();
      const task = log.tasks[flags['task-id']];
      if (task) {
        task.status = 'paid';
        task.releaseTx = txHash;
        saveTaskLog(log);
      }
    },

    async dispute(config, flags) {
      if (!flags['task-id']) { console.error('--task-id required'); process.exit(1); }
      const { disputeEscrow } = await import('./src/escrow.js');
      const wallet = await getWallet(config);
      const escrowAddr = config.escrow?.address || '0xE2b1D96dfbd4E363888c4c4f314A473E7cA24D2f';
      console.log('Filing dispute...');
      const { txHash } = await disputeEscrow(wallet, escrowAddr, flags['task-id']);
      console.log(`Disputed: ${txHash}`);
    },

    async refund(config, flags) {
      if (!flags['task-id']) { console.error('--task-id required'); process.exit(1); }
      const { default: escrowMod } = await import('./src/escrow.js');
      const wallet = await getWallet(config);
      const escrowAddr = config.escrow?.address || '0xE2b1D96dfbd4E363888c4c4f314A473E7cA24D2f';
      const { ethers } = await import('ethers');
      // Direct contract call for refund
      const abi = ['function refund(bytes32 taskId) external'];
      const contract = new ethers.Contract(escrowAddr, abi, wallet);
      const { hashTaskId } = await import('./src/escrow.js');
      console.log('Requesting refund...');
      const tx = await contract.refund(hashTaskId(flags['task-id']));
      await tx.wait();
      console.log(`Refunded: ${tx.hash}`);
    },

    async 'claim-timeout'(config, flags) {
      if (!flags['task-id']) { console.error('--task-id required'); process.exit(1); }
      const { claimDisputeTimeout } = await import('./src/escrow.js');
      const wallet = await getWallet(config);
      const escrowAddr = config.escrow?.address || '0xE2b1D96dfbd4E363888c4c4f314A473E7cA24D2f';
      console.log('Claiming dispute timeout refund...');
      const { txHash } = await claimDisputeTimeout(wallet, escrowAddr, flags['task-id']);
      console.log(`Refunded: ${txHash}`);
    },
  },

  // ─── Worker Commands ───
  worker: {
    async start(config, flags) {
      const { agent, address } = await getAgent(config);
      await agent.start();
      console.log(`Worker agent: ${address}`);

      const board = await getBoard(agent, config);
      if (!board) { console.error('No board configured.'); process.exit(1); }

      // Post profile
      const { createProfile, broadcastProfile } = await import('./src/profile.js');
      const profile = createProfile(address, {
        skills: config.worker?.skills || [],
        rates: config.worker?.rates || {},
        description: 'OpenClaw agent ready for work.',
      });
      await broadcastProfile(board, profile);
      console.log(`Profile posted. Skills: ${profile.skills.join(', ')}`);

      const { encodeText } = await import('@xmtp/agent-sdk');
      const { MessageType } = await import('./src/protocol.js');
      const seenMessages = new Set();
      const seenListings = new Set();

      const maxBid = parseFloat(config.worker?.maxBid || '20.00');
      const minBid = parseFloat(config.worker?.minBid || '0.50');
      const mySkills = config.worker?.skills || [];
      const myRates = config.worker?.rates || {};
      const autoAccept = config.worker?.autoAccept || false;

      console.log(`\nListening for listings (auto-bid: ${autoAccept})...\n`);

      const poll = async () => {
        try {
          await board.sync();
          const msgs = await board.messages({ limit: 30 });

          for (const m of msgs) {
            if (seenMessages.has(m.id)) continue;
            seenMessages.add(m.id);
            if (m.senderInboxId === agent.client.inboxId) continue;

            let parsed;
            try {
              parsed = JSON.parse(typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
            } catch { continue; }
            if (!parsed?.type) continue;

            if (parsed.type === 'listing') {
              if (seenListings.has(parsed.taskId)) continue;
              seenListings.add(parsed.taskId);

              const budget = parseFloat(parsed.budget);
              const needed = parsed.skills_needed || [];
              const matches = needed.length === 0 ? mySkills : needed.filter(s => mySkills.includes(s));

              console.log(`[LISTING] "${parsed.title}" — $${parsed.budget} USDC`);
              console.log(`  Skills needed: ${needed.join(', ') || 'any'}`);
              console.log(`  Match: ${matches.length}/${Math.max(needed.length, 1)}`);

              if (matches.length === 0 && needed.length > 0) {
                console.log('  → Skipping (no skill match)\n');
                continue;
              }
              if (budget > maxBid || budget < minBid) {
                console.log(`  → Skipping (budget out of range $${minBid}-$${maxBid})\n`);
                continue;
              }

              let bidPrice = budget;
              if (matches.length > 0) {
                const avgRate = matches.reduce((sum, s) => sum + parseFloat(myRates[s] || '2.00'), 0) / matches.length;
                bidPrice = Math.min(budget, avgRate);
              }

              if (autoAccept) {
                const bid = {
                  type: MessageType.BID,
                  taskId: parsed.taskId,
                  worker: address,
                  price: bidPrice.toFixed(2),
                  estimatedTime: '1h',
                  skills: matches,
                };
                await board.send(encodeText(JSON.stringify(bid)));
                console.log(`  → Auto-bid: $${bidPrice.toFixed(2)}\n`);
              } else {
                console.log(`  → Waiting for manual bid (run: node cli.js board bid --task-id ${parsed.taskId} --price ${bidPrice.toFixed(2)})\n`);
              }
            }

            // Handle task assignments in private groups
            if (parsed.type === 'task') {
              console.log(`[TASK RECEIVED] "${parsed.title}"`);
              console.log(`  Executing...`);
              const { execute } = await import('./src/executor.js');
              try {
                const result = await execute(parsed, config);
                // Send result back
                const { sendProtocolMessage } = await import('./src/agent.js');
                // Find the conversation this came from
                await agent.client.conversations.sync();
                const convos = await agent.client.conversations.list();
                // Send to all recent convos (we'll find the right one)
                for (const c of convos) {
                  if (c.id === board.id) continue;
                  try {
                    await c.sync();
                    const recentMsgs = await c.messages({ limit: 5 });
                    const hasTask = recentMsgs.some(rm => {
                      try {
                        const p = JSON.parse(typeof rm.content === 'string' ? rm.content : JSON.stringify(rm.content));
                        return p.type === 'task' && p.id === parsed.id;
                      } catch { return false; }
                    });
                    if (hasTask) {
                      await sendProtocolMessage(c, {
                        type: 'result',
                        taskId: parsed.id,
                        subtaskId: parsed.subtasks?.[0]?.id || `${parsed.id}-s1`,
                        worker: address,
                        result,
                      });
                      console.log(`  → Result submitted to group ${c.id}\n`);
                      break;
                    }
                  } catch {}
                }
              } catch (err) {
                console.error(`  → Execution failed: ${err.message}\n`);
              }
            }
          }
        } catch (e) {
          console.error(`[ERROR] ${e.message?.slice(0, 100)}`);
        }
      };

      // Also poll private groups for tasks
      const pollPrivateGroups = async () => {
        try {
          await agent.client.conversations.sync();
          const convos = await agent.client.conversations.list();
          for (const c of convos) {
            if (c.id === board.id) continue;
            await c.sync();
            const msgs = await c.messages({ limit: 10 });
            for (const m of msgs) {
              if (seenMessages.has(m.id)) continue;
              seenMessages.add(m.id);
              if (m.senderInboxId === agent.client.inboxId) continue;
              try {
                const parsed = JSON.parse(typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
                if (parsed?.type === 'task') {
                  console.log(`[TASK from private group] "${parsed.title}"`);
                  const { execute } = await import('./src/executor.js');
                  const result = await execute(parsed, config);
                  const { sendProtocolMessage } = await import('./src/agent.js');
                  await sendProtocolMessage(c, {
                    type: 'result',
                    taskId: parsed.id,
                    subtaskId: parsed.subtasks?.[0]?.id || `${parsed.id}-s1`,
                    worker: address,
                    result,
                  });
                  console.log(`  → Result submitted\n`);
                }
              } catch {}
            }
          }
        } catch {}
      };

      // Poll loop
      await poll();
      setInterval(poll, 5000);
      setInterval(pollPrivateGroups, 10000);

      process.on('SIGINT', async () => {
        console.log('\nShutting down...');
        await agent.stop();
        process.exit(0);
      });

      // Keep alive
      await new Promise(() => {});
    },
  },
};

// ─── Main ───

const args = process.argv.slice(2);
const { positional, flags } = parseArgs(args);
const [command, subcommand] = positional;

if (!command || !subcommand) {
  console.log(`
Agent Swarm CLI

Usage: node cli.js <command> <subcommand> [--flags]

Commands:
  board create                    Create a new bulletin board
  board connect --id <boardId>    Connect to existing board
  board listings                  List active listings
  board workers [--skill <s>]     List worker profiles
  board profile                   Post your worker profile
  board find-workers --skill <s>  Find workers with a skill

  listing post --title <t> --budget <b> [--skills <s1,s2>] [--category <c>]
  listing bids --task-id <id>     View bids on a listing
  listing accept --task-id <id> --worker <addr> [--amount <a>] [--deadline <h>]

  task monitor --task-id <id>     Monitor a task for results
  task list                       List all local tasks

  worker start                    Start worker daemon (find work, execute, deliver)

  escrow status --task-id <id>    Check escrow status
  escrow release --task-id <id>   Release funds to worker
  escrow dispute --task-id <id>   File a dispute
  escrow refund --task-id <id>    Refund after deadline
  escrow claim-timeout --task-id <id>  Claim refund after dispute timeout
  `);
  process.exit(0);
}

if (!commands[command]?.[subcommand]) {
  console.error(`Unknown command: ${command} ${subcommand}`);
  process.exit(1);
}

const config = loadConfig();
commands[command][subcommand](config, flags).catch(err => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
