/**
 * Configuration management for Disclaude.
 */
import dotenv from 'dotenv';
import type { Platform, AgentProvider } from '../types/config.js';

// Load environment variables
dotenv.config();

/**
 * Application configuration class with static properties.
 */
export class Config {
  // Platform selection (one of: discord, feishu, cli)
  static readonly PLATFORM: Platform = (
    process.env.PLATFORM || 'discord'
  ).toLowerCase() as Platform;

  // Discord configuration
  static readonly DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
  static readonly DISCORD_COMMAND_PREFIX = process.env.DISCORD_COMMAND_PREFIX || '!';

  // Feishu/Lark configuration
  static readonly FEISHU_APP_ID = process.env.FEISHU_APP_ID;
  static readonly FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET;

  // Claude configuration
  static readonly ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  static readonly CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-3-5-sonnet-20241022';

  // GLM configuration
  static readonly GLM_API_KEY = process.env.GLM_API_KEY;
  static readonly GLM_MODEL = process.env.GLM_MODEL || 'glm-4.7';
  static readonly GLM_API_BASE_URL =
    process.env.GLM_API_BASE_URL || 'https://open.bigmodel.cn/api/anthropic';

  // Agent configuration
  static readonly AGENT_WORKSPACE = process.env.AGENT_WORKSPACE || './workspace';

  /**
   * Get agent configuration based on available API keys.
   * Prefers GLM if configured, otherwise falls back to Anthropic.
   */
  static getAgentConfig(): {
    apiKey: string;
    model: string;
    apiBaseUrl?: string;
  } {
    // Prefer GLM if configured
    if (this.GLM_API_KEY) {
      return {
        apiKey: this.GLM_API_KEY,
        model: this.GLM_MODEL,
        apiBaseUrl: this.GLM_API_BASE_URL,
      };
    }

    // Fallback to Anthropic
    if (this.ANTHROPIC_API_KEY) {
      return {
        apiKey: this.ANTHROPIC_API_KEY,
        model: this.CLAUDE_MODEL,
      };
    }

    throw new Error('No API key configured. Set GLM_API_KEY or ANTHROPIC_API_KEY');
  }

  /**
   * Get the agent provider type.
   */
  static getAgentProvider(): AgentProvider {
    return this.GLM_API_KEY ? 'glm' : 'anthropic';
  }

  /**
   * Validate required configuration.
   */
  static validate(): boolean {
    const errors: string[] = [];

    // Validate platform
    if (this.PLATFORM !== 'discord' && this.PLATFORM !== 'feishu' && this.PLATFORM !== 'cli') {
      errors.push(`PLATFORM must be 'discord', 'feishu', or 'cli', got: ${this.PLATFORM}`);
    }

    // Validate platform-specific configuration
    if (this.PLATFORM === 'discord') {
      if (!this.DISCORD_BOT_TOKEN) {
        errors.push("DISCORD_BOT_TOKEN is required when PLATFORM=discord");
      }
    } else if (this.PLATFORM === 'feishu') {
      if (!this.FEISHU_APP_ID) {
        errors.push("FEISHU_APP_ID is required when PLATFORM=feishu");
      }
      if (!this.FEISHU_APP_SECRET) {
        errors.push("FEISHU_APP_SECRET is required when PLATFORM=feishu");
      }
    }

    // Validate agent configuration
    if (!this.GLM_API_KEY && !this.ANTHROPIC_API_KEY) {
      errors.push('At least one API key is required: GLM_API_KEY or ANTHROPIC_API_KEY');
    }

    if (errors.length > 0) {
      throw new Error('Configuration errors:\n' + errors.map((e) => `  - ${e}`).join('\n'));
    }

    return true;
  }

  /**
   * Get platform info for display.
   */
  static getPlatformInfo(): string {
    const agentConfig = this.getAgentConfig();
    const model = agentConfig.model;

    if (this.PLATFORM === 'discord') {
      return `Discord bot with ${model}`;
    } else if (this.PLATFORM === 'feishu') {
      return `Feishu/Lark bot with ${model}`;
    } else {
      return `Interactive CLI with ${model}`;
    }
  }
}
