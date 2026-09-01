#!/usr/bin/env node
/**
 * Test: ACP protocol with local GLM proxy.
 * Simplified from test-acp.mjs for quick diagnosis.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const env = {
  ...process.env,
  ANTHROPIC_BASE_URL: 'http://192.168.5.20:4000',
  ANTHROPIC_AUTH_TOKEN: 'Silideus',
  ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.1',
};

console.log('[spawning claude-agent-acp]', { env: { ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL, ANTHROPIC_DEFAULT_OPUS_MODEL: env.ANTHROPIC_DEFAULT_OPUS_MODEL } });

const proc = spawn('claude-agent-acp', [], { env, stdio: ['pipe', 'pipe', 'pipe'] });

let requestId = 0;
let sessionId = null;
let fullText = '';

function send(method, params) {
  const msg = { jsonrpc: '2.0', id: requestId++, method, params };
  const json = JSON.stringify(msg);
  console.log(`[→ ${method}] id=${msg.id}`);
  proc.stdin.write(json + '\n');
}

function handleLine(line) {
  try {
    const msg = JSON.parse(line);

    // Auto-approve permissions
    if (msg.method === 'session/request_permission') {
      const resp = { jsonrpc: '2.0', id: msg.id, result: { outcome: { outcome: 'selected', optionId: 'allow' } } };
      console.log('[← permission auto-approved]');
      proc.stdin.write(JSON.stringify(resp) + '\n');
      return;
    }

    // Initialize result
    if (msg.result?.sessionId) {
      sessionId = msg.result.sessionId;
      console.log(`[← session created] ${sessionId}`);
      console.log(`[← models] ${msg.result.models?.availableModels?.map(m => m.modelId).join(', ')}`);
      console.log(`[← current model] ${msg.result.models?.currentModelId}`);

      // Send prompt immediately
      send('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: '你好，请用一句话介绍你自己。' }],
      });
      return;
    }

    // Stream updates
    if (msg.method === 'session/update') {
      const update = msg.params?.update;
      const type = update?.sessionUpdate;

      if (type === 'agent_message_chunk') {
        const t = update.content?.text || '';
        fullText += t;
        process.stdout.write(t);
      } else if (type === 'tool_use' || type === 'tool_result') {
        console.log(`\n[${type}] ${update.toolName || ''} ${update.toolUseId || ''}`);
      } else {
        console.log(`\n[update: ${type}]`);
      }
      return;
    }

    // Prompt result
    if (msg.result?.stopReason) {
      console.log(`\n\n[prompt completed] stopReason=${msg.result.stopReason} usage=${JSON.stringify(msg.result.usage)}`);
      console.log(`\nFull text: "${fullText}"`);
      setTimeout(() => { proc.kill(); process.exit(0); }, 1000);
      return;
    }

    // Other results
    if (msg.result) {
      console.log(`[← result] id=${msg.id}`, JSON.stringify(msg.result).slice(0, 200));
    } else if (msg.error) {
      console.log(`[← error] id=${msg.id}`, JSON.stringify(msg.error));
    } else {
      console.log(`[← msg]`, JSON.stringify(msg).slice(0, 300));
    }
  } catch {
    console.log('[raw]', line.slice(0, 200));
  }
}

const rl = createInterface({ input: proc.stdout });
rl.on('line', handleLine);

proc.stderr.on('data', (d) => {
  const t = d.toString().trim();
  if (t) console.log('[stderr]', t.slice(0, 300));
});

// Protocol sequence
setTimeout(() => send('initialize', {
  protocolVersion: 1,
  clientCapabilities: { auth: { terminal: false }, fs: { readTextFile: false, writeTextFile: false }, terminal: false },
}), 500);

setTimeout(() => send('session/new', {
  cwd: '/Users/hs3180/Documents/disclaude',
  mcpServers: [],
  _meta: { claudeCode: { options: { permissionMode: 'bypassPermissions' } } },
}), 2500);

setTimeout(() => { console.log('\n--- 30s timeout ---'); proc.kill(); process.exit(1); }, 30000);
proc.on('exit', (code) => console.log(`[exit: ${code}]`));
