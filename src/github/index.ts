/**
 * GitHub Module
 *
 * Provides GitHub API integration with support for both:
 * - GitHub App authentication (bot identity)
 * - Personal Access Token (PAT) fallback
 *
 * @example
 * ```typescript
 * import { GitHubClient, isGitHubAppConfigured } from './github/index.js';
 *
 * // Check authentication method
 * if (isGitHubAppConfigured()) {
 *   console.log('Using GitHub App (bot identity)');
 * } else {
 *   console.log('Using PAT (personal identity)');
 * }
 *
 * // Use the client
 * const client = new GitHubClient();
 * const issue = await client.createIssue({ owner: 'hs3180', repo: 'disclaude' }, {
 *   title: 'New feature',
 *   body: 'Description'
 * });
 * ```
 */

export {
  GitHubAppAuth,
  getGitHubAppAuth,
  isGitHubAppConfigured,
  type GitHubAppConfig,
} from './github-app-auth.js';

export {
  GitHubClient,
  getGitHubClient,
  type GitHubRepository,
  type GitHubIssue,
  type GitHubPullRequest,
  type CreatePROptions,
  type CreateIssueOptions,
} from './github-client.js';
