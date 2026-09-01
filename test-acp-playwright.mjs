#!/usr/bin/env node
/**
 * Test: ACP + Playwright MCP — 用 Claude Code 控制浏览器
 *
 * 前置条件：Chrome CDP 已在 localhost:9222 运行
 *
 * 配置来源：disclaude.config.yaml（glm.apiKey, glm.apiBaseUrl, agent.model）
 * 用法：node test-acp-playwright.mjs
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ============================================================================
// Load config from disclaude.config.yaml
// ============================================================================
const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const configPath = resolve(__dirname, 'disclaude.config.yaml');
let ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL, MODEL;

try {
  const yaml = readFileSync(configPath, 'utf-8');
  const get = (key) => {
    const m = yaml.match(new RegExp(`^\\s*${key}:\\s*["']?(.+?)["']?\\s*$`, 'm'));
    return m?.[1];
  };
  ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || get('apiKey');
  ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL || get('apiBaseUrl');
  MODEL = process.env.MODEL || get('model');
} catch {
  // fallback to env
  ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL;
  MODEL = process.env.MODEL;
}

const CDP_ENDPOINT = process.env.CDP_ENDPOINT ?? 'http://localhost:9222';
const TIMEOUT_MS = 300_000; // 5 min for multi-turn

if (!ANTHROPIC_API_KEY) {
  console.error('Error: No API key found. Set ANTHROPIC_API_KEY or configure glm.apiKey in disclaude.config.yaml');
  process.exit(1);
}

console.log(`Config: model=${MODEL}, baseUrl=${ANTHROPIC_BASE_URL}`);

// ============================================================================
// State
// ============================================================================
let requestId = 0;
let sessionId = null;
let promptId = null;
let fullText = '';
let mcpProc = null;
let acpProc = null;
let turn = 0;

const PROMPTS = [
  '打开 https://nxny.com ，等待页面完全加载后，截图并描述你看到的内容。特别注意页面上有哪些排行榜或列表。',
  '找到下载排行榜中排名第一的项目，点击进入它的详情页面。等待页面加载完成后，截图并描述详情页的内容。',
];

// ============================================================================
// Helpers
// ============================================================================
function send(proc, method, params) {
  const msg = { jsonrpc: '2.0', id: requestId++, method, params };
  proc.stdin.write(JSON.stringify(msg) + '\n');
  return msg.id;
}

function cleanup() {
  if (acpProc && !acpProc.killed) acpProc.kill();
  if (mcpProc && !mcpProc.killed) mcpProc.kill();
  process.exit(0);
}

function sendPrompt(proc) {
  fullText = '';
  const text = PROMPTS[turn];
  console.log(`[→ Turn ${turn + 1}/${PROMPTS.length}] ${text.slice(0, 80)}...\n`);
  promptId = send(proc, 'session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text }],
  });
  turn++;
}

// ============================================================================
// Step 1: Start Playwright MCP server
// ============================================================================
async function startPlaywrightMcp() {
  return new Promise((resolve, reject) => {
    console.log(`[1/3] Starting Playwright MCP (CDP: ${CDP_ENDPOINT})...`);

    mcpProc = spawn('npx', [
      '@playwright/mcp@latest',
      '--cdp-endpoint', CDP_ENDPOINT,
      '--port', '0',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    let output = '';
    const timeout = setTimeout(() => {
      reject(new Error(`Playwright MCP startup timeout. output: ${output}`));
    }, 15_000);

    const checkUrl = (data) => {
      output += data;
      const match = output.match(/Listening on (https?:\/\/localhost:\d+)/);
      if (match) {
        clearTimeout(timeout);
        // claude-agent-acp only accepts type: 'sse', use SSE endpoint
        const url = `${match[1]}/sse`;
        console.log(`[1/3] Playwright MCP ready: ${url}`);
        resolve(url);
      }
    };

    mcpProc.stdout.on('data', (data) => checkUrl(data.toString()));
    mcpProc.stderr.on('data', (data) => {
      const text = data.toString();
      checkUrl(text);
    });

    mcpProc.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    mcpProc.on('exit', (code) => {
      clearTimeout(timeout);
      if (code !== null && code !== 0) {
        reject(new Error(`Playwright MCP exited with code ${code}`));
      }
    });
  });
}

// ============================================================================
// Step 2: Start claude-agent-acp
// ============================================================================
function startAcp() {
  console.log('[2/3] Starting claude-agent-acp...');

  const env = { ...process.env, ANTHROPIC_API_KEY };
  if (ANTHROPIC_BASE_URL) env.ANTHROPIC_BASE_URL = ANTHROPIC_BASE_URL;

  acpProc = spawn('claude-agent-acp', [], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  acpProc.stderr.on('data', (data) => {
    const text = data.toString().trim();
    if (text) console.log('[acp stderr]', text.slice(0, 300));
  });

  acpProc.on('exit', (code) => {
    console.log(`[acp exit: ${code}]`);
  });

  return acpProc;
}

// ============================================================================
// Step 3: ACP protocol handshake + prompt
// ============================================================================
function runAcpProtocol(acpProc, mcpUrl) {
  console.log('[3/3] ACP handshake...');

  const rl = createInterface({ input: acpProc.stdout });
  rl.on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch {
      console.log('[raw]', line.slice(0, 200));
      return;
    }

    // Auto-approve permissions
    if (msg.method === 'session/request_permission') {
      const resp = {
        jsonrpc: '2.0',
        id: msg.id,
        result: { outcome: { outcome: 'selected', optionId: 'allow' } },
      };
      console.log('[→ auto-approve permission]');
      acpProc.stdin.write(JSON.stringify(resp) + '\n');
      return;
    }

    // Handle session/update (streaming)
    if (msg.method === 'session/update') {
      const update = msg.params?.update;
      const type = update?.sessionUpdate;

      if (type === 'agent_message_chunk') {
        const t = update.content?.text || '';
        fullText += t;
        process.stdout.write(t);
      } else if (type === 'tool_call' || type === 'tool_call_update') {
        const toolName = update.toolName || '';
        const state = update.state || '';
        console.log(`\n[tool: ${toolName}] ${state}`);
      } else {
        console.log(`\n[update: ${type}]`);
      }
      return;
    }

    // Initialize response
    if (msg.id === 0 && msg.result) {
      console.log('[✓ initialized]');
      // Create session with Playwright MCP
      const sessionOpts = {
        cwd: process.cwd(),
        mcpServers: [{
          type: 'sse',
          url: mcpUrl,
          name: 'playwright',
          command: '',
          args: [],
          env: [],
          headers: [],
        }],
        _meta: {
          claudeCode: {
            options: {
              permissionMode: 'bypassPermissions',
              mcpServers: { playwright: { type: 'sse', url: mcpUrl } },
            },
          },
        },
      };
      if (MODEL) sessionOpts._meta.claudeCode.options.model = MODEL;
      send(acpProc, 'session/new', sessionOpts);
      return;
    }

    // Session created
    if (msg.result?.sessionId) {
      sessionId = msg.result.sessionId;
      console.log(`\n=== Session: ${sessionId} ===`);
      console.log(`=== Models: ${msg.result.models?.availableModels?.map(m => m.modelId).join(', ')} ===\n`);

      sendPrompt(acpProc);
      return;
    }

    // Prompt completed
    if (msg.id === promptId && msg.result) {
      console.log(`\n\n=== Turn ${turn} completed ===`);
      console.log(`Stop reason: ${msg.result.stopReason}`);
      console.log(`Usage: ${JSON.stringify(msg.result.usage)}`);

      if (turn < PROMPTS.length) {
        console.log(`\n${'='.repeat(60)}`);
        console.log(`  Next turn in 2s...`);
        console.log(`${'='.repeat(60)}\n`);
        setTimeout(() => sendPrompt(acpProc), 2000);
      } else {
        console.log('\n=== All turns completed ===');
        setTimeout(cleanup, 1000);
      }
      return;
    }

    // Error
    if (msg.error) {
      console.log(`[error] ${JSON.stringify(msg.error)}`);
      setTimeout(cleanup, 1000);
      return;
    }

    // Other
    console.log('[msg]', JSON.stringify(msg).slice(0, 400));
  });

  // Send initialize
  setTimeout(() => {
    send(acpProc, 'initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        auth: { terminal: false },
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    });
  }, 500);
}

// ============================================================================
// Main
// ============================================================================
async function main() {
  try {
    const mcpUrl = await startPlaywrightMcp();
    const acpProc = startAcp();
    runAcpProtocol(acpProc, mcpUrl);

    // Global timeout
    setTimeout(() => {
      console.log('\n--- Timeout ---');
      cleanup();
    }, TIMEOUT_MS);
  } catch (err) {
    console.error('Fatal:', err.message);
    cleanup();
  }
}

process.on('SIGINT', () => {
  console.log('\n SIGINT, shutting down...');
  cleanup();
});

main();
