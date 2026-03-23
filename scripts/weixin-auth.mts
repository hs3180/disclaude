import { writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { WeChatApiClient } from '../packages/primary-node/src/channels/wechat/api-client.js';
import { WeChatAuth } from '../packages/primary-node/src/channels/wechat/auth.js';

const CRED_DIR = join(homedir(), '.disclaude');
const CRED_FILE = join(CRED_DIR, 'wechat-auth.json');

async function main() {
  // Check existing credentials
  try {
    const existing = JSON.parse(require('node:fs').readFileSync(CRED_FILE, 'utf-8'));
    if (existing.token && existing.userId) {
      console.log('Existing credentials found:');
      console.log(`  Bot ID:  ${existing.botId}`);
      console.log(`  User ID: ${existing.userId}`);
      console.log(`  Saved at: ${existing.savedAt}`);
      console.log(`\nTo re-authenticate, delete: ${CRED_FILE}`);
      return;
    }
  } catch {
    // No existing credentials, proceed
  }

  const client = new WeChatApiClient({
    baseUrl: 'https://ilinkai.weixin.qq.com',
  });

  const auth = new WeChatAuth(client);
  const result = await auth.authenticate();

  if (!result.success || !result.token) {
    console.log(`Auth failed: ${result.error}`);
    process.exit(1);
  }

  // Save credentials
  mkdirSync(CRED_DIR, { recursive: true });
  const creds = {
    botId: result.botId,
    userId: result.userId,
    token: result.token,
    baseUrl: result.baseUrl,
    savedAt: new Date().toISOString(),
  };
  writeFileSync(CRED_FILE, JSON.stringify(creds, null, 2));
  console.log(`\nCredentials saved to: ${CRED_FILE}`);
  console.log(`  Bot ID:  ${creds.botId}`);
  console.log(`  User ID: ${creds.userId}`);
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
