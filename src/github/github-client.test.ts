/**
 * Tests for GitHub Client Module.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { GitHubClient, getGitHubClient } from './github-client.js';

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock environment variables
const originalEnv = process.env;

describe('GitHubClient', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    mockFetch.mockReset();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('constructor', () => {
    it('should create instance without config (with warning)', () => {
      delete process.env.GITHUB_APP_ID;
      delete process.env.GITHUB_APP_PRIVATE_KEY;
      delete process.env.GITHUB_TOKEN;

      const client = new GitHubClient();
      expect(client).toBeDefined();
      expect(client.isUsingGitHubApp()).toBe(false);
    });

    it('should detect GitHub App configuration', () => {
      process.env.GITHUB_APP_ID = '123456';
      process.env.GITHUB_APP_PRIVATE_KEY = 'test-key';

      const client = new GitHubClient();
      expect(client.isUsingGitHubApp()).toBe(true);
    });

    it('should detect PAT fallback', () => {
      delete process.env.GITHUB_APP_ID;
      delete process.env.GITHUB_APP_PRIVATE_KEY;
      process.env.GITHUB_TOKEN = 'ghp_test';

      const client = new GitHubClient();
      expect(client.isUsingGitHubApp()).toBe(false);
    });
  });

  describe('API methods (with PAT)', () => {
    let client: GitHubClient;

    beforeEach(() => {
      delete process.env.GITHUB_APP_ID;
      delete process.env.GITHUB_APP_PRIVATE_KEY;
      process.env.GITHUB_TOKEN = 'ghp_test_token';
      client = new GitHubClient();
    });

    describe('getIssue', () => {
      it('should fetch an issue by number', async () => {
        const mockIssue = {
          number: 123,
          title: 'Test Issue',
          body: 'Test body',
          state: 'open',
          labels: [],
          assignees: [],
          html_url: 'https://github.com/test/repo/issues/123',
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        };

        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mockIssue),
        });

        const result = await client.getIssue(
          { owner: 'test', repo: 'repo' },
          123
        );

        expect(result).toEqual(mockIssue);
        expect(mockFetch).toHaveBeenCalledWith(
          'https://api.github.com/repos/test/repo/issues/123',
          expect.objectContaining({
            method: 'GET',
            headers: expect.objectContaining({
              Authorization: 'token ghp_test_token',
            }),
          })
        );
      });

      it('should throw on API error', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: false,
          status: 404,
          text: () => Promise.resolve('Not Found'),
        });

        await expect(
          client.getIssue({ owner: 'test', repo: 'repo' }, 999)
        ).rejects.toThrow('GitHub API error: 404');
      });
    });

    describe('createIssue', () => {
      it('should create an issue', async () => {
        const mockResponse = {
          number: 124,
          title: 'New Issue',
          body: 'Body',
          state: 'open',
          labels: [],
          assignees: [],
          html_url: 'https://github.com/test/repo/issues/124',
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        };

        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mockResponse),
        });

        const result = await client.createIssue(
          { owner: 'test', repo: 'repo' },
          { title: 'New Issue', body: 'Body' }
        );

        expect(result).toEqual(mockResponse);
        expect(mockFetch).toHaveBeenCalledWith(
          'https://api.github.com/repos/test/repo/issues',
          expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({ title: 'New Issue', body: 'Body' }),
          })
        );
      });
    });

    describe('createPR', () => {
      it('should create a pull request', async () => {
        const mockResponse = {
          number: 10,
          title: 'New PR',
          body: 'Fixes #123',
          state: 'open',
          head: { ref: 'feature', sha: 'abc123' },
          base: { ref: 'main', sha: 'def456' },
          html_url: 'https://github.com/test/repo/pull/10',
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
          merged_at: null,
        };

        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mockResponse),
        });

        const result = await client.createPR(
          { owner: 'test', repo: 'repo' },
          {
            title: 'New PR',
            body: 'Fixes #123',
            head: 'feature',
            base: 'main',
          }
        );

        expect(result).toEqual(mockResponse);
      });
    });

    describe('listIssues', () => {
      it('should list issues with filters', async () => {
        const mockIssues = [
          {
            number: 1,
            title: 'Issue 1',
            body: null,
            state: 'open',
            labels: [{ name: 'bug' }],
            assignees: [],
            html_url: 'https://github.com/test/repo/issues/1',
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-01T00:00:00Z',
          },
        ];

        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mockIssues),
        });

        const result = await client.listIssues(
          { owner: 'test', repo: 'repo' },
          { state: 'open', labels: ['bug'] }
        );

        expect(result).toEqual(mockIssues);
        expect(mockFetch).toHaveBeenCalledWith(
          expect.stringContaining('state=open'),
          expect.any(Object)
        );
        expect(mockFetch).toHaveBeenCalledWith(
          expect.stringContaining('labels=bug'),
          expect.any(Object)
        );
      });
    });

    describe('getAuthenticatedUser', () => {
      it('should get current user info', async () => {
        const mockUser = {
          login: 'testuser',
          type: 'User',
          html_url: 'https://github.com/testuser',
        };

        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mockUser),
        });

        const result = await client.getAuthenticatedUser();
        expect(result).toEqual(mockUser);
      });
    });
  });
});

describe('getGitHubClient', () => {
  it('should return singleton instance', () => {
    const client1 = getGitHubClient();
    const client2 = getGitHubClient();

    expect(client1).toBe(client2);
  });
});
