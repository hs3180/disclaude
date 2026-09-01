#!/usr/bin/env node
/**
 * Test: ACP with NO env vars in subprocess, only session env.
 * Simulates the fix: API config via _meta.claudeCode.options.env only.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

// NO ANTHROPIC_ vars in subprocess env - clean slate
const env = { ...process.env };
delete env.ANTHROPIC_API_KEY;
delete env.ANTHROPIC_AUTH_TOKEN;
delete env.ANTHROPIC_BASE_URL;
delete env.ANTHROPIC_DEFAULT_OPUS_MODEL;

console.log('[spawning claude-agent-acp] subprocess env has NO ANTHROPIC_ vars');

const proc = spawn('claude-agent-acp', [], { env, stdio: ['pipe', 'pipe', 'pipe'] });

let requestId = 0;
let fullText = '';

function send(method, params) {
  const msg = { jsonrpc: '2.0', id: requestId++, method, params };
  console.log(`[→ ${method}] id=${msg.id}`);
  proc.stdin.write(JSON.stringify(msg) + '\n');
}

function handleLine(line) {
  try {
    const msg = JSON.parse(line);

    if (msg.method === 'session/request_permission') {
      const resp = { jsonrpc: '2.0', id: msg.id, result: { outcome: { outcome: 'selected', optionId: 'allow' } } };
      proc.stdin.write(JSON.stringify(resp) + '\n');
      return;
    }

    if (msg.result?.sessionId) {
      console.log(`[← session] ${msg.result.sessionId} models=${msg.result.models?.availableModels?.map(m=>m.modelId).join(',')} current=${msg.result.models?.currentModelId}`);

      // Send prompt with API config in session env
      send('session/prompt', {
        sessionId: msg.result.sessionId,
        prompt: [{ type: 'text', text: '你好，请用一句话介绍你自己。' }],
      });
      return;
    }

    if (msg.method === 'session/update') {
      const update = msg.params?.update;
      const type = update?.sessionUpdate;
      if (type === 'agent_message_chunk') {
        const t = update.content?.text || '';
        fullText += t;
        process.stdout.write(t);
      } else {
        console.log(`\n[update: ${type}]`);
      }
      return;
    }

    if (msg.result?.stopReason) {
      console.log(`\n\n[done] stop=${msg.result.stopReason} text="${fullText}"`);
      setTimeout(() => { proc.kill(); process.exit(0); }, 500);
      return;
    }

    if (msg.error) {
      console.log(`\n[← error] ${JSON.stringify(msg.error)}`);
      return;
    }

    console.log(`[←] ${JSON.stringify(msg).slice(0, 300)}`);
  } catch { console.log('[raw]', line.slice(0, 200)); }
}

const rl = createInterface({ input: proc.stdout });
rl.on('line', handleLine);
proc.stderr.on('data', d => { const t = d.toString().trim(); if (t) console.log('[stderr]', t.slice(0, 500)); });

setTimeout(() => send('initialize', {
  protocolVersion: 1,
  clientCapabilities: { auth: { terminal: false }, fs: { readTextFile: false, writeTextFile: false }, terminal: false },
}), 500);

setTimeout(() => {
  // Pass ALL API config through session env
  send('session/new', {
    cwd: '/Users/hs3180/Documents/disclaude',
    mcpServers: [],
    _meta: {
      claudeCode: {
        options: {
          permissionMode: 'bypassPermissions',
          model: 'glm-5.1',
          env: {
            ANTHROPIC_API_KEY: 'Silideus',
            ANTHROPIC_AUTH_TOKEN: 'Silideus',
            ANTHROPIC_BASE_URL: 'http://192.168.5.20:4000',
            ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.1',
            PATH: process.env.PATH,
          },
        },
      },
    },
  });
}, 2500);

setTimeout(() => { console.log('\n--- 45s timeout ---'); proc.kill(); process.exit(1); }, 45000);
proc.on('exit', code => console.log(`[exit: ${code}]`));
