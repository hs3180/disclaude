#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';

const MCP_URL = 'http://localhost:59792/mcp';
const CHAT_ID = 'oc_3d14c151cc209fd7ac1176a2b7ecbc30';
const HISTORY_FILE = '/Users/hs3180/Documents/disclaude/workspace/schedules/.temp-chats/oc_3d14c151cc209fd7ac1176a2b7ecbc30.json';

let chatHistory = '';
try { chatHistory = readFileSync(HISTORY_FILE, 'utf-8'); } catch { console.log('[warn] no chat history file'); }

const env = { ...process.env };
delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_AUTH_TOKEN;
delete env.ANTHROPIC_BASE_URL; delete env.ANTHROPIC_DEFAULT_OPUS_MODEL;
delete env.ANTHROPIC_DEFAULT_SONNET_MODEL; delete env.ANTHROPIC_DEFAULT_HAIKU_MODEL;

console.log(`[test] with chat history: ${chatHistory.length} chars`);
const proc = spawn('claude-agent-acp', [], { env, stdio: ['pipe', 'pipe', 'pipe'] });

let requestId = 0, fullText = '', toolCalls = [], startTime = Date.now();
const elapsed = () => ((Date.now() - startTime) / 1000).toFixed(1) + 's';

function send(method, params) {
  const msg = { jsonrpc: '2.0', id: requestId++, method, params };
  console.log(`[→ ${method}] id=${msg.id} @${elapsed()}`);
  proc.stdin.write(JSON.stringify(msg) + '\n');
}

function handleLine(line) {
  try {
    const msg = JSON.parse(line);
    if (msg.method === 'session/request_permission') {
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { outcome: { outcome: 'selected', optionId: 'allow' } } }) + '\n');
      return;
    }
    if (msg.result?.sessionId) {
      console.log(`[← session] @${elapsed()}`);
      // Build prompt with chat history prefix (simulates production)
      const prompt = `以下是我们的对话历史：\n${chatHistory.slice(0, 4000)}\n\n---\n用户说：你好\n请回复用户。`;
      console.log(`[prompt] ${prompt.length} chars`);
      send('session/prompt', {
        sessionId: msg.result.sessionId,
        prompt: [{ type: 'text', text: prompt }],
      });
      return;
    }
    if (msg.method === 'session/update') {
      const u = msg.params?.update, t = u?.sessionUpdate;
      if (t === 'agent_message_chunk') { fullText += u.content?.text || ''; process.stdout.write(u.content?.text || ''); }
      else if (t === 'tool_call') { toolCalls.push(u.toolName); console.log(`\n[tool_call] @${elapsed()}`); }
      else if (t === 'tool_call_update' && u.content?.text) { console.log(`[tool_result] @${elapsed()}`); }
      else if (t === 'agent_thought_chunk') { /* silent */ }
      else if (t !== 'available_commands_update') { console.log(`[${t}] @${elapsed()}`); }
      return;
    }
    if (msg.result?.stopReason) {
      console.log(`\n[done] stop=${msg.result.stopReason} tools=${toolCalls.join(',')} @${elapsed()}`);
      setTimeout(() => { proc.kill(); process.exit(0); }, 500);
      return;
    }
    if (msg.error) { console.log(`[error] ${JSON.stringify(msg.error).slice(0, 500)} @${elapsed()}`); return; }
  } catch {}
}

createInterface({ input: proc.stdout }).on('line', handleLine);
proc.stderr.on('data', d => { const t = d.toString().trim(); if (t) console.log(`[stderr] ${t.slice(0, 500)}`); });

setTimeout(() => send('initialize', {
  protocolVersion: 1,
  clientCapabilities: { auth: { terminal: false }, fs: { readTextFile: false, writeTextFile: false }, terminal: false },
}), 500);

setTimeout(() => send('session/new', {
  cwd: '/Users/hs3180/Documents/disclaude/workspace',
  mcpServers: [],
  _meta: { claudeCode: { options: {
    permissionMode: 'bypassPermissions', model: 'glm-5.1',
    env: { ANTHROPIC_API_KEY: 'Silideus', ANTHROPIC_AUTH_TOKEN: 'Silideus', ANTHROPIC_BASE_URL: 'http://192.168.5.20:4000', ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.1', PATH: process.env.PATH },
    mcpServers: [
      { type: 'http', url: MCP_URL, name: 'channel-mcp' },
      { type: 'sse', url: 'https://mcp.amap.com/sse?key=92807adfa7110c73e47d03e086ad990c', name: 'amap-maps' },
      { type: 'sse', url: 'https://mcp.exa.ai/mcp?tools=web_search_advanced_exa', name: 'exa' },
    ],
  } } },
}), 2500);

setTimeout(() => { console.log(`\n--- 120s timeout @${elapsed()} ---`); proc.kill(); process.exit(1); }, 120000);
proc.on('exit', code => console.log(`[exit: ${code}]`));
