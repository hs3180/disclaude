/**
 * OAuth Provider Templates with Device Code Flow support.
 *
 * Pre-configured templates for common OAuth providers.
 * These templates include Device Code Flow endpoints where supported.
 */

import type { DeviceCodeProviderConfig } from './types.js';

/**
 * OAuth Provider Templates.
 *
 * Each template includes:
 * - Standard OAuth 2.0 endpoints
 * - Device Code Flow endpoints (where supported)
 * - Recommended scopes
 */
export const OAUTH_PROVIDER_TEMPLATES: Record<string, Partial<DeviceCodeProviderConfig>> = {
  github: {
    name: 'github',
    authUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    deviceCodeUrl: 'https://github.com/login/device/code',
    deviceTokenUrl: 'https://github.com/login/oauth/access_token',
    supportsDeviceCode: true,
    scopes: ['repo', 'user', 'read:org'],
  },

  google: {
    name: 'google',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    deviceCodeUrl: 'https://oauth2.googleapis.com/device/code',
    deviceTokenUrl: 'https://oauth2.googleapis.com/token',
    supportsDeviceCode: true,
    scopes: ['openid', 'email', 'profile'],
  },

  gitlab: {
    name: 'gitlab',
    authUrl: 'https://gitlab.com/oauth/authorize',
    tokenUrl: 'https://gitlab.com/oauth/token',
    deviceCodeUrl: 'https://gitlab.com/oauth/authorize_device',
    deviceTokenUrl: 'https://gitlab.com/oauth/token',
    supportsDeviceCode: true,
    scopes: ['api', 'read_user'],
  },

  microsoft: {
    name: 'microsoft',
    authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    deviceCodeUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/devicecode',
    deviceTokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    supportsDeviceCode: true,
    scopes: ['openid', 'email', 'profile', 'User.Read'],
  },

  notion: {
    name: 'notion',
    authUrl: 'https://api.notion.com/v1/oauth/authorize',
    tokenUrl: 'https://api.notion.com/v1/oauth/token',
    supportsDeviceCode: false, // Notion does not support Device Code Flow
    scopes: [],
  },

  slack: {
    name: 'slack',
    authUrl: 'https://slack.com/oauth/v2/authorize',
    tokenUrl: 'https://slack.com/api/oauth.v2.access',
    supportsDeviceCode: false, // Slack does not support Device Code Flow
    scopes: ['chat:write', 'channels:read'],
  },
};

/**
 * Get a provider template by name.
 *
 * @param name - Provider name (e.g., 'github', 'google')
 * @returns Provider template or undefined if not found
 */
export function getProviderTemplate(name: string): Partial<DeviceCodeProviderConfig> | undefined {
  return OAUTH_PROVIDER_TEMPLATES[name.toLowerCase()];
}

/**
 * Check if a provider supports Device Code Flow.
 *
 * @param name - Provider name
 * @returns true if Device Code Flow is supported
 */
export function supportsDeviceCode(name: string): boolean {
  const template = getProviderTemplate(name);
  return template?.supportsDeviceCode === true;
}

/**
 * Create a complete provider config from template and overrides.
 *
 * @param name - Provider name
 * @param overrides - Fields to override (clientId, clientSecret, callbackUrl, etc.)
 * @returns Complete provider configuration
 */
export function createProviderConfig(
  name: string,
  overrides: Partial<DeviceCodeProviderConfig>
): DeviceCodeProviderConfig | undefined {
  const template = getProviderTemplate(name);
  if (!template) {
    return undefined;
  }

  return {
    ...template,
    ...overrides,
    name: name.toLowerCase(),
  } as DeviceCodeProviderConfig;
}
