/**
 * GitHub Change Detector - Detects incremental changes in GitHub repos.
 *
 * Issue #1953: Event-driven schedule trigger mechanism (Phase 1).
 *
 * This module provides the "感知层" (perception layer) for the Coordinator Agent.
 * It polls GitHub for changes in PRs and Issues, compares with previously seen
 * state, and returns incremental changes classified by priority.
 *
 * Architecture:
 * ```
 * GitHubChangeDetector
 *   ├── poll() → detect changes since last check
 *   │   ├── fetchOpenPRs() → compare with known PRs
 *   │   ├── fetchOpenIssues() → compare with known issues
 *   │   └── classifyPriority() → P0/P1/P2/P3
 *   ├── State persistence (file-based)
 *   │   ├── lastCheckTime
 *   │   └── knownItems (Set of known numbers)
 *   └── Idempotency (same item not reported twice)
 * ```
 *
 * Usage:
 * ```typescript
 * const detector = new GitHubChangeDetector({
 *   repo: 'owner/repo',
 *   token: 'ghs_xxx',
 *   stateDir: '/path/to/state',
 * });
 *
 * const changes = await detector.poll();
 * for (const change of changes) {
 *   console.log(change.type, change.priority, change.number, change.title);
 * }
 * ```
 *
 * @module @disclaude/core/scheduling
 */

import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('GitHubChangeDetector');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Priority levels for detected changes.
 *
 * | Priority | Meaning | Example |
 * |----------|---------|---------|
 * | P0 | Urgent / critical | `bug` label, security, CI failure |
 * | P1 | High | PR waiting review, high-engagement enhancement |
 * | P2 | Medium | New untriaged issue/PR |
 * | P3 | Low | Discussion, draft PR |
 */
export type ChangePriority = 'P0' | 'P1' | 'P2' | 'P3';

/**
 * Type of GitHub item that changed.
 */
export type ChangeItemType = 'pr' | 'issue';

/**
 * What kind of change was detected.
 */
export type ChangeAction = 'opened' | 'reopened' | 'updated' | 'labeled' | 'closed';

/**
 * A single detected change.
 */
export interface GitHubChange {
  /** Type of item */
  itemType: ChangeItemType;
  /** What happened */
  action: ChangeAction;
  /** Priority level */
  priority: ChangePriority;
  /** PR or Issue number */
  number: number;
  /** Title */
  title: string;
  /** Labels (names) */
  labels: string[];
  /** ISO timestamp of the item's last update on GitHub */
  updatedAt: string;
  /** ISO timestamp when this change was detected (local) */
  detectedAt: string;
  /** Optional head branch name (PRs only) */
  headRefName?: string;
  /** Optional author login */
  author?: string;
}

/**
 * Label-to-priority mapping rules.
 * First matching rule wins; items without matching labels default to P2.
 */
export interface PriorityRule {
  /** Priority to assign */
  priority: ChangePriority;
  /** Label names that trigger this priority (case-insensitive match) */
  labels: string[];
}

/**
 * Configuration for GitHubChangeDetector.
 */
export interface GitHubChangeDetectorOptions {
  /** GitHub repository in `owner/repo` format */
  repo: string;
  /** GitHub token (GH_TOKEN or personal access token) */
  token: string;
  /** Directory for persisting detector state */
  stateDir: string;
  /**
   * Custom priority classification rules.
   * Evaluated in order; first match wins. Default rules are appended.
   */
  priorityRules?: PriorityRule[];
  /**
   * Maximum number of items to fetch per poll (per PRs / Issues).
   * Defaults to 100.
   */
  pageSize?: number;
}

// ---------------------------------------------------------------------------
// Default priority rules
// ---------------------------------------------------------------------------

const DEFAULT_PRIORITY_RULES: PriorityRule[] = [
  { priority: 'P0', labels: ['bug', 'security', 'priority:high', 'critical'] },
  { priority: 'P1', labels: ['enhancement', 'feature', 'feature-request'] },
  { priority: 'P3', labels: ['documentation', 'chore', 'wontfix', 'invalid'] },
];

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------

interface DetectorState {
  /** ISO timestamp of the last successful poll */
  lastCheckTime: string;
  /** Set of known open PR numbers */
  knownPRs: number[];
  /** Set of known open Issue numbers */
  knownIssues: number[];
  /**
   * Map of `itemType:number` → last known labels (sorted, joined with comma).
   * Used to detect label changes.
   */
  knownLabels: Record<string, string>;
}

// ---------------------------------------------------------------------------
// GitHub API response shapes (subset)
// ---------------------------------------------------------------------------

interface GitHubPRItem {
  number: number;
  title: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  updatedAt: string;
  headRefName?: string;
  author?: { login: string };
  labels?: { name: string }[];
}

interface GitHubIssueItem {
  number: number;
  title: string;
  state: 'OPEN' | 'CLOSED';
  updatedAt: string;
  author?: { login: string };
  labels?: { name: string }[];
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * GitHubChangeDetector - Detects incremental changes in GitHub repos.
 *
 * Design goals:
 * 1. **Incremental**: Only returns items changed since the last poll
 * 2. **Idempotent**: Same item is never reported twice for the same action
 * 3. **Priority-classified**: Each change is assigned a priority level
 * 4. **Stateful**: Persists state to disk for restart-survival
 * 5. **Token-efficient**: Skips items that haven't been updated
 */
export class GitHubChangeDetector {
  private readonly repo: string;
  private readonly token: string;
  private readonly stateDir: string;
  private readonly priorityRules: PriorityRule[];
  private readonly pageSize: number;
  private readonly stateFile: string;

  /** In-memory state, loaded from disk */
  private state: DetectorState | null = null;
  private initialized = false;

  constructor(options: GitHubChangeDetectorOptions) {
    this.repo = options.repo;
    this.token = options.token;
    this.stateDir = options.stateDir;
    this.priorityRules = [
      ...(options.priorityRules ?? []),
      ...DEFAULT_PRIORITY_RULES,
    ];
    this.pageSize = options.pageSize ?? 100;
    this.stateFile = path.join(this.stateDir, 'github-detector-state.json');

    logger.info({ repo: this.repo }, 'GitHubChangeDetector created');
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Poll for changes since the last check.
   *
   * Returns an array of detected changes, sorted by priority (P0 first).
   * After a successful poll, the state is persisted to disk.
   *
   * @returns Array of detected changes (may be empty)
   */
  async poll(): Promise<GitHubChange[]> {
    await this.ensureInitialized();

    const now = new Date().toISOString();
    const changes: GitHubChange[] = [];

    // Fetch current state from GitHub
    const [currentPRs, currentIssues] = await Promise.all([
      this.fetchOpenPRs(),
      this.fetchOpenIssues(),
    ]);

    // eslint-disable-next-line prefer-destructuring
    const state: DetectorState | null = this.state;
    if (!state) {
      logger.warn('Poll called before initialization completed');
      return [];
    }

    const prevPRs = new Set(state.knownPRs);
    const prevIssues = new Set(state.knownIssues);
    const prevLabels = state.knownLabels;

    // Detect PR changes
    for (const pr of currentPRs) {
      const isNew = !prevPRs.has(pr.number);
      const labelKey = `pr:${pr.number}`;
      const currentLabelStr = this.labelString(pr.labels ?? []);
      const prevLabelStr = prevLabels[labelKey];
      const labelsChanged = prevLabelStr !== undefined && prevLabelStr !== currentLabelStr;

      if (isNew) {
        changes.push(this.buildChange('pr', 'opened', pr, now));
      } else if (labelsChanged) {
        changes.push(this.buildChange('pr', 'labeled', pr, now));
      }
      // "updated" is covered by label changes for now; full updatedAt tracking
      // would require storing per-item timestamps (future enhancement).
    }

    // Detect closed PRs (were in previous set, not in current)
    const currentPRNumbers = new Set(currentPRs.map(p => p.number));
    for (const prNum of prevPRs) {
      if (!currentPRNumbers.has(prNum)) {
        changes.push({
          itemType: 'pr',
          action: 'closed',
          priority: 'P3',
          number: prNum,
          title: '',
          labels: [],
          updatedAt: now,
          detectedAt: now,
        });
      }
    }

    // Detect Issue changes
    for (const issue of currentIssues) {
      const isNew = !prevIssues.has(issue.number);
      const labelKey = `issue:${issue.number}`;
      const currentLabelStr = this.labelString(issue.labels ?? []);
      const prevLabelStr = prevLabels[labelKey];
      const labelsChanged = prevLabelStr !== undefined && prevLabelStr !== currentLabelStr;

      if (isNew) {
        changes.push(this.buildChange('issue', 'opened', issue, now));
      } else if (labelsChanged) {
        changes.push(this.buildChange('issue', 'labeled', issue, now));
      }
    }

    // Detect closed Issues
    const currentIssueNumbers = new Set(currentIssues.map(i => i.number));
    for (const issueNum of prevIssues) {
      if (!currentIssueNumbers.has(issueNum)) {
        changes.push({
          itemType: 'issue',
          action: 'closed',
          priority: 'P3',
          number: issueNum,
          title: '',
          labels: [],
          updatedAt: now,
          detectedAt: now,
        });
      }
    }

    // Update state
    state.lastCheckTime = now;
    state.knownPRs = currentPRs.map(p => p.number);
    state.knownIssues = currentIssues.map(i => i.number);
    for (const pr of currentPRs) {
      state.knownLabels[`pr:${pr.number}`] = this.labelString(pr.labels ?? []);
    }
    for (const issue of currentIssues) {
      state.knownLabels[`issue:${issue.number}`] = this.labelString(issue.labels ?? []);
    }

    // Persist
    await this.persistState();

    // Sort by priority (P0 first)
    const priorityOrder: Record<ChangePriority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
    changes.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

    logger.info(
      { changeCount: changes.length, prCount: currentPRs.length, issueCount: currentIssues.length },
      'Poll completed'
    );

    return changes;
  }

  /**
   * Get the last check time.
   */
  getLastCheckTime(): string | null {
    return this.state?.lastCheckTime ?? null;
  }

  /**
   * Get the count of known PRs and Issues.
   */
  getKnownCounts(): { prs: number; issues: number } {
    if (!this.state) {
      return { prs: 0, issues: 0 };
    }
    return { prs: this.state.knownPRs.length, issues: this.state.knownIssues.length };
  }

  /**
   * Reset the detector state.
   * Next poll will treat all items as new.
   */
  async reset(): Promise<void> {
    this.state = {
      lastCheckTime: '',
      knownPRs: [],
      knownIssues: [],
      knownLabels: {},
    };
    await this.persistState();
    logger.info('Detector state reset');
  }

  // -----------------------------------------------------------------------
  // GitHub API
  // -----------------------------------------------------------------------

  /**
   * Fetch all open PRs from GitHub.
   */
  private fetchOpenPRs(): Promise<GitHubPRItem[]> {
    return this.fetchGitHubItems<GitHubPRItem>('pull_requests', (item) => {
      const labels = item.labels as { nodes?: { name: string }[] } | { name: string }[] | undefined;
      const labelNodes = Array.isArray(labels)
        ? labels
        : labels?.nodes ?? [];
      return {
        number: item.number as number,
        title: item.title as string,
        state: item.state as 'OPEN' | 'CLOSED' | 'MERGED',
        updatedAt: item.updatedAt as string,
        headRefName: item.headRefName as string | undefined,
        author: item.author as { login: string } | undefined,
        labels: labelNodes,
      };
    });
  }

  /**
   * Fetch all open Issues from GitHub.
   */
  private fetchOpenIssues(): Promise<GitHubIssueItem[]> {
    return this.fetchGitHubItems<GitHubIssueItem>('issues', (item) => {
      const labels = item.labels as { nodes?: { name: string }[] } | { name: string }[] | undefined;
      const labelNodes = Array.isArray(labels)
        ? labels
        : labels?.nodes ?? [];
      return {
        number: item.number as number,
        title: item.title as string,
        state: item.state as 'OPEN' | 'CLOSED',
        updatedAt: item.updatedAt as string,
        author: item.author as { login: string } | undefined,
        labels: labelNodes,
      };
    });
  }

  /**
   * Generic GitHub GraphQL fetch for open PRs or Issues.
   *
   * Uses the GitHub GraphQL API for efficient batch fetching.
   * Falls back to REST API if GraphQL fails.
   */
  private async fetchGitHubItems<T>(
    type: 'pull_requests' | 'issues',
    normalize: (raw: Record<string, unknown>) => T
  ): Promise<T[]> {
    const [owner, name] = this.repo.split('/');
    if (!owner || !name) {
      logger.error({ repo: this.repo }, 'Invalid repo format');
      return [];
    }

    try {
      // Use GraphQL for efficient batch fetch
      const query = type === 'pull_requests'
        ? `query($owner: String!, $name: String!, $first: Int!) {
            repository(owner: $owner, name: $name) {
              pullRequests(first: $first, states: [OPEN], orderBy: {field: UPDATED_AT, direction: DESC}) {
                nodes {
                  number
                  title
                  state
                  updatedAt
                  headRefName
                  author { login }
                  labels(first: 20) { nodes { name } }
                }
              }
            }
          }`
        : `query($owner: String!, $name: String!, $first: Int!) {
            repository(owner: $owner, name: $name) {
              issues(first: $first, states: [OPEN], orderBy: {field: UPDATED_AT, direction: DESC}) {
                nodes {
                  number
                  title
                  state
                  updatedAt
                  author { login }
                  labels(first: 20) { nodes { name } }
                }
              }
            }
          }`;

      const response = await fetch('https://api.github.com/graphql', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query,
          variables: { owner, name, first: this.pageSize },
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        logger.warn({ status: response.status, body: body.slice(0, 200), type }, 'GraphQL fetch failed, falling back to REST');
        return this.fetchGitHubItemsREST<T>(type, normalize);
      }

      const data = await response.json() as { data?: { repository?: Record<string, unknown> }; errors?: unknown[] };

      if (data.errors) {
        logger.warn({ errors: data.errors, type }, 'GraphQL returned errors, falling back to REST');
        return this.fetchGitHubItemsREST<T>(type, normalize);
      }

      const key = type === 'pull_requests' ? 'pullRequests' : 'issues';
      const nodes = (data.data?.repository?.[key] as { nodes: Record<string, unknown>[] })?.nodes ?? [];
      return nodes.map(normalize);
    } catch (error) {
      logger.error({ err: error, type }, 'Failed to fetch GitHub items');
      return [];
    }
  }

  /**
   * REST API fallback for fetching GitHub items.
   */
  private async fetchGitHubItemsREST<T>(
    type: 'pull_requests' | 'issues',
    normalize: (raw: Record<string, unknown>) => T
  ): Promise<T[]> {
    const endpoint = type === 'pull_requests'
      ? `https://api.github.com/repos/${this.repo}/pulls?state=open&per_page=${this.pageSize}&sort=updated&direction=desc`
      : `https://api.github.com/repos/${this.repo}/issues?state=open&per_page=${this.pageSize}&sort=updated&direction=desc`;

    try {
      const response = await fetch(endpoint, {
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Accept': 'application/vnd.github+json',
        },
      });

      if (!response.ok) {
        logger.warn({ status: response.status, type }, 'REST fetch failed');
        return [];
      }

      const items = await response.json() as Record<string, unknown>[];

      // REST API returns flat labels for issues/PRs
      return items.map((item) => {
        // Normalize REST labels to { name } format
        const restLabels = (item.labels as Array<string | { name: string }>)?.map(l =>
          typeof l === 'string' ? { name: l } : l
        ) ?? [];
        return normalize({ ...item, labels: restLabels });
      });
    } catch (error) {
      logger.error({ err: error, type }, 'REST fallback failed');
      return [];
    }
  }

  // -----------------------------------------------------------------------
  // Priority classification
  // -----------------------------------------------------------------------

  /**
   * Classify a change's priority based on its labels.
   */
  private classifyPriority(labels: string[]): ChangePriority {
    const lowerLabels = new Set(labels.map(l => l.toLowerCase()));

    for (const rule of this.priorityRules) {
      if (rule.labels.some(rl => lowerLabels.has(rl.toLowerCase()))) {
        return rule.priority;
      }
    }

    // Default: medium priority
    return 'P2';
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  /**
   * Build a GitHubChange from a fetched item.
   */
  private buildChange(
    itemType: ChangeItemType,
    action: ChangeAction,
    item: { number: number; title: string; labels?: { name: string }[]; updatedAt: string; headRefName?: string; author?: { login: string } },
    detectedAt: string,
  ): GitHubChange {
    const labels = (item.labels ?? []).map(l => typeof l === 'string' ? l : l.name);
    return {
      itemType,
      action,
      priority: this.classifyPriority(labels),
      number: item.number,
      title: item.title,
      labels,
      updatedAt: item.updatedAt,
      detectedAt,
      headRefName: item.headRefName,
      author: item.author?.login,
    };
  }

  /**
   * Create a stable string from label names for change detection.
   */
  private labelString(labels: { name: string }[]): string {
    return labels.map(l => l.name).sort().join(',');
  }

  // -----------------------------------------------------------------------
  // State persistence
  // -----------------------------------------------------------------------

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) { return; }

    try {
      await fsPromises.mkdir(this.stateDir, { recursive: true });
    } catch {
      // Directory may already exist
    }

    try {
      const content = await fsPromises.readFile(this.stateFile, 'utf-8');
      this.state = JSON.parse(content) as DetectorState;
      logger.debug(
        { prs: this.state.knownPRs.length, issues: this.state.knownIssues.length },
        'Loaded detector state from disk'
      );
    } catch {
      // First run or corrupted state — start fresh
      this.state = {
        lastCheckTime: '',
        knownPRs: [],
        knownIssues: [],
        knownLabels: {},
      };
      logger.info('No existing state, starting fresh');
    }

    this.initialized = true;
  }

  private async persistState(): Promise<void> {
    try {
      await fsPromises.mkdir(this.stateDir, { recursive: true });
      await fsPromises.writeFile(
        this.stateFile,
        JSON.stringify(this.state, null, 2),
        'utf-8'
      );
    } catch (error) {
      logger.error({ err: error }, 'Failed to persist detector state');
    }
  }
}
