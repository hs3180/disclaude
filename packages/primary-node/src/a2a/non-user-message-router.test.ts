/**
 * Tests for NonUserMessageRouter (Issue #3334)
 *
 * Covers:
 * 1. Anti-recursion: agent cannot enqueue to its own project
 * 2. Rate limiting: max messages per window
 * 3. Target agent not found for unknown projectKey
 * 4. Successful enqueue with correct message forwarding
 * 5. Source traceability in enqueued messages
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @disclaude/core — only mock what's needed
const mockReadProjectState = vi.fn();
const mockGetActive = vi.fn();
const mockListInstances = vi.fn();

vi.mock('@disclaude/core', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  createA2AMessage: (opts: any) => ({
    id: `test-${Date.now()}`,
    type: 'a2a',
    source: opts.source,
    projectKey: opts.projectKey,
    payload: opts.payload,
    priority: opts.priority ?? 'normal',
    createdAt: new Date().toISOString(),
  }),
  readProjectState: (...args: any[]) => mockReadProjectState(...args),
}));

// Mock PrimaryAgentPool
const mockProcessMessage = vi.fn();
vi.mock('../primary-agent-pool.js', () => ({
  PrimaryAgentPool: vi.fn().mockImplementation(() => ({
    getOrCreateChatAgent: vi.fn().mockReturnValue({
      processMessage: mockProcessMessage,
    }),
  })),
}));

import { NonUserMessageRouter } from './non-user-message-router.js';

function createRouter(options?: { maxMessagesPerWindow?: number; rateLimitWindowMs?: number }) {
  const mockProjectManager = {
    getActive: mockGetActive,
    listInstances: mockListInstances,
  } as any;

  const mockAgentPool = {
    getOrCreateChatAgent: vi.fn().mockReturnValue({
      processMessage: mockProcessMessage,
    }),
  } as any;

  return {
    router: new NonUserMessageRouter({
      agentPool: mockAgentPool,
      projectManager: mockProjectManager,
      maxMessagesPerWindow: options?.maxMessagesPerWindow ?? 10,
      rateLimitWindowMs: options?.rateLimitWindowMs ?? 5 * 60 * 1000,
    }),
    agentPool: mockAgentPool,
  };
}

/**
 * Helper: set up readProjectState to return different values based on workingDir.
 * Source lookup uses getActive().workingDir, target lookup iterates listInstances().
 */
function setupProjectStateMock(
  sourceWorkingDir: string | undefined,
  sourceProjectKey: string | undefined,
  instances: Array<{ workingDir: string; projectKey: string }>,
) {
  mockReadProjectState.mockImplementation((dir: string) => {
    // Source check
    if (sourceWorkingDir && dir === sourceWorkingDir) {
      return sourceProjectKey ? { projectKey: sourceProjectKey } : null;
    }
    // Target instance check
    const match = instances.find(inst => inst.workingDir === dir);
    return match ? { projectKey: match.projectKey } : null;
  });
}

describe('NonUserMessageRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadProjectState.mockReset();
    mockGetActive.mockReset();
    mockListInstances.mockReset();
  });

  describe('anti-recursion', () => {
    it('should reject enqueue to the same project', async () => {
      mockGetActive.mockReturnValue({
        name: 'my-project',
        workingDir: '/tmp/project',
      });
      setupProjectStateMock('/tmp/project', 'owner/repo', []);

      const { router } = createRouter();

      const result = await router.enqueue(
        'oc_source_chat',
        'owner/repo',
        'Do something',
        'normal',
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Anti-recursion');
      expect(mockProcessMessage).not.toHaveBeenCalled();
    });

    it('should allow enqueue to a different project', async () => {
      mockGetActive.mockReturnValue({
        name: 'project-a',
        workingDir: '/tmp/project-a',
      });
      setupProjectStateMock('/tmp/project-a', 'owner/repo-a', [
        { workingDir: '/tmp/project-b', projectKey: 'owner/repo-b' },
      ]);
      mockListInstances.mockReturnValue([
        {
          name: 'project-b',
          chatIds: ['oc_target_chat'],
          workingDir: '/tmp/project-b',
        },
      ]);

      const { router } = createRouter();

      const result = await router.enqueue(
        'oc_source_chat',
        'owner/repo-b',
        'Analyze issues',
        'high',
      );

      expect(result.success).toBe(true);
      expect(result.messageId).toBeDefined();
      expect(mockProcessMessage).toHaveBeenCalledOnce();
    });
  });

  describe('rate limiting', () => {
    it('should reject requests exceeding rate limit', async () => {
      mockGetActive.mockReturnValue({
        name: 'source-project',
        workingDir: '/tmp/source',
      });
      setupProjectStateMock('/tmp/source', 'owner/source', [
        { workingDir: '/tmp/target', projectKey: 'owner/target' },
      ]);
      mockListInstances.mockReturnValue([
        {
          name: 'target-project',
          chatIds: ['oc_target'],
          workingDir: '/tmp/target',
        },
      ]);

      const { router } = createRouter({
        maxMessagesPerWindow: 2,
        rateLimitWindowMs: 60000,
      });

      // First two should succeed
      const r1 = await router.enqueue('oc_source', 'owner/target', 'task 1', 'normal');
      const r2 = await router.enqueue('oc_source', 'owner/target', 'task 2', 'normal');
      expect(r1.success).toBe(true);
      expect(r2.success).toBe(true);

      // Third should be rate limited
      const r3 = await router.enqueue('oc_source', 'owner/target', 'task 3', 'normal');
      expect(r3.success).toBe(false);
      expect(r3.error).toContain('Rate limit');
    });

    it('should track rate limits independently per source chatId', async () => {
      mockGetActive.mockReturnValue({
        name: 'default',
        workingDir: '/tmp/default',
      });
      setupProjectStateMock('/tmp/default', undefined, [
        { workingDir: '/tmp/target', projectKey: 'owner/target' },
      ]);
      mockListInstances.mockReturnValue([
        {
          name: 'target',
          chatIds: ['oc_target'],
          workingDir: '/tmp/target',
        },
      ]);

      const { router } = createRouter({
        maxMessagesPerWindow: 1,
        rateLimitWindowMs: 60000,
      });

      // Each source should get its own quota
      const r1 = await router.enqueue('oc_source_1', 'owner/target', 'task 1', 'normal');
      const r2 = await router.enqueue('oc_source_2', 'owner/target', 'task 2', 'normal');
      expect(r1.success).toBe(true);
      expect(r2.success).toBe(true);
    });
  });

  describe('target lookup', () => {
    it('should return error when no agent found for projectKey', async () => {
      mockGetActive.mockReturnValue({
        name: 'default',
        workingDir: '/tmp/default',
      });
      setupProjectStateMock('/tmp/default', undefined, []);
      mockListInstances.mockReturnValue([]);

      const { router } = createRouter();

      const result = await router.enqueue(
        'oc_source',
        'owner/nonexistent',
        'Do something',
        'normal',
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('No active agent');
    });
  });

  describe('successful enqueue', () => {
    it('should forward prefixed payload to target agent', async () => {
      mockGetActive.mockReturnValue({
        name: 'default',
        workingDir: '/tmp/default',
      });
      setupProjectStateMock('/tmp/default', undefined, [
        { workingDir: '/tmp/target', projectKey: 'owner/target' },
      ]);
      mockListInstances.mockReturnValue([
        {
          name: 'target',
          chatIds: ['oc_target'],
          workingDir: '/tmp/target',
        },
      ]);

      const { router } = createRouter();

      const result = await router.enqueue(
        'oc_source_chat',
        'owner/target',
        'Analyze all open issues',
        'high',
      );

      expect(result.success).toBe(true);
      expect(result.messageId).toBeDefined();
      expect(mockProcessMessage).toHaveBeenCalledOnce();

      const [firstCall] = mockProcessMessage.mock.calls;
      const [targetChatId, forwardedPayload, msgId] = firstCall;
      expect(targetChatId).toBe('oc_target'); // targetChatId
      expect(forwardedPayload).toContain('[A2A Task from oc_source_chat]');
      expect(forwardedPayload).toContain('Analyze all open issues');
      expect(msgId).toMatch(/^a2a-test-/); // messageId: "a2a-" prefix + mock id
    });
  });
});
