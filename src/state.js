// state.js — Persistent state logger for the dashboard
// Agents write activity to a JSON file, which gets pushed to GitHub Pages

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(__dirname, '..', 'dashboard', 'data');
const STATE_FILE = join(STATE_DIR, 'state.json');

function loadState() {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  if (!existsSync(STATE_FILE)) {
    return {
      agents: {},
      tasks: [],
      listings: [],
      escrows: [],
      reputation: [],
      activity: [],
      stats: { totalTasks: 0, totalPaid: 0, totalClaims: 0, totalResults: 0, totalListings: 0, totalBids: 0, totalEscrows: 0, totalDisputes: 0 }
    };
  }
  const state = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
  if (!state.listings) state.listings = [];
  if (!state.escrows) state.escrows = [];
  if (!state.reputation) state.reputation = [];
  if (!state.stats.totalListings) state.stats.totalListings = 0;
  if (!state.stats.totalBids) state.stats.totalBids = 0;
  if (!state.stats.totalEscrows) state.stats.totalEscrows = 0;
  if (!state.stats.totalDisputes) state.stats.totalDisputes = 0;
  return state;
}

function saveState(state) {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export function registerAgent(address, role = 'worker') {
  const state = loadState();
  if (!state.agents[address]) {
    state.agents[address] = {
      address,
      roles: [role],
      earned: 0,
      spent: 0,
      tasksPosted: 0,
      tasksClaimed: 0,
      tasksCompleted: 0,
      firstSeen: new Date().toISOString()
    };
  } else if (!state.agents[address].roles.includes(role)) {
    state.agents[address].roles.push(role);
  }
  saveState(state);
}

export function logTask(task, requestor) {
  registerAgent(requestor, 'requestor');
  const state = loadState();
  state.tasks.push({
    id: task.id,
    title: task.title,
    budget: task.budget,
    subtasks: task.subtasks.length,
    requestor,
    status: 'open',
    createdAt: new Date().toISOString()
  });
  state.stats.totalTasks++;
  state.agents[requestor].tasksPosted++;
  state.agents[requestor].spent += parseFloat(task.budget || 0);
  state.activity.push({
    type: 'task_posted',
    agent: requestor,
    task: task.title,
    amount: task.budget,
    at: new Date().toISOString()
  });
  // Keep last 50 activity items
  if (state.activity.length > 50) state.activity = state.activity.slice(-50);
  saveState(state);
}

export function logClaim(taskId, subtaskId, worker) {
  registerAgent(worker, 'worker');
  const state = loadState();
  state.stats.totalClaims++;
  state.agents[worker].tasksClaimed++;
  const task = state.tasks.find(t => t.id === taskId);
  if (task) task.status = 'in-progress';
  state.activity.push({
    type: 'subtask_claimed',
    agent: worker,
    taskId,
    at: new Date().toISOString()
  });
  if (state.activity.length > 50) state.activity = state.activity.slice(-50);
  saveState(state);
}

export function logResult(taskId, subtaskId, worker) {
  const state = loadState();
  state.stats.totalResults++;
  state.agents[worker].tasksCompleted++;
  state.activity.push({
    type: 'result_submitted',
    agent: worker,
    taskId,
    at: new Date().toISOString()
  });
  if (state.activity.length > 50) state.activity = state.activity.slice(-50);
  saveState(state);
}

export function logPayment(taskId, worker, amount, txHash) {
  const state = loadState();
  const amt = parseFloat(amount || 0);
  state.stats.totalPaid += amt;
  if (state.agents[worker]) state.agents[worker].earned += amt;
  const task = state.tasks.find(t => t.id === taskId);
  if (task) task.status = 'paid';
  state.activity.push({
    type: 'payment_sent',
    agent: worker,
    taskId,
    amount: amt,
    txHash,
    at: new Date().toISOString()
  });
  if (state.activity.length > 50) state.activity = state.activity.slice(-50);
  saveState(state);
}

export function logListing(listing) {
  const state = loadState();
  state.stats.totalListings++;
  state.listings.push({
    taskId: listing.taskId,
    title: listing.title,
    description: listing.description || '',
    budget: listing.budget,
    skills_needed: listing.skills_needed || [],
    requestor: listing.requestor,
    bids: 0,
    status: 'open',
    createdAt: new Date().toISOString()
  });
  state.activity.push({
    type: 'listing_posted',
    agent: listing.requestor,
    task: listing.title,
    amount: listing.budget,
    at: new Date().toISOString()
  });
  if (state.activity.length > 50) state.activity = state.activity.slice(-50);
  saveState(state);
}

export function logEscrow(escrow) {
  const state = loadState();
  state.stats.totalEscrows++;
  state.escrows.push({
    taskId: escrow.taskId,
    requestor: escrow.requestor,
    worker: escrow.worker,
    amount: escrow.amount,
    deadline: escrow.deadline,
    status: escrow.status || 'active',
    txHash: escrow.txHash || null,
    createdAt: new Date().toISOString()
  });
  state.activity.push({
    type: 'escrow_created',
    agent: escrow.requestor,
    taskId: escrow.taskId,
    amount: parseFloat(escrow.amount),
    at: new Date().toISOString()
  });
  if (state.activity.length > 50) state.activity = state.activity.slice(-50);
  saveState(state);
}

export function updateEscrow(taskId, status, txHash) {
  const state = loadState();
  const escrow = state.escrows.find(e => e.taskId === taskId);
  if (escrow) {
    escrow.status = status;
    if (txHash) escrow.releaseTxHash = txHash;
    state.activity.push({
      type: `escrow_${status}`,
      agent: escrow.worker,
      taskId,
      amount: parseFloat(escrow.amount),
      at: new Date().toISOString()
    });
    if (state.activity.length > 50) state.activity = state.activity.slice(-50);
  }
  saveState(state);
}

export function logReputation(rep) {
  const state = loadState();
  const idx = state.reputation.findIndex(r => r.address.toLowerCase() === rep.address.toLowerCase());
  if (idx >= 0) {
    state.reputation[idx] = rep;
  } else {
    state.reputation.push(rep);
  }
  state.activity.push({
    type: 'reputation_updated',
    agent: rep.address,
    trustScore: rep.trustScore,
    at: new Date().toISOString()
  });
  if (state.activity.length > 50) state.activity = state.activity.slice(-50);
  saveState(state);
}

export function getState() {
  return loadState();
}
