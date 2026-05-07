/**
 * Unit tests for GitHubChangeDetector
 *
 * Issue #1953: Event-driven schedule trigger mechanism (Phase 1).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GitHubChangeDetector } from './github-change-detector.js';
import * as fsPromises from 'fs/promises';

// Mock fs/promises for state persistence
vi.mock('fs/promises', () => ({
  default: {
    mkdir: vi.fn(),
    readdir: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    unlink: vi.fn(),
  },
  mkdir: vi.fn(),
  readdir: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  unlink: vi.fn(),
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

/**
 * Helper: wrap a plain object as a fetch-like Response.
 * Avoids async arrow functions that ESLint flags as require-await.
 */
function mockResponse(body: unknown, overrides?: Partial<{ ok: boolean; status: number }>): unknown {
  return {
    ok: overrides?.ok ?? true,
    status: overrides?.status ?? 200,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

describe('GitHubChangeDetector', () => {
  let detector: GitHubChangeDetector;
  const testOptions = {
    repo: 'owner/repo',
    token: 'test-token',
    stateDir: '/tmp/test-detector-state',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    detector = new GitHubChangeDetector(testOptions);

    // Mock mkdir to succeed
    vi.mocked(fsPromises.mkdir).mockResolvedValue(undefined);
    // Mock readFile to throw (no existing state → fresh start)
    vi.mocked(fsPromises.readFile).mockRejectedValue(new Error('ENOENT'));
    // Mock writeFile to succeed
    vi.mocked(fsPromises.writeFile).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should create a GitHubChangeDetector', () => {
      expect(detector).toBeDefined();
    });

    it('should accept custom priority rules', () => {
      const customDetector = new GitHubChangeDetector({
        ...testOptions,
        priorityRules: [
          { priority: 'P0', labels: ['custom-critical'] },
        ],
      });
      expect(customDetector).toBeDefined();
    });
  });

  describe('poll', () => {
    /**
     * Helper: mock GraphQL responses for PRs and Issues.
     */
    function mockGraphQLResponse(prs: Array<{
      number: number;
      title: string;
      labels?: string[];
      headRefName?: string;
      author?: string;
    }> = [], issues: Array<{
      number: number;
      title: string;
      labels?: string[];
      author?: string;
    }> = []) {
      mockFetch.mockImplementation((url: string, init?: RequestInit) => {
        if (typeof url === 'string' && url.includes('graphql')) {
          const body = JSON.parse((init?.body as string) ?? '{}');
          const query = body.query ?? '';

          if (query.includes('pullRequests')) {
            return Promise.resolve(mockResponse({
              data: {
                repository: {
                  pullRequests: {
                    nodes: prs.map(pr => ({
                      number: pr.number,
                      title: pr.title,
                      state: 'OPEN',
                      updatedAt: new Date().toISOString(),
                      headRefName: pr.headRefName,
                      author: pr.author ? { login: pr.author } : null,
                      labels: {
                        nodes: (pr.labels ?? []).map(name => ({ name })),
                      },
                    })),
                  },
                },
              },
            }));
          }

          if (query.includes('issues')) {
            return Promise.resolve(mockResponse({
              data: {
                repository: {
                  issues: {
                    nodes: issues.map(issue => ({
                      number: issue.number,
                      title: issue.title,
                      state: 'OPEN',
                      updatedAt: new Date().toISOString(),
                      author: issue.author ? { login: issue.author } : null,
                      labels: {
                        nodes: (issue.labels ?? []).map(name => ({ name })),
                      },
                    })),
                  },
                },
              },
            }));
          }
        }

        return Promise.resolve(mockResponse('Not found', { ok: false, status: 404 }));
      });
    }

    it('should detect new PRs as P2 by default', async () => {
      mockGraphQLResponse(
        [{ number: 1, title: 'Test PR' }],
        []
      );

      const changes = await detector.poll();

      expect(changes).toHaveLength(1);
      expect(changes[0]).toMatchObject({
        itemType: 'pr',
        action: 'opened',
        priority: 'P2',
        number: 1,
        title: 'Test PR',
      });
    });

    it('should detect new Issues with bug label as P0', async () => {
      mockGraphQLResponse(
        [],
        [{ number: 42, title: 'Critical bug', labels: ['bug'] }]
      );

      const changes = await detector.poll();

      expect(changes).toHaveLength(1);
      expect(changes[0]).toMatchObject({
        itemType: 'issue',
        action: 'opened',
        priority: 'P0',
        number: 42,
        title: 'Critical bug',
        labels: ['bug'],
      });
    });

    it('should detect new Issues with enhancement label as P1', async () => {
      mockGraphQLResponse(
        [],
        [{ number: 10, title: 'New feature', labels: ['enhancement'] }]
      );

      const changes = await detector.poll();

      expect(changes).toHaveLength(1);
      expect(changes[0].priority).toBe('P1');
    });

    it('should not report existing items as new on second poll', async () => {
      // First poll: 1 PR, 1 Issue
      mockGraphQLResponse(
        [{ number: 1, title: 'PR 1' }],
        [{ number: 2, title: 'Issue 2', labels: ['bug'] }]
      );

      const changes1 = await detector.poll();
      expect(changes1).toHaveLength(2);

      // Mock writeFile to capture state
      const stateWrites: string[] = [];
      vi.mocked(fsPromises.writeFile).mockImplementation((_path, data) => {
        stateWrites.push(data as string);
        return Promise.resolve();
      });

      // Mock readFile to return the persisted state
      vi.mocked(fsPromises.readFile).mockImplementation(() => {
        return Promise.resolve(
          stateWrites[stateWrites.length - 1] ?? '{"lastCheckTime":"","knownPRs":[1],"knownIssues":[2],"knownLabels":{}}'
        );
      });

      // Second poll: same items, no new changes
      mockGraphQLResponse(
        [{ number: 1, title: 'PR 1' }],
        [{ number: 2, title: 'Issue 2', labels: ['bug'] }]
      );

      const changes2 = await detector.poll();
      expect(changes2).toHaveLength(0);
    });

    it('should detect closed items', async () => {
      // First poll: 2 PRs
      mockGraphQLResponse(
        [
          { number: 1, title: 'PR 1' },
          { number: 2, title: 'PR 2' },
        ],
        []
      );

      await detector.poll();

      // Capture state
      const stateWrites: string[] = [];
      vi.mocked(fsPromises.writeFile).mockImplementation((_path, data) => {
        stateWrites.push(data as string);
        return Promise.resolve();
      });
      vi.mocked(fsPromises.readFile).mockImplementation(() => {
        return Promise.resolve(stateWrites[stateWrites.length - 1] ?? '{}');
      });

      // Second poll: only PR 1 remains (PR 2 was closed)
      mockGraphQLResponse(
        [{ number: 1, title: 'PR 1' }],
        []
      );

      const changes = await detector.poll();

      // PR 2 should be detected as closed
      const closedChange = changes.find(c => c.action === 'closed' && c.number === 2);
      expect(closedChange).toBeDefined();
      expect(closedChange!.itemType).toBe('pr');
      expect(closedChange!.priority).toBe('P3');
    });

    it('should detect label changes', async () => {
      // First poll: issue with no labels
      mockGraphQLResponse(
        [],
        [{ number: 5, title: 'Issue 5', labels: [] }]
      );

      await detector.poll();

      // Capture state
      const stateWrites: string[] = [];
      vi.mocked(fsPromises.writeFile).mockImplementation((_path, data) => {
        stateWrites.push(data as string);
        return Promise.resolve();
      });
      vi.mocked(fsPromises.readFile).mockImplementation(() => {
        return Promise.resolve(stateWrites[stateWrites.length - 1] ?? '{}');
      });

      // Second poll: same issue but now has 'bug' label
      mockGraphQLResponse(
        [],
        [{ number: 5, title: 'Issue 5', labels: ['bug'] }]
      );

      const changes = await detector.poll();

      // Should detect label change
      const labeledChange = changes.find(c => c.action === 'labeled');
      expect(labeledChange).toBeDefined();
      expect(labeledChange!.priority).toBe('P0');
    });

    it('should detect newly added items alongside existing ones', async () => {
      // First poll: 1 PR
      mockGraphQLResponse(
        [{ number: 1, title: 'PR 1' }],
        []
      );

      await detector.poll();

      // Capture state
      const stateWrites: string[] = [];
      vi.mocked(fsPromises.writeFile).mockImplementation((_path, data) => {
        stateWrites.push(data as string);
        return Promise.resolve();
      });
      vi.mocked(fsPromises.readFile).mockImplementation(() => {
        return Promise.resolve(stateWrites[stateWrites.length - 1] ?? '{}');
      });

      // Second poll: PR 1 still exists, PR 3 is new
      mockGraphQLResponse(
        [
          { number: 1, title: 'PR 1' },
          { number: 3, title: 'New PR 3', labels: ['enhancement'] },
        ],
        []
      );

      const changes = await detector.poll();

      // Only PR 3 should be new
      expect(changes).toHaveLength(1);
      expect(changes[0]).toMatchObject({
        number: 3,
        action: 'opened',
        priority: 'P1',
      });
    });

    it('should sort changes by priority (P0 first)', async () => {
      mockGraphQLResponse(
        [],
        [
          { number: 1, title: 'Feature', labels: ['enhancement'] },       // P1
          { number: 2, title: 'Bug', labels: ['bug'] },                   // P0
          { number: 3, title: 'Question', labels: [] },                   // P2
          { number: 4, title: 'Docs', labels: ['documentation'] },        // P3
        ]
      );

      const changes = await detector.poll();

      expect(changes.map(c => c.priority)).toEqual(['P0', 'P1', 'P2', 'P3']);
    });

    it('should return empty array when GitHub API fails', async () => {
      mockFetch.mockResolvedValue(mockResponse('Internal Server Error', { ok: false, status: 500 }));

      const changes = await detector.poll();

      expect(changes).toHaveLength(0);
    });

    it('should fall back to REST API when GraphQL fails', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (typeof url === 'string' && url.includes('graphql')) {
          return Promise.resolve(mockResponse('Server Error', { ok: false, status: 500 }));
        }
        // REST fallback
        return Promise.resolve(mockResponse([
          {
            number: 99,
            title: 'REST PR',
            state: 'open',
            updated_at: new Date().toISOString(),
            labels: [{ name: 'bug' }],
          },
        ]));
      });

      const changes = await detector.poll();

      // Should have fetched via REST
      expect(changes.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('getLastCheckTime', () => {
    it('should return null before first poll', () => {
      expect(detector.getLastCheckTime()).toBeNull();
    });

    it('should return timestamp after poll', async () => {
      mockFetch.mockImplementation(() => Promise.resolve(mockResponse({
        data: {
          repository: {
            pullRequests: { nodes: [] },
            issues: { nodes: [] },
          },
        },
      })));

      await detector.poll();

      const lastCheck = detector.getLastCheckTime();
      expect(lastCheck).not.toBeNull();
      expect(typeof lastCheck).toBe('string');
    });
  });

  describe('getKnownCounts', () => {
    it('should return zeros before initialization', () => {
      expect(detector.getKnownCounts()).toEqual({ prs: 0, issues: 0 });
    });
  });

  describe('reset', () => {
    it('should clear state', async () => {
      await detector.reset();
      expect(detector.getLastCheckTime()).toBe('');
      expect(detector.getKnownCounts()).toEqual({ prs: 0, issues: 0 });
    });
  });

  describe('custom priority rules', () => {
    it('should use custom rules before default rules', async () => {
      const customDetector = new GitHubChangeDetector({
        ...testOptions,
        priorityRules: [
          { priority: 'P0', labels: ['my-custom-label'] },
        ],
      });

      mockFetch.mockImplementation(() => Promise.resolve(mockResponse({
        data: {
          repository: {
            issues: {
              nodes: [{
                number: 1,
                title: 'Custom',
                state: 'OPEN',
                updatedAt: new Date().toISOString(),
                labels: { nodes: [{ name: 'my-custom-label' }] },
              }],
            },
          },
        },
      })));

      const changes = await customDetector.poll();

      expect(changes).toHaveLength(1);
      expect(changes[0].priority).toBe('P0');
    });
  });

  describe('state persistence', () => {
    it('should persist state after poll', async () => {
      mockFetch.mockImplementation(() => Promise.resolve(mockResponse({
        data: { repository: { pullRequests: { nodes: [] }, issues: { nodes: [] } } },
      })));

      await detector.poll();

      expect(fsPromises.writeFile).toHaveBeenCalled();
      const { calls } = vi.mocked(fsPromises.writeFile).mock;
      const writePath = calls[0][0] as string;
      const writeData = calls[0][1] as string;
      expect(writePath).toContain('github-detector-state.json');
      const state = JSON.parse(writeData);
      expect(state).toHaveProperty('lastCheckTime');
      expect(state).toHaveProperty('knownPRs');
      expect(state).toHaveProperty('knownIssues');
      expect(state).toHaveProperty('knownLabels');
    });

    it('should load state from disk on subsequent polls', async () => {
      const savedState = JSON.stringify({
        lastCheckTime: '2026-01-01T00:00:00Z',
        knownPRs: [1, 2],
        knownIssues: [10],
        knownLabels: { 'pr:1': '', 'pr:2': '', 'issue:10': 'bug' },
      });

      vi.mocked(fsPromises.readFile).mockResolvedValue(savedState);

      mockFetch.mockImplementation(() => Promise.resolve(mockResponse({
        data: {
          repository: {
            pullRequests: {
              nodes: [
                { number: 1, title: 'PR 1', state: 'OPEN', updatedAt: new Date().toISOString(), labels: { nodes: [] } },
                { number: 2, title: 'PR 2', state: 'OPEN', updatedAt: new Date().toISOString(), labels: { nodes: [] } },
                { number: 3, title: 'New PR 3', state: 'OPEN', updatedAt: new Date().toISOString(), labels: { nodes: [{ name: 'bug' }] } },
              ],
            },
          },
        },
      })));

      const changes = await detector.poll();

      // Only PR 3 should be detected as new (1 and 2 were in saved state)
      const opened = changes.filter(c => c.action === 'opened');
      expect(opened).toHaveLength(1);
      expect(opened[0].number).toBe(3);
    });
  });

  describe('error handling', () => {
    it('should handle invalid repo format', async () => {
      const badDetector = new GitHubChangeDetector({
        repo: 'invalid',
        token: 'test',
        stateDir: '/tmp/test',
      });

      mockFetch.mockImplementation(() => Promise.resolve(mockResponse({
        data: { repository: { pullRequests: { nodes: [] }, issues: { nodes: [] } } },
      })));

      const changes = await badDetector.poll();
      expect(changes).toEqual([]);
    });

    it('should handle network errors gracefully', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      const changes = await detector.poll();
      expect(changes).toEqual([]);
    });

    it('should handle malformed GraphQL response', async () => {
      // First call returns GraphQL error, second call is REST fallback that also fails
      mockFetch.mockResolvedValue(mockResponse({ errors: [{ message: 'Bad query' }] }));

      const changes = await detector.poll();
      expect(changes).toEqual([]);
    });
  });
});
