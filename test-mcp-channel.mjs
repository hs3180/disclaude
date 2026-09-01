#!/usr/bin/env node
/**
 * Test: ACP with channel MCP server only.
 * Sends a simple prompt that triggers send_text MCP tool.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const MCP_URL = 'http://localhost:59792/mcp';
const CHAT_ID = 'oc_3d14c151cc209fd7ac1176a2b7ecbc30';

// Subprocess env: minimal, no ANTHROPIC_ vars
const env = { ...process.env };
delete env.ANTHROPIC_API_KEY;
delete env.ANTHROPIC_AUTH_TOKEN;
delete env.ANTHROPIC_BASE_URL;
delete env.ANTHROPIC_DEFAULT_OPUS_MODEL;
delete env.ANTHROPIC_DEFAULT_SONNET_MODEL;
delete env.ANTHROPIC_DEFAULT_HAIKU_MODEL;

console.log('[test] spawning claude-agent-acp with channel MCP:', MCP_URL);

const proc = spawn('claude-agent-acp', [], { env, stdio: ['pipe', 'pipe', 'pipe'] });

let requestId = 0;
let fullText = '';
let toolCalls = [];

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
      console.log('[← auto-approve permission]');
      proc.stdin.write(JSON.stringify(resp) + '\n');
      return;
    }

    if (msg.result?.sessionId) {
      const sid = msg.result.sessionId;
      const models = msg.result.models;
      console.log(`[← session] ${sid}`);
      console.log(`[← models] available=${models.availableModels.map(m=>m.modelId).join(',')} current=${models.currentModelId}`);

      // Send a prompt that should trigger send_text MCP tool
      send('session/prompt', {
        sessionId: sid,
        prompt: [{ type: 'text', text: `请使用 send_text 工具发送一条测试消息"Hello from MCP test"到 chatId ${CHAT_ID}` }],
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
      } else if (type === 'tool_call') {
        const toolName = update.toolName || 'unknown';
        toolCalls.push(toolName);
        console.log(`\n[tool_call] ${toolName}`);
      } else if (type === 'tool_call_update') {
        const state = update.state || '';
        console.log(`[tool_update] state=${state}`);
      } else {
        console.log(`\n[update: ${type}]`);
      }
      return;
    }

    if (msg.result?.stopReason) {
      console.log(`\n\n[done] stop=${msg.result.stopReason}`);
      console.log(`[tools called] ${toolCalls.join(', ') || 'none'}`);
      console.log(`[full text] "${fullText}"`);
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
proc.stderr.on('data', d => {
  const t = d.toString().trim();
  if (t) console.log('[stderr]', t.slice(0, 500));
});

setTimeout(() => send('initialize', {
  protocolVersion: 1,
  clientCapabilities: { auth: { terminal: false }, fs: { readTextFile: false, writeTextFile: false }, terminal: false },
}), 500);

setTimeout(() => {
  send('session/new', {
    cwd: '/Users/hs3180/Documents/disclaude/workspace',
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
          mcpServers: [{ type: 'http', url: MCP_URL, name: 'channel-mcp' }],
        },
      },
    },
  });
}, 2500);

setTimeout(() => { console.log('\n--- 90s timeout ---'); proc.kill(); process.exit(1); }, 90000);
proc.on('exit', code => console.log(`[exit: ${code}]`));
