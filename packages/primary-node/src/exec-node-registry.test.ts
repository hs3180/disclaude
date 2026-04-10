/**
 * Tests for ExecNodeRegistry.
 *
 * Tests the execution node registration, routing, and lifecycle management.
 */

 

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { ExecNodeRegistry } from './exec-node-registry.js';

// Mock WebSocket
function createMockWebSocket(): any {
  return {
    readyState: 1, // WebSocket.OPEN
    close: vi.fn(),
    send: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  };
}

// Create mock logger with hoisted definition
const mockLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  trace: vi.fn(),
}));

vi.mock('@disclaude/core', () => ({
  createLogger: vi.fn(() => mockLogger),
}));

describe('ExecNodeRegistry', () => {
  let registry: ExecNodeRegistry;

  beforeEach(() => {
    vi.clearAllMocks();
    registry = new ExecNodeRegistry({
      localNodeId: 'local-node-1',
      localExecEnabled: true,
    });
  });

  afterEach(() => {
    registry.clear();
  });

  describe('constructor', () => {
    it('should create instance with correct config', () => {
      expect(registry).toBeInstanceOf(EventEmitter);
      expect(registry.getLocalNodeId()).toBe('local-node-1');
      expect(registry.isLocalExecEnabled()).toBe(true);
    });
  });

  describe('registerLocalNode()', () => {
    it('should register local execution node when enabled', () => {
      registry.registerLocalNode();

      const nodes = registry.getNodes();
      expect(nodes).toHaveLength(1);
      expect(nodes[0].nodeId).toBe('local-node-1');
      expect(nodes[0].isLocal).toBe(true);
      expect(nodes[0].name).toBe('Local Execution');
    });

    it('should not register local node when disabled', () => {
      const disabledRegistry = new ExecNodeRegistry({
        localNodeId: 'local-node-1',
        localExecEnabled: false,
      });

      disabledRegistry.registerLocalNode();
      expect(disabledRegistry.getNodes()).toHaveLength(0);
    });
  });

  describe('registerNode()', () => {
    it('should register a remote worker node', () => {
      const ws = createMockWebSocket();
      const nodeId = registry.registerNode(ws, {
        type: 'register',
        nodeId: 'worker-1',
        name: 'Test Worker',
      });

      expect(nodeId).toBe('worker-1');
      const nodes = registry.getNodes();
      expect(nodes).toHaveLength(1);
      expect(nodes[0].nodeId).toBe('worker-1');
      expect(nodes[0].isLocal).toBe(false);
    });

    it('should emit node:registered event', () => {
      const ws = createMockWebSocket();
      const handler = vi.fn();
      registry.on('node:registered', handler);

      registry.registerNode(ws, {
        type: 'register',
        nodeId: 'worker-1',
        name: 'Test Worker',
      });

      expect(handler).toHaveBeenCalledWith('worker-1');
    });

    it('should close existing connection with same nodeId before registering new one', () => {
      const oldWs = createMockWebSocket();
      const newWs = createMockWebSocket();

      // Register first connection
      registry.registerNode(oldWs, {
        type: 'register',
        nodeId: 'worker-1',
        name: 'Old Worker',
      });

      // Register second connection with same nodeId
      registry.registerNode(newWs, {
        type: 'register',
        nodeId: 'worker-1',
        name: 'New Worker',
      });

      // Old connection should be closed
      expect(oldWs.close).toHaveBeenCalled();

      // New connection should be registered
      const nodes = registry.getNodes();
      expect(nodes).toHaveLength(1);
      expect(nodes[0].name).toBe('New Worker');
    });

    it('should generate default name if not provided', () => {
      const ws = createMockWebSocket();
      registry.registerNode(ws, {
        type: 'register',
        nodeId: 'abc123def456',
      });

      const nodes = registry.getNodes();
      expect(nodes[0].name).toBe('Worker-abc123de');
    });
  });

  describe('unregisterNode()', () => {
    it('should unregister a remote node', () => {
      const ws = createMockWebSocket();
      registry.registerNode(ws, {
        type: 'register',
        nodeId: 'worker-1',
        name: 'Test Worker',
      });

      registry.unregisterNode('worker-1');

      expect(registry.getNodes()).toHaveLength(0);
    });

    it('should emit node:unregistered event', () => {
      const ws = createMockWebSocket();
      const handler = vi.fn();
      registry.on('node:unregistered', handler);

      registry.registerNode(ws, {
        type: 'register',
        nodeId: 'worker-1',
        name: 'Test Worker',
      });

      registry.unregisterNode('worker-1');
      expect(handler).toHaveBeenCalledWith('worker-1');
    });

    it('should not unregister local node', () => {
      registry.registerLocalNode();
      registry.unregisterNode('local-node-1');

      // Local node should still exist
      expect(registry.getNodes()).toHaveLength(1);
    });

    it('should reassign chats to available node when node is unregistered', () => {
      // Register local node first
      registry.registerLocalNode();

      const ws = createMockWebSocket();
      registry.registerNode(ws, {
        type: 'register',
        nodeId: 'worker-1',
        name: 'Test Worker',
      });

      // Assign a chat to worker-1
      registry.getNodeForChat('chat-1');
      expect(registry.getChatNodeAssignment('chat-1')).toBe('local-node-1'); // Prefers local

      // Now test with a registry that doesn't have local exec
      const remoteOnlyRegistry = new ExecNodeRegistry({
        localNodeId: 'local-node-1',
        localExecEnabled: false,
      });

      const ws2 = createMockWebSocket();
      remoteOnlyRegistry.registerNode(ws2, {
        type: 'register',
        nodeId: 'worker-2',
        name: 'Remote Worker',
      });

      // Assign chat to remote worker
      remoteOnlyRegistry.getNodeForChat('chat-2');
      expect(remoteOnlyRegistry.getChatNodeAssignment('chat-2')).toBe('worker-2');

      // Unregister worker - chat should be reassigned (but no other node available)
      remoteOnlyRegistry.unregisterNode('worker-2');
      expect(remoteOnlyRegistry.getChatNodeAssignment('chat-2')).toBeUndefined();
    });
  });

  describe('getFirstAvailableNode()', () => {
    it('should prefer local node when available', () => {
      registry.registerLocalNode();

      const ws = createMockWebSocket();
      registry.registerNode(ws, {
        type: 'register',
        nodeId: 'worker-1',
        name: 'Test Worker',
      });

      const node = registry.getFirstAvailableNode();
      expect(node?.isLocal).toBe(true);
    });

    it('should fall back to remote node when local not available', () => {
      const ws = createMockWebSocket();
      registry.registerNode(ws, {
        type: 'register',
        nodeId: 'worker-1',
        name: 'Test Worker',
      });

      const node = registry.getFirstAvailableNode();
      expect(node?.isLocal).toBe(false);
      expect(node?.nodeId).toBe('worker-1');
    });

    it('should return undefined when no nodes available', () => {
      const emptyRegistry = new ExecNodeRegistry({
        localNodeId: 'local-node-1',
        localExecEnabled: false,
      });

      expect(emptyRegistry.getFirstAvailableNode()).toBeUndefined();
    });

    it('should skip disconnected remote nodes', () => {
      const ws = createMockWebSocket();
      ws.readyState = 0; // WebSocket.CONNECTING

      registry.registerNode(ws, {
        type: 'register',
        nodeId: 'worker-1',
        name: 'Test Worker',
      });

      expect(registry.getFirstAvailableNode()).toBeUndefined();
    });
  });

  describe('getNodeForChat()', () => {
    it('should assign first available node to new chat', () => {
      registry.registerLocalNode();

      const node = registry.getNodeForChat('chat-1');
      expect(node?.nodeId).toBe('local-node-1');
      expect(registry.getChatNodeAssignment('chat-1')).toBe('local-node-1');
    });

    it('should return existing assignment for chat', () => {
      registry.registerLocalNode();

      // First call assigns the node
      registry.getNodeForChat('chat-1');

      // Second call should return same assignment
      const node = registry.getNodeForChat('chat-1');
      expect(node?.nodeId).toBe('local-node-1');
    });

    it('should reassign when assigned node is disconnected', () => {
      const ws1 = createMockWebSocket();
      const ws2 = createMockWebSocket();

      // Create registry without local exec
      const remoteRegistry = new ExecNodeRegistry({
        localNodeId: 'local-node-1',
        localExecEnabled: false,
      });

      remoteRegistry.registerNode(ws1, {
        type: 'register',
        nodeId: 'worker-1',
        name: 'Worker 1',
      });

      remoteRegistry.registerNode(ws2, {
        type: 'register',
        nodeId: 'worker-2',
        name: 'Worker 2',
      });

      // Assign to worker-1
      remoteRegistry.getNodeForChat('chat-1');
      expect(remoteRegistry.getChatNodeAssignment('chat-1')).toBe('worker-1');

      // Disconnect worker-1
      ws1.readyState = 0; // Not OPEN

      // Next call should reassign
      const node = remoteRegistry.getNodeForChat('chat-1');
      expect(node?.nodeId).toBe('worker-2');
    });
  });

  describe('switchChatNode()', () => {
    it('should switch chat to specified node', () => {
      const ws = createMockWebSocket();
      registry.registerNode(ws, {
        type: 'register',
        nodeId: 'worker-1',
        name: 'Test Worker',
      });

      const result = registry.switchChatNode('chat-1', 'worker-1');
      expect(result).toBe(true);
      expect(registry.getChatNodeAssignment('chat-1')).toBe('worker-1');
    });

    it('should return false for non-existent node', () => {
      const result = registry.switchChatNode('chat-1', 'non-existent');
      expect(result).toBe(false);
    });

    it('should return false for disconnected remote node', () => {
      const ws = createMockWebSocket();
      ws.readyState = 0; // Not OPEN

      registry.registerNode(ws, {
        type: 'register',
        nodeId: 'worker-1',
        name: 'Test Worker',
      });

      const result = registry.switchChatNode('chat-1', 'worker-1');
      expect(result).toBe(false);
    });

    it('should always allow switch to local node', () => {
      registry.registerLocalNode();

      const result = registry.switchChatNode('chat-1', 'local-node-1');
      expect(result).toBe(true);
    });
  });

  describe('isNodeConnected()', () => {
    it('should return true for connected local node', () => {
      registry.registerLocalNode();
      expect(registry.isNodeConnected('local-node-1')).toBe(true);
    });

    it('should return false for local node when disabled', () => {
      const disabledRegistry = new ExecNodeRegistry({
        localNodeId: 'local-node-1',
        localExecEnabled: false,
      });
      disabledRegistry.registerLocalNode();
      expect(disabledRegistry.isNodeConnected('local-node-1')).toBe(false);
    });

    it('should return true for connected remote node', () => {
      const ws = createMockWebSocket();
      registry.registerNode(ws, {
        type: 'register',
        nodeId: 'worker-1',
        name: 'Test Worker',
      });

      expect(registry.isNodeConnected('worker-1')).toBe(true);
    });

    it('should return false for disconnected remote node', () => {
      const ws = createMockWebSocket();
      ws.readyState = 0;

      registry.registerNode(ws, {
        type: 'register',
        nodeId: 'worker-1',
        name: 'Test Worker',
      });

      expect(registry.isNodeConnected('worker-1')).toBe(false);
    });

    it('should return false for non-existent node', () => {
      expect(registry.isNodeConnected('non-existent')).toBe(false);
    });
  });

  describe('getNodes()', () => {
    it('should return all nodes with correct info', () => {
      registry.registerLocalNode();

      const ws = createMockWebSocket();
      registry.registerNode(ws, {
        type: 'register',
        nodeId: 'worker-1',
        name: 'Test Worker',
      });

      // Assign a chat to worker
      const remoteRegistry = new ExecNodeRegistry({
        localNodeId: 'local-node-1',
        localExecEnabled: false,
      });
      remoteRegistry.registerNode(ws, {
        type: 'register',
        nodeId: 'worker-1',
        name: 'Test Worker',
      });
      remoteRegistry.getNodeForChat('chat-1');

      const nodes = remoteRegistry.getNodes();
      expect(nodes).toHaveLength(1);
      expect(nodes[0].activeChats).toBe(1);
    });
  });

  describe('hasAvailableNode()', () => {
    it('should return true when nodes available', () => {
      registry.registerLocalNode();
      expect(registry.hasAvailableNode()).toBe(true);
    });

    it('should return false when no nodes available', () => {
      const emptyRegistry = new ExecNodeRegistry({
        localNodeId: 'local-node-1',
        localExecEnabled: false,
      });
      expect(emptyRegistry.hasAvailableNode()).toBe(false);
    });
  });

  describe('clear()', () => {
    it('should close all remote connections and clear maps', () => {
      registry.registerLocalNode();

      const ws = createMockWebSocket();
      registry.registerNode(ws, {
        type: 'register',
        nodeId: 'worker-1',
        name: 'Test Worker',
      });

      registry.getNodeForChat('chat-1');
      registry.clear();

      expect(ws.close).toHaveBeenCalled();
      expect(registry.getNodes()).toHaveLength(0);
      expect(registry.getChatNodeAssignment('chat-1')).toBeUndefined();
    });
  });
});
