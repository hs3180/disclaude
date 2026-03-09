/**
 * GitHub App JWT Authentication Module.
 *
 * Implements GitHub App authentication using JWT (JSON Web Token) and
 * Installation Access Tokens. This allows the application to act as
 * a bot identity (e.g., disclaude-app[bot]) instead of a personal account.
 *
 * @see https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app
 */

import * as crypto from 'crypto';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('GitHubAppAuth');

/**
 * GitHub App configuration.
 */
export interface GitHubAppConfig {
  /** GitHub App ID (found in app settings) */
  appId: string;
  /** GitHub App Private Key (PEM format) */
  privateKey: string;
  /** GitHub App Installation ID (optional, auto-detected if not provided) */
  installationId?: string;
}

/**
 * Cached installation access token.
 */
interface CachedToken {
  token: string;
  expiresAt: number;
}

/**
 * GitHub App Installation details.
 */
interface Installation {
  id: number;
  account: {
    login: string;
  };
}

/**
 * GitHub App Access Token response.
 */
interface AccessTokenResponse {
  token: string;
  expires_at: string;
}

/**
 * GitHub App Authentication Manager.
 *
 * Handles JWT generation and Installation Access Token management
 * for GitHub App authentication.
 *
 * @example
 * ```typescript
 * const auth = new GitHubAppAuth({
 *   appId: '123456',
 *   privateKey: process.env.GITHUB_APP_PRIVATE_KEY!,
 *   installationId: '98765432'
 * });
 *
 * const token = await auth.getInstallationToken();
 * // Use token for GitHub API calls
 * ```
 */
export class GitHubAppAuth {
  private readonly config: GitHubAppConfig;
  private cachedToken: CachedToken | null = null;

  constructor(config: GitHubAppConfig) {
    this.config = config;

    // Validate required config
    if (!config.appId) {
      throw new Error('GitHub App ID is required');
    }
    if (!config.privateKey) {
      throw new Error('GitHub App Private Key is required');
    }
  }

  /**
   * Generate a JWT (JSON Web Token) for GitHub App authentication.
   *
   * The JWT is used to authenticate as the GitHub App itself,
   * not as an installation. It's valid for 10 minutes.
   *
   * @returns JWT string
   */
  private generateJWT(): string {
    const now = Math.floor(Date.now() / 1000);

    // JWT payload
    const payload = {
      iat: now - 60, // Issued at (1 minute in the past for clock drift)
      exp: now + 10 * 60, // Expires at (10 minutes in the future)
      iss: this.config.appId, // Issuer (App ID)
    };

    // Encode payload and header
    const header = Buffer.from(
      JSON.stringify({ alg: 'RS256', typ: 'JWT' })
    ).toString('base64url');
    const payloadEncoded = Buffer.from(JSON.stringify(payload)).toString(
      'base64url'
    );

    // Create signature
    const signatureInput = `${header}.${payloadEncoded}`;
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(signatureInput);
    const signature = sign
      .sign(this.normalizePrivateKey(this.config.privateKey))
      .toString('base64url');

    const jwt = `${signatureInput}.${signature}`;
    logger.debug({ appId: this.config.appId }, 'JWT generated');

    return jwt;
  }

  /**
   * Normalize private key format (handle escaped newlines from env vars).
   */
  private normalizePrivateKey(key: string): string {
    // Handle escaped newlines from environment variables
    return key.replace(/\\n/g, '\n');
  }

  /**
   * Get the installation ID for the GitHub App.
   *
   * If installation ID is not configured, this method will
   * fetch it from the GitHub API.
   *
   * @param jwt - JWT for authentication
   * @returns Installation ID
   */
  private async getInstallationId(jwt: string): Promise<string> {
    if (this.config.installationId) {
      return this.config.installationId;
    }

    logger.debug('Fetching installation ID from GitHub API');

    const response = await fetch('https://api.github.com/app/installations', {
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'disclaude',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Failed to fetch installations: ${response.status} - ${text}`
      );
    }

    const installations = (await response.json()) as Installation[];

    if (!installations || installations.length === 0) {
      throw new Error(
        'No installations found for this GitHub App. Please install the app on a repository.'
      );
    }

    // Use the first installation (or could be filtered by account)
    const installation = installations[0];
    logger.info(
      { installationId: installation.id, account: installation.account.login },
      'Installation found'
    );

    return String(installation.id);
  }

  /**
   * Get an Installation Access Token.
   *
   * This token is used to make API calls on behalf of the GitHub App
   * installation. Tokens are cached and automatically refreshed.
   *
   * @returns Installation Access Token
   */
  async getInstallationToken(): Promise<string> {
    // Check cache (refresh 5 minutes before expiration)
    const refreshBuffer = 5 * 60 * 1000; // 5 minutes
    if (this.cachedToken && this.cachedToken.expiresAt > Date.now() + refreshBuffer) {
      logger.debug('Using cached installation token');
      return this.cachedToken.token;
    }

    logger.info('Fetching new installation access token');

    const jwt = this.generateJWT();
    const installationId = await this.getInstallationId(jwt);

    const response = await fetch(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'disclaude',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      }
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Failed to get installation token: ${response.status} - ${text}`
      );
    }

    const data = (await response.json()) as AccessTokenResponse;

    this.cachedToken = {
      token: data.token,
      expiresAt: new Date(data.expires_at).getTime(),
    };

    logger.info(
      { expiresAt: new Date(data.expires_at).toISOString() },
      'Installation token obtained'
    );

    return data.token;
  }

  /**
   * Clear the cached token.
   *
   * Call this if the token becomes invalid or you want to force a refresh.
   */
  clearCache(): void {
    this.cachedToken = null;
    logger.debug('Token cache cleared');
  }
}

/**
 * Singleton instance for convenience.
 */
let githubAppAuthInstance: GitHubAppAuth | null = null;

/**
 * Get or create the global GitHub App Auth instance.
 *
 * Uses environment variables:
 * - GITHUB_APP_ID: GitHub App ID
 * - GITHUB_APP_PRIVATE_KEY: GitHub App Private Key (PEM format)
 * - GITHUB_APP_INSTALLATION_ID: (optional) Installation ID
 *
 * @returns GitHubAppAuth instance or null if not configured
 */
export function getGitHubAppAuth(): GitHubAppAuth | null {
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;
  const installationId = process.env.GITHUB_APP_INSTALLATION_ID;

  if (!appId || !privateKey) {
    logger.debug('GitHub App credentials not configured, using fallback');
    return null;
  }

  if (!githubAppAuthInstance) {
    githubAppAuthInstance = new GitHubAppAuth({
      appId,
      privateKey,
      installationId,
    });
  }

  return githubAppAuthInstance;
}

/**
 * Check if GitHub App authentication is configured.
 */
export function isGitHubAppConfigured(): boolean {
  return !!(process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY);
}
