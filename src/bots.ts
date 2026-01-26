/**
 * Bot runner functions for Feishu/Lark.
 */
import { AgentClient } from './agent/client.js';
import { Config } from './config/index.js';
import { FeishuBot, SessionManager } from './feishu/index.js';

/**
 * Run Feishu/Lark bot.
 */
export async function runFeishu(): Promise<void> {
  console.log('Initializing Feishu/Lark bot...');

  // Get agent configuration
  const agentConfig = Config.getAgentConfig();

  // Initialize agent client
  console.log(`Connecting to agent (model: ${agentConfig.model})...`);
  const agent = new AgentClient({
    apiKey: agentConfig.apiKey,
    model: agentConfig.model,
    apiBaseUrl: agentConfig.apiBaseUrl,
    workspace: Config.AGENT_WORKSPACE,
    permissionMode: 'bypassPermissions', // Auto-approve actions for bot
  });
  await agent.ensureWorkspace();
  console.log('Agent client initialized!');

  // Initialize session manager
  const sessionManager = new SessionManager();

  // Create Feishu bot
  const bot = new FeishuBot(agent, Config.FEISHU_APP_ID!, Config.FEISHU_APP_SECRET!, sessionManager);

  // Run bot (blocking)
  await bot.start();
}
