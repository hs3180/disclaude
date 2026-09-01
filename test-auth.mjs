#!/usr/bin/env node
/**
 * Minimal authentication test for Claude Agent SDK with GLM API.
 *
 * Usage:
 *   node test-auth.mjs              # Basic auth test (no MCP servers)
 *   node test-auth.mjs --with-mcp   # Include MCP servers like the service does
 *
 * Tests the full auth chain: config → SDK env → query → API response
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const withMcp = process.argv.includes('--with-mcp');

// 1. Load config
const configPath = resolve(__dirname, 'disclaude.config.yaml');
const config = yaml.load(readFileSync(configPath, 'utf-8'));

console.log('=== Config loaded ===');
console.log(`  provider: ${config.agent?.provider}`);
console.log(`  glm.apiKey: ${config.glm?.apiKey?.slice(0, 8)}...`);
console.log(`  glm.model: ${config.glm?.model}`);
console.log(`  glm.apiBaseUrl: ${config.glm?.apiBaseUrl}`);
console.log(`  withMcp: ${withMcp}`);
console.log();

// 2. Build env (mirroring buildSdkEnv)
const apiKey = config.glm?.apiKey;
const apiBaseUrl = config.glm?.apiBaseUrl;
const model = config.glm?.model;

if (!apiKey || !apiBaseUrl) {
  console.error('Missing apiKey or apiBaseUrl in config');
  process.exit(1);
}

const env = {
  ...process.env,
  ANTHROPIC_API_KEY: apiKey,
  ANTHROPIC_BASE_URL: apiBaseUrl,
  DEBUG_CLAUDE_AGENT_SDK: '1',
};
delete env.CLAUDECODE;

// 3. Build MCP servers (same as service)
const mcpServers = {};
if (withMcp) {
  const configuredMcpServers = config.tools?.mcpServers || {};
  for (const [name, cfg] of Object.entries(configuredMcpServers)) {
    // Mirror the service's MCP server config construction
    mcpServers[name] = {
      type: cfg.type || 'stdio',
      command: cfg.command,
      args: cfg.args || [],
      ...(cfg.env && { env: cfg.env }),
    };
    console.log(`  MCP server: ${name} → ${JSON.stringify(mcpServers[name])}`);
  }
}

// 4. Test with Claude Agent SDK (core version — same as service)
console.log('=== Testing Claude Agent SDK ===');
console.log(`  model: ${model}`);
console.log(`  env.ANTHROPIC_API_KEY: ${env.ANTHROPIC_API_KEY?.slice(0, 8)}...`);
console.log(`  env.ANTHROPIC_BASE_URL: ${env.ANTHROPIC_BASE_URL}`);
console.log(`  mcpServers: ${Object.keys(mcpServers).join(', ') || '(none)'}`);
console.log();

const coreSdkPath = resolve(__dirname, 'packages/core/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs');
const { query } = await import(coreSdkPath);

try {
  const result = query({
    prompt: 'Say "auth test OK" and nothing else.',
    options: {
      model,
      permissionMode: 'bypassPermissions',
      settingSources: ['project'],
      env,
      ...(Object.keys(mcpServers).length > 0 && { mcpServers }),
    },
  });

  let messageCount = 0;
  for await (const message of result) {
    messageCount++;
    console.log(`[msg #${messageCount}] type=${message.type}`);

    if (message.content) {
      const text = typeof message.content === 'string'
        ? message.content
        : Array.isArray(message.content)
          ? message.content.filter(b => b.type === 'text').map(b => b.text).join('')
          : JSON.stringify(message.content);

      if (text) {
        console.log(`  content: ${text.slice(0, 200)}`);
      }
    }

    if (message.type === 'result') {
      console.log();
      console.log('=== AUTH TEST PASSED ===');
      break;
    }
  }
} catch (err) {
  console.error();
  console.error('=== AUTH TEST FAILED ===');
  console.error(`  ${err.message}`);
  if (err.stack) {
    const lines = err.stack.split('\n').slice(0, 10);
    console.error(lines.join('\n'));
  }
  process.exit(1);
}
