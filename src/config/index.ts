// Re-export everything from core (including Config class)
export * from '@disclaude/core';

// Re-export channel-specific types
export * from './types.js';

// Extend Config with channel-specific methods
import { Config as BaseConfig, type RestChannelConfig } from '@disclaude/core';

/**
 * Channels configuration with REST channel support.
 * Main project extends core's ChannelsConfig with specific channel types.
 */
export interface MainChannelsConfig {
  /** REST channel configuration */
  rest?: RestChannelConfig;
  [channelName: string]: unknown;
}

/**
 * Extended configuration with channels support.
 */
export interface MainDisclaudeConfigWithChannels extends ReturnType<typeof BaseConfig.getRawConfig> {
  /** Channels configuration */
  channels?: MainChannelsConfig;
}

/**
 * Extended Config class with channel-specific methods.
 *
 * Channel configurations are specific to the main project and not included
 * in the core package to maintain separation of concerns.
 */
class ConfigExtended extends BaseConfig {
  /**
   * Get REST channel configuration from config file.
   * @see Issue #1028
   *
   * @returns REST channel configuration object
   */
  static getRestChannelConfig(): RestChannelConfig {
    const rawConfig = this.getRawConfig() as MainDisclaudeConfigWithChannels;
    return rawConfig.channels?.rest || {};
  }

  /**
   * Get channels configuration.
   *
   * @returns Channels configuration object
   */
  static getChannelsConfig(): MainChannelsConfig {
    const rawConfig = this.getRawConfig() as MainDisclaudeConfigWithChannels;
    return rawConfig.channels || {};
  }
}

export { ConfigExtended as Config };
