/**
 * Simple test script to send "hi" to the configured API endpoint
 * using the Claude Agent SDK.
 *
 * Reads GLM config from disclaude.config.yaml and passes credentials
 * via env vars (ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL) to the SDK.
 *
 * Usage: node test-hi.mjs
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load config
const configPath = resolve(__dirname, 'disclaude.config.yaml');
const config = yaml.load(readFileSync(configPath, 'utf-8'));

const apiKey = config.glm?.apiKey;
const apiBaseUrl = config.glm?.apiBaseUrl;
const model = config.glm?.model || 'glm-5.1';

if (!apiKey) {
  console.error('Error: glm.apiKey not found in disclaude.config.yaml');
  process.exit(1);
}

console.log(`Endpoint: ${apiBaseUrl}`);
console.log(`Model:    ${model}`);
console.log('Sending "hi"...\n');

try {
  const result = query({
    prompt: 'hi, just say hello back in one sentence',
    options: {
      model,
      maxTurns: 1,
      permissionMode: 'bypassPermissions',
      tools: [],              // disable all built-in tools for a pure chat response
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: apiKey,
        ...(apiBaseUrl ? { ANTHROPIC_BASE_URL: apiBaseUrl } : {}),
        CLAUDECODE: undefined, // allow running inside another Claude Code session
      },
    },
  });

  for await (const message of result) {
    if (message.type === 'assistant') {
      // Extract text content from the BetaMessage
      const content = message.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text') {
            process.stdout.write(block.text);
          }
        }
      }
    } else if (message.type === 'result') {
      console.log('\n');
      console.log('--- Result ---');
      console.log(`Turns: ${message.num_turns}`);
      console.log(`Cost:  $${message.total_cost_usd?.toFixed(4)}`);
    }
  }

  console.log('\nDone.');
} catch (err) {
  console.error('Error:', err.message || err);
  process.exit(1);
}
