/**
 * Bot runner functions for Feishu/Lark.
 */
import { Config } from './config/index.js';
import { FeishuBot } from './feishu/index.js';

/**
 * Run Feishu/Lark bot.
 */
export async function runFeishu(): Promise<void> {
  console.log('Initializing Feishu/Lark bot...');

  // Increase max listeners to prevent MaxListenersExceededWarning
  // The bot may spawn multiple subprocesses through Agent tools
  process.setMaxListeners(20);

  // Create Feishu bot
  const bot = new FeishuBot(Config.FEISHU_APP_ID!, Config.FEISHU_APP_SECRET!);

  // Run bot (blocking)
  await bot.start();
}
