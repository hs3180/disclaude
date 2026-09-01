#!/usr/bin/env node
/**
 * Test: Send a prompt to Claude Code via ACP using LiteLLM proxy.
 *
 * Uses the same LiteLLM proxy configured in disclaude.config.yaml:
 *   glm.apiBaseUrl: "http://192.168.5.20:4000"
 *   glm.apiKey: "Silideus"
 *   glm.model: "glm-5.1"
 *
 * This verifies that claude-agent-acp works transparently with LiteLLM
 * as a drop-in Anthropic-compatible proxy.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

// LiteLLM proxy configuration (from disclaude.config.yaml)
const ANTHROPIC_API_KEY = 'Silideus';
const ANTHROPIC_AUTH_TOKEN = 'Silideus';
const ANTHROPIC_BASE_URL = 'http://192.168.5.20:4000';
const ANTHROPIC_DEFAULT_OPUS_MODEL = 'glm-5.1';

const proc = spawn('claude-agent-acp', [], {
  env: {
    ...process.env,
    ANTHROPIC_API_KEY,
    ANTHROPIC_AUTH_TOKEN,
    ANTHROPIC_BASE_URL,
    ANTHROPIC_DEFAULT_OPUS_MODEL,
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let requestId = 0;
let sessionId = null;
let promptId = null;
let fullText = '';

const rl = createInterface({ input: proc.stdout });
rl.on('line', (line) => {
  try {
    const msg = JSON.parse(line);

    // Auto-approve permission requests
    if (msg.method === 'session/request_permission') {
      const resp = {
        jsonrpc: '2.0',
        id: msg.id,
        result: { outcome: { outcome: 'selected', optionId: 'allow' } },
      };
      console.log('[→ auto-approve permission]');
      proc.stdin.write(JSON.stringify(resp) + '\n');
      return;
    }

    if (msg.method === 'session/update') {
      const update = msg.params?.update;
      const type = update?.sessionUpdate;

      if (type === 'agent_message_chunk') {
        const t = update.content?.text || '';
        fullText += t;
        process.stdout.write(t);
      } else if (type === 'agent_thought_chunk') {
        const t = update.content?.text || '';
        process.stdout.write(`\x1b[2m${t}\x1b[0m`);
      } else if (type === 'tool_call') {
        console.log(`\n[tool_call: ${update.toolName || 'unknown'}]`);
      } else if (type === 'tool_call_update') {
        const content = update.content?.text || '';
        if (content) {
          console.log(`\x1b[33m[tool_update: ${content.slice(0, 200)}]\x1b[0m`);
        }
      } else {
        console.log(`[update: ${type}]`, JSON.stringify(update).slice(0, 300));
      }
    } else if (msg.result?.sessionId) {
      sessionId = msg.result.sessionId;
      console.log(`\n=== Session: ${sessionId} ===`);
      console.log(`=== Models: ${msg.result.models?.availableModels?.map(m => m.modelId).join(', ')} ===`);
      console.log(`=== Current model: ${msg.result.models?.currentModelId} ===\n`);

      // Send prompt
      promptId = requestId;
      const promptMsg = {
        jsonrpc: '2.0',
        id: requestId++,
        method: 'session/prompt',
        params: {
          sessionId,
          prompt: [{ type: 'text', text: '你好，请用一句话介绍你自己，说明你是什么模型。' }],
        },
      };
      console.log('[→ sending prompt]\n');
      proc.stdin.write(JSON.stringify(promptMsg) + '\n');
    } else if (msg.id === promptId && msg.result) {
      console.log(`\n\n=== Prompt completed ===`);
      console.log(`Stop reason: ${msg.result.stopReason}`);
      console.log(`Usage: ${JSON.stringify(msg.result.usage)}`);
      console.log(`\nFull text length: ${fullText.length} chars`);
      setTimeout(() => { proc.kill(); process.exit(0); }, 1000);
    } else if (msg.result && msg.id === 0) {
      console.log('[✓ initialized]');
    } else if (msg.error) {
      console.log(`\x1b[31m[error: ${JSON.stringify(msg.error)}]\x1b[0m`);
    } else {
      console.log('[msg]', JSON.stringify(msg).slice(0, 400));
    }
  } catch {
    console.log('[raw]', line.slice(0, 200));
  }
});

proc.stderr.on('data', (data) => {
  const text = data.toString().trim();
  if (text) console.log(`\x1b[90m[stderr] ${text.slice(0, 300)}\x1b[0m`);
});

function send(method, params) {
  const msg = { jsonrpc: '2.0', id: requestId++, method, params };
  proc.stdin.write(JSON.stringify(msg) + '\n');
}

// Protocol sequence
setTimeout(() => {
  console.log('[→ initialize]');
  send('initialize', {
    protocolVersion: 1,
    clientCapabilities: {
      auth: { terminal: false },
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    },
  });

  setTimeout(() => {
    console.log('[→ session/new]');
    send('session/new', {
      cwd: '/Users/hs3180/Documents/disclaude',
      mcpServers: [],
      _meta: { claudeCode: { options: { permissionMode: 'bypassPermissions' } } },
    });
  }, 2000);
}, 500);

setTimeout(() => {
  console.log('\n--- Timeout (60s) ---');
  proc.kill();
  process.exit(0);
}, 60000);

proc.on('exit', (code) => console.log(`[exit: ${code}]`));
