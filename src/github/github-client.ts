/**
 * GitHub API Client.
 *
 * Provides a high-level API for GitHub operations using either
 * GitHub App authentication or PAT (Personal Access Token) as fallback.
 *
 * @see https://docs.github.com/en/rest
 */

import { createLogger } from '../utils/logger.js';
import {
  GitHubAppAuth,
  getGitHubAppAuth,
  isGitHubAppConfigured,
} from './github-app-auth.js';

const logger = createLogger('GitHubClient');

/**
 * GitHub repository information.
 */
export interface GitHubRepository {
  owner: string;
  repo: string;
}

/**
 * GitHub Issue information.
 */
export interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: Array<{ name: string }>;
  assignees: Array<{ login: string }>;
  html_url: string;
  created_at: string;
  updated_at: string;
}

/**
 * GitHub Pull Request information.
 */
export interface GitHubPullRequest {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed' | 'merged';
  head: {
    ref: string;
    sha: string;
  };
  base: {
    ref: string;
    sha: string;
  };
  html_url: string;
  created_at: string;
  updated_at: string;
  merged_at: string | null;
}

/**
 * GitHub PR creation options.
 */
export interface CreatePROptions {
  title: string;
  body: string;
  head: string;
  base: string;
  draft?: boolean;
}

/**
 * GitHub Issue creation options.
 */
export interface CreateIssueOptions {
  title: string;
  body?: string;
  labels?: string[];
  assignees?: string[];
}

/**
 * GitHub API Client.
 *
 * Handles all GitHub API interactions with automatic authentication
 * using GitHub App or PAT fallback.
 *
 * @example
 * ```typescript
 * const client = new GitHubClient();
 *
 * // Create an issue
 * const issue = await client.createIssue({ owner: 'hs3180', repo: 'disclaude' }, {
 *   title: 'Bug: Something is broken',
 *   body: 'Description of the bug'
 * });
 *
 * // Create a PR
 * const pr = await client.createPR({ owner: 'hs3180', repo: 'disclaude' }, {
 *   title: 'Fix: Something',
 *   body: 'Fixes #123',
 *   head: 'fix/issue-123',
 *   base: 'main'
 * });
 * ```
 */
export class GitHubClient {
  private readonly appAuth: GitHubAppAuth | null;
  private readonly pat: string | null;

  constructor() {
    this.appAuth = getGitHubAppAuth();
    this.pat = process.env.GITHUB_TOKEN || null;

    if (this.appAuth) {
      logger.info('Using GitHub App authentication');
    } else if (this.pat) {
      logger.info('Using Personal Access Token (PAT) authentication');
    } else {
      logger.warn(
        'No GitHub authentication configured. Set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY, or GITHUB_TOKEN.'
      );
    }
  }

  /**
   * Get the authorization header for API requests.
   */
  private async getAuthHeader(): Promise<string> {
    if (this.appAuth) {
      const token = await this.appAuth.getInstallationToken();
      return `token ${token}`;
    }

    if (this.pat) {
      return `token ${this.pat}`;
    }

    throw new Error(
      'No GitHub authentication available. Configure GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY, or GITHUB_TOKEN.'
    );
  }

  /**
   * Make an authenticated request to the GitHub API.
   */
  private async request<T>(
    path: string,
    options: {
      method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
      body?: unknown;
    } = {}
  ): Promise<T> {
    const authHeader = await this.getAuthHeader();

    const response = await fetch(`https://api.github.com${path}`, {
      method: options.method || 'GET',
      headers: {
        Authorization: authHeader,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'disclaude',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GitHub API error: ${response.status} - ${text}`);
    }

    // Handle 204 No Content
    if (response.status === 204) {
      return {} as T;
    }

    return (await response.json()) as T;
  }

  /**
   * Get an issue by number.
   */
  async getIssue(
    repo: GitHubRepository,
    issueNumber: number
  ): Promise<GitHubIssue> {
    return this.request<GitHubIssue>(
      `/repos/${repo.owner}/${repo.repo}/issues/${issueNumber}`
    );
  }

  /**
   * List issues in a repository.
   */
  async listIssues(
    repo: GitHubRepository,
    options: {
      state?: 'open' | 'closed' | 'all';
      labels?: string[];
      sort?: 'created' | 'updated' | 'comments';
      direction?: 'asc' | 'desc';
      per_page?: number;
    } = {}
  ): Promise<GitHubIssue[]> {
    const params = new URLSearchParams();
    if (options.state) params.set('state', options.state);
    if (options.labels) params.set('labels', options.labels.join(','));
    if (options.sort) params.set('sort', options.sort);
    if (options.direction) params.set('direction', options.direction);
    if (options.per_page) params.set('per_page', String(options.per_page));

    const queryString = params.toString();
    const path = `/repos/${repo.owner}/${repo.repo}/issues${queryString ? `?${queryString}` : ''}`;

    return this.request<GitHubIssue[]>(path);
  }

  /**
   * Create a new issue.
   */
  async createIssue(
    repo: GitHubRepository,
    options: CreateIssueOptions
  ): Promise<GitHubIssue> {
    logger.info(
      { repo: `${repo.owner}/${repo.repo}`, title: options.title },
      'Creating issue'
    );

    return this.request<GitHubIssue>(
      `/repos/${repo.owner}/${repo.repo}/issues`,
      {
        method: 'POST',
        body: options,
      }
    );
  }

  /**
   * Update an existing issue.
   */
  async updateIssue(
    repo: GitHubRepository,
    issueNumber: number,
    options: Partial<CreateIssueOptions> & { state?: 'open' | 'closed' }
  ): Promise<GitHubIssue> {
    logger.info(
      { repo: `${repo.owner}/${repo.repo}`, issueNumber },
      'Updating issue'
    );

    return this.request<GitHubIssue>(
      `/repos/${repo.owner}/${repo.repo}/issues/${issueNumber}`,
      {
        method: 'PATCH',
        body: options,
      }
    );
  }

  /**
   * Get a pull request by number.
   */
  async getPR(
    repo: GitHubRepository,
    prNumber: number
  ): Promise<GitHubPullRequest> {
    return this.request<GitHubPullRequest>(
      `/repos/${repo.owner}/${repo.repo}/pulls/${prNumber}`
    );
  }

  /**
   * List pull requests in a repository.
   */
  async listPRs(
    repo: GitHubRepository,
    options: {
      state?: 'open' | 'closed' | 'all';
      head?: string;
      base?: string;
      sort?: 'created' | 'updated' | 'popularity';
      direction?: 'asc' | 'desc';
      per_page?: number;
    } = {}
  ): Promise<GitHubPullRequest[]> {
    const params = new URLSearchParams();
    if (options.state) params.set('state', options.state);
    if (options.head) params.set('head', options.head);
    if (options.base) params.set('base', options.base);
    if (options.sort) params.set('sort', options.sort);
    if (options.direction) params.set('direction', options.direction);
    if (options.per_page) params.set('per_page', String(options.per_page));

    const queryString = params.toString();
    const path = `/repos/${repo.owner}/${repo.repo}/pulls${queryString ? `?${queryString}` : ''}`;

    return this.request<GitHubPullRequest[]>(path);
  }

  /**
   * Create a new pull request.
   */
  async createPR(
    repo: GitHubRepository,
    options: CreatePROptions
  ): Promise<GitHubPullRequest> {
    logger.info(
      {
        repo: `${repo.owner}/${repo.repo}`,
        title: options.title,
        head: options.head,
        base: options.base,
      },
      'Creating pull request'
    );

    return this.request<GitHubPullRequest>(
      `/repos/${repo.owner}/${repo.repo}/pulls`,
      {
        method: 'POST',
        body: options,
      }
    );
  }

  /**
   * Get repository information.
   */
  async getRepo(repo: GitHubRepository): Promise<{
    name: string;
    full_name: string;
    private: boolean;
    default_branch: string;
  }> {
    return this.request(`/repos/${repo.owner}/${repo.repo}`);
  }

  /**
   * Get the current authenticated user/bot info.
   */
  async getAuthenticatedUser(): Promise<{
    login: string;
    type: 'User' | 'Bot';
    html_url: string;
  }> {
    return this.request('/user');
  }

  /**
   * Check if using GitHub App authentication (bot identity).
   */
  isUsingGitHubApp(): boolean {
    return isGitHubAppConfigured();
  }
}

/**
 * Singleton instance for convenience.
 */
let githubClientInstance: GitHubClient | null = null;

/**
 * Get the global GitHub client instance.
 */
export function getGitHubClient(): GitHubClient {
  if (!githubClientInstance) {
    githubClientInstance = new GitHubClient();
  }
  return githubClientInstance;
}
