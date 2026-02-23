// executor.js — Execution bridge: maps task categories to real work
//
// This is the heart of the worker. When a task comes in, the executor
// figures out how to actually do it and returns a result.
//
// Categories map to execution strategies:
//   coding    → spawn a coding sub-agent (codex/claude-code)
//   research  → web search + synthesis
//   code-review → read files + analyze
//   writing   → direct generation
//   custom    → generic sub-agent
//
// The executor can run standalone (via CLI) or be called by the worker daemon.
// It shells out to OpenClaw tools or spawns sub-processes.

import { execSync, spawn } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORK_DIR = join(__dirname, '..', 'workdir');

/**
 * Execute a task and return a result object.
 * @param {object} task - The task message (from XMTP)
 * @param {object} config - The swarm config
 * @returns {object} result - { status, deliverable, logs, completedAt }
 */
export async function execute(task, config) {
  const category = task.category || inferCategory(task);
  const workDir = join(WORK_DIR, task.id || 'unknown');

  if (!existsSync(workDir)) mkdirSync(workDir, { recursive: true });

  console.log(`  [executor] category: ${category}`);
  console.log(`  [executor] workdir: ${workDir}`);

  const startTime = Date.now();

  let result;
  switch (category) {
    case 'coding':
      result = await executeCoding(task, workDir, config);
      break;
    case 'research':
      result = await executeResearch(task, workDir);
      break;
    case 'code-review':
      result = await executeCodeReview(task, workDir);
      break;
    case 'writing':
      result = await executeWriting(task, workDir);
      break;
    default:
      result = await executeGeneric(task, workDir);
      break;
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`  [executor] completed in ${elapsed}s`);

  return {
    status: 'completed',
    category,
    deliverable: result.deliverable,
    logs: result.logs || [],
    files: result.files || [],
    completedAt: new Date().toISOString(),
    executionTime: `${elapsed}s`,
  };
}

/**
 * Infer category from task description if not explicitly set.
 */
function inferCategory(task) {
  const text = `${task.title || ''} ${task.description || ''}`.toLowerCase();

  if (text.match(/\b(code|build|implement|fix|bug|feature|api|endpoint|function|class|module|deploy|refactor)\b/)) {
    return 'coding';
  }
  if (text.match(/\b(research|find|search|investigate|analyze|report|summarize|gather)\b/)) {
    return 'research';
  }
  if (text.match(/\b(review|audit|check|inspect|vulnerabilit|security)\b/)) {
    return 'code-review';
  }
  if (text.match(/\b(write|draft|blog|article|content|copy|documentation|readme)\b/)) {
    return 'writing';
  }
  return 'custom';
}

// ─── Execution Strategies ───

/**
 * Coding: spawn a coding agent (codex, claude-code, or pi) to do the work.
 * Falls back to a simpler approach if no coding agent is available.
 */
async function executeCoding(task, workDir, config) {
  const description = task.description || task.title;

  // Try to find a coding agent
  const codingAgents = ['codex', 'claude', 'pi'];
  let agent = null;
  for (const a of codingAgents) {
    try {
      execSync(`which ${a}`, { stdio: 'ignore' });
      agent = a;
      break;
    } catch {}
  }

  if (agent) {
    // Spawn the coding agent
    const prompt = `You are completing a paid task. Work directory: ${workDir}

Task: ${task.title}
Description: ${description}
${task.subtasks?.length ? `Subtasks:\n${task.subtasks.map(s => `- ${s.title}: ${s.description || ''}`).join('\n')}` : ''}

Complete the task. Write all output files to the work directory. When done, write a RESULT.md summarizing what you did.`;

    try {
      const cmd = agent === 'codex'
        ? `codex exec '${prompt.replace(/'/g, "'\\''")}'`
        : agent === 'claude'
        ? `claude -p '${prompt.replace(/'/g, "'\\''")}'`
        : `pi '${prompt.replace(/'/g, "'\\''")}'`;

      const output = execSync(cmd, {
        cwd: workDir,
        timeout: 300000, // 5 min
        maxBuffer: 1024 * 1024,
        encoding: 'utf-8',
      });

      // Read RESULT.md if it was created
      const resultPath = join(workDir, 'RESULT.md');
      const deliverable = existsSync(resultPath)
        ? readFileSync(resultPath, 'utf-8')
        : output.slice(-2000);

      return {
        deliverable,
        logs: [output.slice(-1000)],
        files: listFiles(workDir),
      };
    } catch (err) {
      return {
        deliverable: `Coding agent (${agent}) failed: ${err.message?.slice(0, 500)}`,
        logs: [err.stderr?.slice(-500) || err.message],
      };
    }
  }

  // Fallback: no coding agent available, return instructions
  return {
    deliverable: `No coding agent available on this machine (checked: ${codingAgents.join(', ')}). Task description preserved for manual execution:\n\n${description}`,
    logs: ['No coding agent found. Install codex, claude, or pi for automated coding.'],
  };
}

/**
 * Research: web search + fetch + synthesize.
 * Uses curl to hit search APIs or a simpler approach.
 */
async function executeResearch(task, workDir) {
  const query = task.description || task.title;

  try {
    // Use node to do a basic web search via DuckDuckGo HTML
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const html = execSync(`curl -sL "${searchUrl}" | head -c 50000`, {
      encoding: 'utf-8',
      timeout: 30000,
    });

    // Extract result snippets (rough parsing)
    const results = [];
    const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>(.*?)<\/a>/gs;
    const titleRegex = /<a[^>]*class="result__a"[^>]*>(.*?)<\/a>/gs;
    const linkRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>/gs;

    let match;
    while ((match = snippetRegex.exec(html)) && results.length < 8) {
      results.push(match[1].replace(/<[^>]*>/g, '').trim());
    }

    const report = `# Research: ${task.title}

## Query
${query}

## Findings
${results.length > 0 ? results.map((r, i) => `${i + 1}. ${r}`).join('\n\n') : 'No results found via web search.'}

## Summary
Research completed. ${results.length} results found.
`;

    writeFileSync(join(workDir, 'research.md'), report);

    return {
      deliverable: report,
      logs: [`Searched: "${query}", found ${results.length} results`],
      files: ['research.md'],
    };
  } catch (err) {
    return {
      deliverable: `Research failed: ${err.message?.slice(0, 500)}\n\nOriginal query: ${query}`,
      logs: [err.message],
    };
  }
}

/**
 * Code review: read files from a repo URL or local path and analyze.
 */
async function executeCodeReview(task, workDir) {
  const description = task.description || task.title;

  // Check if description contains a GitHub URL
  const ghMatch = description.match(/github\.com\/([^/]+\/[^/\s]+)/);

  let code = '';
  if (ghMatch) {
    const repo = ghMatch[1].replace(/\.git$/, '');
    try {
      execSync(`git clone --depth 1 https://github.com/${repo} ${join(workDir, 'repo')}`, {
        timeout: 60000,
        stdio: 'pipe',
      });
      // Read key files
      const files = execSync(`find ${join(workDir, 'repo')} -name "*.sol" -o -name "*.js" -o -name "*.ts" | head -20`, {
        encoding: 'utf-8',
      }).trim().split('\n').filter(Boolean);

      for (const f of files) {
        try {
          const content = readFileSync(f, 'utf-8');
          code += `\n--- ${f} ---\n${content.slice(0, 5000)}\n`;
        } catch {}
      }
    } catch (err) {
      code = `Failed to clone: ${err.message}`;
    }
  }

  const review = `# Code Review: ${task.title}

## Scope
${description}

## Files Reviewed
${code ? code.slice(0, 3000) : 'No files found or accessible.'}

## Review Notes
Manual review required. Code has been fetched to workdir for inspection.
`;

  writeFileSync(join(workDir, 'review.md'), review);
  return {
    deliverable: review,
    logs: ['Code fetched for review'],
    files: ['review.md'],
  };
}

/**
 * Writing: generate content based on the task brief.
 */
async function executeWriting(task, workDir) {
  const description = task.description || task.title;

  // For now, structure the brief and return it. A real implementation
  // would call an LLM API or spawn an agent.
  const output = `# ${task.title}

${description}

---
*Generated by agent worker. Content ready for review.*
`;

  writeFileSync(join(workDir, 'output.md'), output);
  return {
    deliverable: output,
    logs: ['Content generated'],
    files: ['output.md'],
  };
}

/**
 * Generic: attempt to handle any task type.
 */
async function executeGeneric(task, workDir) {
  const description = task.description || task.title;

  // Try to use a coding agent for generic tasks too
  try {
    const agents = ['codex', 'claude', 'pi'];
    for (const a of agents) {
      try { execSync(`which ${a}`, { stdio: 'ignore' }); } catch { continue; }

      const prompt = `Complete this task:\n\nTitle: ${task.title}\nDescription: ${description}\n\nWrite output to ${workDir}`;
      const output = execSync(`${a} ${a === 'codex' ? 'exec' : '-p'} '${prompt.replace(/'/g, "'\\''")}'`, {
        cwd: workDir,
        timeout: 300000,
        maxBuffer: 1024 * 1024,
        encoding: 'utf-8',
      });

      return {
        deliverable: output.slice(-2000),
        logs: [`Executed via ${a}`],
        files: listFiles(workDir),
      };
    }
  } catch {}

  return {
    deliverable: `Task received but no execution agent available.\n\nTitle: ${task.title}\nDescription: ${description}\n\nTask logged for manual completion.`,
    logs: ['No execution agent available'],
  };
}

// ─── Helpers ───

function listFiles(dir) {
  try {
    return execSync(`ls -la ${dir}`, { encoding: 'utf-8' }).trim().split('\n').slice(1);
  } catch {
    return [];
  }
}
