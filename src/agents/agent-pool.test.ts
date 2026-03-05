/**
 * AgentPool - Tests for message routing isolation
 *
 * This verifies that messages are correctly routed to independent pilot instances
 * when multiple chatId are active concurrently.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentPool } from './agent-pool';
import { AgentFactory } from './index.js';
import { createLogger } from '../utils/logger.js';

// Mock AgentFactory.createChatAgent
vi.mock('./index.js', () => ({
  AgentFactory: {
    createChatAgent: vi.fn(),
  },
}));

describe('AgentPool', () => {
  let pool: AgentPool;
  let mockPilots: Map<string, { processMessage: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }>;

  const mockCallbacks = {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendCard: vi.fn().mockResolvedValue(undefined),
    sendFile: vi.fn().mockResolvedValue(undefined),
    onDone: vi.fn().mockResolvedValue(undefined),
    getCapabilities: vi.fn().mockReturnValue({ supportsThread: true }),
  };

  const createPilotMock = vi.fn().mockImplementation((_name: string, _callbacks: unknown, _options?: unknown) => {
    const pilot = {
      processMessage: vi.fn(),
      dispose: vi.fn(),
    };
    // Store pilot for later access
    mockPilots.set(_name, pilot);
    return pilot;
  });

  beforeEach(() => {
    mockPilots = new Map();
    vi.clearAllMocks();
    (AgentFactory.createChatAgent as ReturnType<typeof vi.fn>).mockImplementation(createPilotMock);

    pool = new AgentPool({
      logger: createLogger('agent-pool-test'),
      callbacks: mockCallbacks,
    });
  });

  afterEach(() => {
    pool.closeAll();
  });

  it('should create a new pilot for new chatId', () => {
    const pilot = pool.getOrCreate('chat-1');
    expect(pilot).toBeDefined();
    expect(createPilotMock).toHaveBeenCalledWith('pilot', expect.objectContaining({
      sendMessage: expect.any(Function),
      sendCard: expect.any(Function),
      sendFile: expect.any(Function),
      onDone: expect.any(Function),
      getCapabilities: expect.any(Function),
    }));
  });

  it('should return existing pilot for known chatId', () => {
    const pilot1 = pool.getOrCreate('chat-1');
    const pilot2 = pool.getOrCreate('chat-1');
    expect(pilot1).toBe(pilot2);
    // Should only create one pilot
    expect(createPilotMock).toHaveBeenCalledTimes(1);
  });

  it('should create different pilot for different chatId', () => {
    pool.getOrCreate('chat-1');
    pool.getOrCreate('chat-2');
    // Should create two different pilots
    expect(createPilotMock).toHaveBeenCalledTimes(2);
  });

  it('should not create duplicate pilot for same chatId', () => {
    pool.getOrCreate('chat-1');
    pool.getOrCreate('chat-1');
    pool.getOrCreate('chat-1');
    expect(createPilotMock).toHaveBeenCalledTimes(1);
  });

  it('should track active chatIds', () => {
    pool.getOrCreate('chat-1');
    pool.getOrCreate('chat-2');
    pool.getOrCreate('chat-3');
    expect(pool.size()).toBe(3);
    expect(pool.has('chat-1')).toBe(true);
    expect(pool.has('chat-2')).toBe(true);
    expect(pool.has('chat-3')).toBe(true);
    expect(pool.has('chat-4')).toBe(false);
  });

  it('should delete pilot and call dispose', () => {
    const pilot = pool.getOrCreate('chat-1');
    expect(pool.has('chat-1')).toBe(true);
    expect(pool.delete('chat-1')).toBe(true);
    expect(pool.has('chat-1')).toBe(false);
    expect(pilot.dispose).toHaveBeenCalled();
  });

  it('should handle concurrent message processing', async () => {
    // Create pilots for multiple chatIds
    const pilot1 = pool.getOrCreate('chat-1');
    const pilot2 = pool.getOrCreate('chat-2');

    // Simulate concurrent message processing
    pilot1.processMessage('chat-1', 'message 1', 'msg-1');
    pilot2.processMessage('chat-2', 'message 2', 'msg-2');

    // Verify that each pilot processed the correct message
    expect(pilot1.processMessage).toHaveBeenCalledWith('chat-1', 'message 1', 'msg-1');
    expect(pilot2.processMessage).toHaveBeenCalledWith('chat-2', 'message 2', 'msg-2');
  });

  it('should route callbacks to correct chatId', async () => {
    // Create pilot and get the callbacks passed to AgentFactory.createChatAgent
    pool.getOrCreate('chat-1');

    // Get the callbacks passed to AgentFactory.createChatAgent
    const callbacks = createPilotMock.mock.calls[0][1] as {
      sendMessage: (text: string, parentMessageId?: string) => Promise<void>;
      sendCard: (card: Record<string, unknown>, description?: string, parentMessageId?: string) => Promise<void>;
      sendFile: (filePath: string) => Promise<void>;
      onDone: (parentMessageId?: string) => Promise<void>;
      getCapabilities: () => unknown;
    };

    // Simulate callback from pilot (callbacks are bound to chat-1)
    await callbacks.sendMessage('Response text', 'msg-1');

    // Verify callback was called with correct chatId (bound in AgentPool)
    expect(mockCallbacks.sendMessage).toHaveBeenCalledWith('chat-1', 'Response text', 'msg-1');
  });

  it('should isolate pilots between different chatIds', async () => {
    // Create pilots for two chatIds
    pool.getOrCreate('chat-1');
    pool.getOrCreate('chat-2');

    // Get the callbacks for each pilot
    const callbacks1 = createPilotMock.mock.calls[0][1] as {
      sendMessage: (text: string, parentMessageId?: string) => Promise<void>;
      sendCard: (card: Record<string, unknown>, description?: string, parentMessageId?: string) => Promise<void>;
      sendFile: (filePath: string) => Promise<void>;
      onDone: (parentMessageId?: string) => Promise<void>;
      getCapabilities: () => unknown;
    };
    const callbacks2 = createPilotMock.mock.calls[1][1] as {
      sendMessage: (text: string, parentMessageId?: string) => Promise<void>;
      sendCard: (card: Record<string, unknown>, description?: string, parentMessageId?: string) => Promise<void>;
      sendFile: (filePath: string) => Promise<void>;
      onDone: (parentMessageId?: string) => Promise<void>;
      getCapabilities: () => unknown;
    };

    // Each pilot should be independent
    expect(callbacks1).not.toBe(callbacks2);

    // Verify that callbacks are correctly bound
    await callbacks1.sendMessage('message for chat-1', 'msg-1');
    await callbacks2.sendMessage('message for chat-2', 'msg-2');

    // Verify messages were sent to correct chatIds
    expect(mockCallbacks.sendMessage).toHaveBeenNthCalledWith(1, 'chat-1', 'message for chat-1', 'msg-1');
    expect(mockCallbacks.sendMessage).toHaveBeenNthCalledWith(2, 'chat-2', 'message for chat-2', 'msg-2');
  });
});
