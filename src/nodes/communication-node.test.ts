/**
 * Tests for CommunicationNode multi-execution node support.
 *
 * Issue #38: Multi-execution node support
 * Issue #241: Refactored to use ExecNodeManager and ChannelManager
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebSocket } from 'ws';

// Mock the dependencies
vi.mock('../config/index.js', () => ({
  Config: {
    FEISHU_APP_ID: undefined,
    FEISHU_APP_SECRET: undefined,
    getWorkspaceDir: () => '/tmp/test-workspace',
    getTransportConfig: () => ({}),
    getChannelsConfig: () => ({ rest: { enabled: false } }),
  },
}));

vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// We need to import CommunicationNode after mocking
import { CommunicationNode } from './communication-node.js';

describe('CommunicationNode Multi-Execution Node Support', () => {
  describe('Without starting server', () => {
    it('getExecNodes() should return empty array initially', () => {
      const commNode = new CommunicationNode({
        port: 3101,
        host: '127.0.0.1',
        enableRestChannel: false,
        appId: undefined,
        appSecret: undefined,
      });
      const nodes = commNode.getExecNodes();
      expect(nodes).toEqual([]);
    });

    it('getChatNodeAssignment() should return undefined when no assignment exists', () => {
      const commNode = new CommunicationNode({
        port: 3102,
        host: '127.0.0.1',
        enableRestChannel: false,
        appId: undefined,
        appSecret: undefined,
      });
      const assignment = commNode.getChatNodeAssignment('test-chat-1');
      expect(assignment).toBeUndefined();
    });

    it('switchChatNode() should return false when target node does not exist', () => {
      const commNode = new CommunicationNode({
        port: 3103,
        host: '127.0.0.1',
        enableRestChannel: false,
        appId: undefined,
        appSecret: undefined,
      });
      const result = commNode.switchChatNode('test-chat-1', 'non-existent-node');
      expect(result).toBe(false);
    });
  });

  describe('Control Commands', () => {
    let commNode: CommunicationNode;

    beforeEach(() => {
      commNode = new CommunicationNode({
        port: 3104,
        host: '127.0.0.1',
        enableRestChannel: false,
        appId: undefined,
        appSecret: undefined,
      });
    });

    it('should handle list-nodes command with no nodes', async () => {
      const response = await (commNode as any).handleControlCommand({
        type: 'list-nodes',
        chatId: 'test-chat-1',
      });

      expect(response.success).toBe(true);
      expect(response.message).toContain('暂无连接的执行节点');
    });

    it('should handle status command', async () => {
      const response = await (commNode as any).handleControlCommand({
        type: 'status',
        chatId: 'test-chat-1',
      });

      expect(response.success).toBe(true);
      expect(response.message).toContain('状态');
      expect(response.message).toContain('未分配');
    });

    it('should handle switch-node command without targetNodeId', async () => {
      const response = await (commNode as any).handleControlCommand({
        type: 'switch-node',
        chatId: 'test-chat-1',
      });

      expect(response.success).toBe(false);
      expect(response.error).toContain('请指定目标节点ID');
    });

    it('should handle switch-node command with non-existent targetNodeId', async () => {
      const response = await (commNode as any).handleControlCommand({
        type: 'switch-node',
        chatId: 'test-chat-1',
        targetNodeId: 'non-existent-node',
      });

      expect(response.success).toBe(false);
      expect(response.error).toContain('切换失败');
    });
  });

  describe('ExecNodeManager Integration', () => {
    let commNode: CommunicationNode;
    let execNodeManager: any;

    beforeEach(() => {
      commNode = new CommunicationNode({
        port: 3105,
        host: '127.0.0.1',
        enableRestChannel: false,
        appId: undefined,
        appSecret: undefined,
      });
      execNodeManager = (commNode as any).execNodeManager;
    });

    it('registerExecNode should add node to execNodes map', () => {
      const mockWs = { readyState: WebSocket.OPEN } as WebSocket;
      const nodeId = execNodeManager.register(
        mockWs,
        { type: 'register', nodeId: 'test-node-1', name: 'Test Node' },
        '127.0.0.1'
      );

      expect(nodeId).toBe('test-node-1');
      const nodes = commNode.getExecNodes();
      expect(nodes.length).toBe(1);
      expect(nodes[0].nodeId).toBe('test-node-1');
      expect(nodes[0].name).toBe('Test Node');
      expect(nodes[0].status).toBe('connected');
    });

    it('registerExecNode should replace existing node with same ID', () => {
      const mockWs1 = { readyState: WebSocket.OPEN, close: vi.fn() } as unknown as WebSocket;
      const mockWs2 = { readyState: WebSocket.OPEN } as WebSocket;

      execNodeManager.register(
        mockWs1,
        { type: 'register', nodeId: 'test-node-1', name: 'Test Node 1' },
        '127.0.0.1'
      );

      execNodeManager.register(
        mockWs2,
        { type: 'register', nodeId: 'test-node-1', name: 'Test Node 2' },
        '127.0.0.1'
      );

      expect((mockWs1 as any).close).toHaveBeenCalled();
      const nodes = commNode.getExecNodes();
      expect(nodes.length).toBe(1);
      expect(nodes[0].name).toBe('Test Node 2');
    });

    it('unregisterExecNode should remove node', () => {
      const mockWs = { readyState: WebSocket.OPEN } as WebSocket;
      execNodeManager.register(
        mockWs,
        { type: 'register', nodeId: 'test-node-1', name: 'Test Node' },
        '127.0.0.1'
      );

      expect(commNode.getExecNodes().length).toBe(1);

      execNodeManager.unregister('test-node-1');

      expect(commNode.getExecNodes().length).toBe(0);
    });

    it('getFirstAvailableNode should return first connected node', () => {
      const mockWs = { readyState: WebSocket.OPEN } as WebSocket;
      execNodeManager.register(
        mockWs,
        { type: 'register', nodeId: 'test-node-1', name: 'Test Node' },
        '127.0.0.1'
      );

      const node = execNodeManager.getFirstAvailable();
      expect(node).toBeDefined();
      expect(node.nodeId).toBe('test-node-1');
    });

    it('getFirstAvailableNode should return undefined when no nodes connected', () => {
      const node = execNodeManager.getFirstAvailable();
      expect(node).toBeUndefined();
    });

    it('getExecNodeForChat should assign first available node to chat', () => {
      const mockWs = { readyState: WebSocket.OPEN } as WebSocket;
      execNodeManager.register(
        mockWs,
        { type: 'register', nodeId: 'test-node-1', name: 'Test Node' },
        '127.0.0.1'
      );

      const node = execNodeManager.getForChat('chat-1');
      expect(node).toBeDefined();
      expect(node.nodeId).toBe('test-node-1');
      expect(commNode.getChatNodeAssignment('chat-1')).toBe('test-node-1');
    });

    it('getExecNodeForChat should return existing assignment if available', () => {
      const mockWs1 = { readyState: WebSocket.OPEN } as WebSocket;
      const mockWs2 = { readyState: WebSocket.OPEN } as WebSocket;

      execNodeManager.register(
        mockWs1,
        { type: 'register', nodeId: 'node-1', name: 'Node 1' },
        '127.0.0.1'
      );
      execNodeManager.register(
        mockWs2,
        { type: 'register', nodeId: 'node-2', name: 'Node 2' },
        '127.0.0.1'
      );

      // First call assigns to node-1
      execNodeManager.getForChat('chat-1');
      expect(commNode.getChatNodeAssignment('chat-1')).toBe('node-1');

      // Second call should return same assignment
      const node = execNodeManager.getForChat('chat-1');
      expect(node.nodeId).toBe('node-1');
    });

    it('switchChatNode should change chat assignment', () => {
      const mockWs1 = { readyState: WebSocket.OPEN } as WebSocket;
      const mockWs2 = { readyState: WebSocket.OPEN } as WebSocket;

      execNodeManager.register(
        mockWs1,
        { type: 'register', nodeId: 'node-1', name: 'Node 1' },
        '127.0.0.1'
      );
      execNodeManager.register(
        mockWs2,
        { type: 'register', nodeId: 'node-2', name: 'Node 2' },
        '127.0.0.1'
      );

      // Assign to node-1
      execNodeManager.getForChat('chat-1');
      expect(commNode.getChatNodeAssignment('chat-1')).toBe('node-1');

      // Switch to node-2
      const result = commNode.switchChatNode('chat-1', 'node-2');
      expect(result).toBe(true);
      expect(commNode.getChatNodeAssignment('chat-1')).toBe('node-2');
    });

    it('unregisterExecNode should reassign chats to another node', () => {
      const mockWs1 = { readyState: WebSocket.OPEN } as WebSocket;
      const mockWs2 = { readyState: WebSocket.OPEN } as WebSocket;

      execNodeManager.register(
        mockWs1,
        { type: 'register', nodeId: 'node-1', name: 'Node 1' },
        '127.0.0.1'
      );
      execNodeManager.register(
        mockWs2,
        { type: 'register', nodeId: 'node-2', name: 'Node 2' },
        '127.0.0.1'
      );

      // Assign chat to node-1
      execNodeManager.getForChat('chat-1');
      expect(commNode.getChatNodeAssignment('chat-1')).toBe('node-1');

      // Unregister node-1
      execNodeManager.unregister('node-1');

      // Chat should be reassigned to node-2
      expect(commNode.getChatNodeAssignment('chat-1')).toBe('node-2');
    });
  });
});
