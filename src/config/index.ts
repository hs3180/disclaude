/**
 * Configuration management for Disclaude.
 */
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

/**
 * Application configuration class with static properties.
 */
export class Config {
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
}
