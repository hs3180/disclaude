/**
 * Tests for ExecNodeManager.
 *
 * Part of the PrimaryNode/WorkerNode architecture.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebSocket } from 'ws';
import { ExecNodeManager } from './exec-node-manager.js';

// Mock logger from @disclaude/core
vi.mock('@disclaude/core', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('ExecNodeManager', () => {
  let manager: ExecNodeManager;

  beforeEach(() => {
    manager = new ExecNodeManager();
  });

  describe('register()', () => {
    it('should register a new execution node', () => {
      const mockWs = { readyState: WebSocket.OPEN } as WebSocket;
      const nodeId = manager.register(
        mockWs,
        { type: 'register', nodeId: 'node-1', name: 'Test Node' },
        '127.0.0.1'
      );

      expect(nodeId).toBe('node-1');
      expect(manager.size()).toBe(1);
    });

    it('should replace existing node with same ID', () => {
      const mockWs1 = { readyState: WebSocket.OPEN, close: vi.fn() } as unknown as WebSocket;
      const mockWs2 = { readyState: WebSocket.OPEN } as WebSocket;

      manager.register(mockWs1, { type: 'register', nodeId: 'node-1', name: 'Node 1' }, '127.0.0.1');
      manager.register(mockWs2, { type: 'register', nodeId: 'node-1', name: 'Node 2' }, '127.0.0.1');

      expect((mockWs1 as any).close).toHaveBeenCalled();
      expect(manager.size()).toBe(1);
      expect(manager.getNode('node-1')?.name).toBe('Node 2');
    });

    it('should generate default name if not provided', () => {
      const mockWs = { readyState: WebSocket.OPEN } as WebSocket;
      manager.register(mockWs, { type: 'register', nodeId: 'abc123def456', name: undefined }, '127.0.0.1');

      const node = manager.getNode('abc123def456');
      expect(node?.name).toBe('ExecNode-abc123de');
    });

    it('should emit "registered" event', () => {
      const handler = vi.fn();
      manager.on('registered', handler);

      const mockWs = { readyState: WebSocket.OPEN } as WebSocket;
      manager.register(mockWs, { type: 'register', nodeId: 'node-1', name: 'Test' }, '127.0.0.1');

      expect(handler).toHaveBeenCalledWith('node-1');
    });
  });

  describe('unregister()', () => {
    it('should remove a registered node', () => {
      const mockWs = { readyState: WebSocket.OPEN } as WebSocket;
      manager.register(mockWs, { type: 'register', nodeId: 'node-1', name: 'Test' }, '127.0.0.1');

      expect(manager.size()).toBe(1);
      manager.unregister('node-1');
      expect(manager.size()).toBe(0);
    });

    it('should do nothing if node does not exist', () => {
      manager.unregister('non-existent');
      expect(manager.size()).toBe(0);
    });

    it('should reassign chats to another available node', () => {
      const mockWs1 = { readyState: WebSocket.OPEN } as WebSocket;
      const mockWs2 = { readyState: WebSocket.OPEN } as WebSocket;

      manager.register(mockWs1, { type: 'register', nodeId: 'node-1', name: 'Node 1' }, '127.0.0.1');
      manager.register(mockWs2, { type: 'register', nodeId: 'node-2', name: 'Node 2' }, '127.0.0.1');

      // Assign chat to node-1
      manager.getForChat('chat-1');
      expect(manager.getChatAssignment('chat-1')).toBe('node-1');

      // Unregister node-1
      manager.unregister('node-1');

      // Chat should be reassigned to node-2
      expect(manager.getChatAssignment('chat-1')).toBe('node-2');
    });

    it('should emit "unregistered" event', () => {
      const handler = vi.fn();
      manager.on('unregistered', handler);

      const mockWs = { readyState: WebSocket.OPEN } as WebSocket;
      manager.register(mockWs, { type: 'register', nodeId: 'node-1', name: 'Test' }, '127.0.0.1');
      manager.unregister('node-1');

      expect(handler).toHaveBeenCalledWith('node-1');
    });
  });

  describe('getForChat()', () => {
    it('should assign first available node to chat', () => {
      const mockWs = { readyState: WebSocket.OPEN } as WebSocket;
      manager.register(mockWs, { type: 'register', nodeId: 'node-1', name: 'Test' }, '127.0.0.1');

      const node = manager.getForChat('chat-1');
      expect(node).toBeDefined();
      expect(node?.nodeId).toBe('node-1');
      expect(manager.getChatAssignment('chat-1')).toBe('node-1');
    });

    it('should return existing assignment if available', () => {
      const mockWs1 = { readyState: WebSocket.OPEN } as WebSocket;
      const mockWs2 = { readyState: WebSocket.OPEN } as WebSocket;

      manager.register(mockWs1, { type: 'register', nodeId: 'node-1', name: 'Node 1' }, '127.0.0.1');
      manager.register(mockWs2, { type: 'register', nodeId: 'node-2', name: 'Node 2' }, '127.0.0.1');

      manager.getForChat('chat-1');
      expect(manager.getChatAssignment('chat-1')).toBe('node-1');

      const node = manager.getForChat('chat-1');
      expect(node?.nodeId).toBe('node-1');
    });

    it('should return undefined if no nodes available', () => {
      const node = manager.getForChat('chat-1');
      expect(node).toBeUndefined();
    });
  });

  describe('switchChatNode()', () => {
    it('should switch chat to new node', () => {
      const mockWs1 = { readyState: WebSocket.OPEN } as WebSocket;
      const mockWs2 = { readyState: WebSocket.OPEN } as WebSocket;

      manager.register(mockWs1, { type: 'register', nodeId: 'node-1', name: 'Node 1' }, '127.0.0.1');
      manager.register(mockWs2, { type: 'register', nodeId: 'node-2', name: 'Node 2' }, '127.0.0.1');

      manager.getForChat('chat-1');
      expect(manager.getChatAssignment('chat-1')).toBe('node-1');

      const result = manager.switchChatNode('chat-1', 'node-2');
      expect(result).toBe(true);
      expect(manager.getChatAssignment('chat-1')).toBe('node-2');
    });

    it('should return false if target node does not exist', () => {
      const result = manager.switchChatNode('chat-1', 'non-existent');
      expect(result).toBe(false);
    });

    it('should return false if target node is not connected', () => {
      const mockWs = { readyState: WebSocket.CLOSED } as WebSocket;
      manager.register(mockWs, { type: 'register', nodeId: 'node-1', name: 'Test' }, '127.0.0.1');

      const result = manager.switchChatNode('chat-1', 'node-1');
      expect(result).toBe(false);
    });
  });

  describe('getStats()', () => {
    it('should return empty array if no nodes', () => {
      expect(manager.getStats()).toEqual([]);
    });

    it('should return node statistics with active chat counts (O(1) via reverse index)', () => {
      const mockWs = { readyState: WebSocket.OPEN } as WebSocket;
      manager.register(mockWs, { type: 'register', nodeId: 'node-1', name: 'Test' }, '127.0.0.1');

      // Assign multiple chats
      manager.getForChat('chat-1');
      manager.getForChat('chat-2');
      manager.getForChat('chat-3');

      const stats = manager.getStats();
      expect(stats).toHaveLength(1);
      expect(stats[0].nodeId).toBe('node-1');
      expect(stats[0].activeChats).toBe(3);
      expect(stats[0].status).toBe('connected');
    });
  });

  describe('clear()', () => {
    it('should clear all nodes and chat assignments', () => {
      const mockWs = { readyState: WebSocket.OPEN } as WebSocket;
      manager.register(mockWs, { type: 'register', nodeId: 'node-1', name: 'Test' }, '127.0.0.1');
      manager.getForChat('chat-1');

      expect(manager.size()).toBe(1);
      expect(manager.getChatAssignment('chat-1')).toBe('node-1');

      manager.clear();

      expect(manager.size()).toBe(0);
      expect(manager.getChatAssignment('chat-1')).toBeUndefined();
    });
  });
});
