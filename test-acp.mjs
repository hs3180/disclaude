#!/usr/bin/env node
/**
 * Test: Send a prompt to Claude Code via ACP using GLM endpoint.
 * Verbose logging to capture all responses.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const ANTHROPIC_API_KEY = 'c133e2d7115d43109ecc8a3479288447.1NxJZieWms73R1tR';
const ANTHROPIC_BASE_URL = 'https://open.bigmodel.cn/api/anthropic';

const proc = spawn('claude-agent-acp', [], {
  env: { ...process.env, ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL },
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

    // Handle agent-initiated requests (auto-approve)
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

    // Log ALL messages verbosely to file
    if (msg.method === 'session/update') {
      const update = msg.params?.update;
      const type = update?.sessionUpdate;

      if (type === 'agent_message_chunk') {
        const t = update.content?.text || '';
        fullText += t;
        process.stdout.write(t);
      } else {
        // Log all other updates concisely
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
          prompt: [{ type: 'text', text: '你好，请用一句话介绍你自己。' }],
        },
      };
      console.log('[→ sending prompt]\n');
      proc.stdin.write(JSON.stringify(promptMsg) + '\n');
    } else if (msg.id === promptId && msg.result) {
      console.log(`\n\n=== Prompt completed ===`);
      console.log(`Stop reason: ${msg.result.stopReason}`);
      console.log(`Usage: ${JSON.stringify(msg.result.usage)}`);
      console.log(`\nFull text received: "${fullText}"`);
      setTimeout(() => { proc.kill(); process.exit(0); }, 1000);
    } else if (msg.result && msg.id === 0) {
      console.log('[✓ initialized]');
    } else {
      console.log('[msg]', JSON.stringify(msg).slice(0, 400));
    }
  } catch {
    console.log('[raw]', line.slice(0, 200));
  }
});

proc.stderr.on('data', (data) => {
  const text = data.toString().trim();
  if (text) console.log('[stderr]', text.slice(0, 300));
});

function send(method, params) {
  const msg = { jsonrpc: '2.0', id: requestId++, method, params };
  proc.stdin.write(JSON.stringify(msg) + '\n');
}

// Protocol sequence
setTimeout(() => {
  send('initialize', {
    protocolVersion: 1,
    clientCapabilities: {
      auth: { terminal: false },
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    },
  });

  setTimeout(() => {
    send('session/new', {
      cwd: '/Users/hs3180/Documents/disclaude',
      mcpServers: [],
      _meta: { claudeCode: { options: { permissionMode: 'bypassPermissions' } } },
    });
  }, 2000);
}, 500);

setTimeout(() => {
  console.log('\n--- Timeout ---');
  proc.kill();
  process.exit(0);
}, 60000);

proc.on('exit', (code) => console.log(`[exit: ${code}]`));
