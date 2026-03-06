/**
 * ExecNodeRegistry - Manages execution node registration and routing.
 *
 * Extracts execution node management concerns from PrimaryNode:
 * - Local and remote node registration
 * - Chat-to-node routing
 * - Node lifecycle (register, unregister, reassign)
 *
 * Architecture:
 * ```
 * PrimaryNode → ExecNodeRegistry → { local node, remote workers }
 *                        ↓
 *                 Chat-to-node assignment
 * ```
 */

import { WebSocket } from 'ws';
import { EventEmitter } from 'events';
import { createLogger } from '../utils/logger.js';
import type { ExecNodeInfo } from './types.js';
import type { RegisterMessage } from '../types/websocket-messages.js';

const logger = createLogger('ExecNodeRegistry');

/**
 * Internal representation of a connected execution node.
 */
export interface ConnectedExecNode {
  ws?: WebSocket;
  nodeId: string;
  name: string;
  connectedAt: Date;
  clientIp?: string;
  isLocal: boolean;
}

/**
 * Configuration for ExecNodeRegistry.
 */
export interface ExecNodeRegistryConfig {
  /** Local node ID */
  localNodeId: string;
  /** Whether local execution is enabled */
  localExecEnabled: boolean;
}

/**
 * ExecNodeRegistry - Manages execution node lifecycle and routing.
 *
 * Handles:
 * - Local execution node registration
 * - Remote worker node registration/unregistration
 * - Chat-to-node assignment and routing
 * - Node failover and reassignment
 */
export class ExecNodeRegistry extends EventEmitter {
  private readonly localNodeId: string;
  private readonly localExecEnabled: boolean;
  private readonly execNodes: Map<string, ConnectedExecNode> = new Map();
  private readonly chatToNode: Map<string, string> = new Map();

  constructor(config: ExecNodeRegistryConfig) {
    super();
    this.localNodeId = config.localNodeId;
    this.localExecEnabled = config.localExecEnabled;
  }

  /**
   * Register the local execution node.
   */
  registerLocalNode(): void {
    if (!this.localExecEnabled) {
      return;
    }

    this.execNodes.set(this.localNodeId, {
      nodeId: this.localNodeId,
      name: 'Local Execution',
      connectedAt: new Date(),
      isLocal: true,
    });

    logger.info({ nodeId: this.localNodeId }, 'Local execution capability registered');
  }

  /**
   * Register a remote execution node.
   */
  registerNode(ws: WebSocket, msg: RegisterMessage, clientIp?: string): string {
    const { nodeId, name } = msg;

    // Close existing connection with same nodeId if exists
    const existing = this.execNodes.get(nodeId);
    if (existing && existing.ws) {
      logger.warn({ nodeId }, 'Closing existing connection for nodeId');
      existing.ws.close();
      this.execNodes.delete(nodeId);
    }

    // Register the new node
    this.execNodes.set(nodeId, {
      ws,
      nodeId,
      name: name || `Worker-${nodeId.slice(0, 8)}`,
      connectedAt: new Date(),
      clientIp,
      isLocal: false,
    });

    logger.info({ nodeId, name: msg.name, clientIp, totalNodes: this.execNodes.size }, 'Worker Node registered');
    this.emit('node:registered', nodeId);

    return nodeId;
  }

  /**
   * Unregister a remote execution node.
   */
  unregisterNode(nodeId: string): void {
    const node = this.execNodes.get(nodeId);
    if (!node || node.isLocal) {
      return;
    }

    this.execNodes.delete(nodeId);
    logger.info({ nodeId, totalNodes: this.execNodes.size }, 'Worker Node unregistered');

    // Reassign chats that were using this node
    const chatsToReassign: string[] = [];
    for (const [chatId, assignedNodeId] of this.chatToNode) {
      if (assignedNodeId === nodeId) {
        chatsToReassign.push(chatId);
      }
    }

    // Try to reassign to another available node
    const availableNode = this.getFirstAvailableNode();
    for (const chatId of chatsToReassign) {
      if (availableNode) {
        this.chatToNode.set(chatId, availableNode.nodeId);
        logger.info({ chatId, oldNode: nodeId, newNode: availableNode.nodeId }, 'Reassigned chat to available node');
      } else {
        this.chatToNode.delete(chatId);
        logger.warn({ chatId, oldNode: nodeId }, 'No available node to reassign chat');
      }
    }

    this.emit('node:unregistered', nodeId);
  }

  /**
   * Get the first available execution node.
   * Prefers local execution if available (lower latency).
   */
  getFirstAvailableNode(): ConnectedExecNode | undefined {
    // Prefer local execution
    const localNode = this.execNodes.get(this.localNodeId);
    if (localNode && this.localExecEnabled) {
      return localNode;
    }

    // Fall back to remote nodes
    for (const node of this.execNodes.values()) {
      if (!node.isLocal && node.ws && node.ws.readyState === WebSocket.OPEN) {
        return node;
      }
    }
    return undefined;
  }

  /**
   * Get the execution node assigned to a chat, or assign the first available one.
   */
  getNodeForChat(chatId: string): ConnectedExecNode | undefined {
    // Check if chat already has an assigned node
    const assignedNodeId = this.chatToNode.get(chatId);
    if (assignedNodeId) {
      const node = this.execNodes.get(assignedNodeId);
      if (node) {
        // For local node, just return it
        if (node.isLocal && this.localExecEnabled) {
          return node;
        }
        // For remote node, check connection
        if (node.ws && node.ws.readyState === WebSocket.OPEN) {
          return node;
        }
      }
    }

    // Assign first available node
    const availableNode = this.getFirstAvailableNode();
    if (availableNode) {
      this.chatToNode.set(chatId, availableNode.nodeId);
      logger.info({ chatId, nodeId: availableNode.nodeId, isLocal: availableNode.isLocal }, 'Assigned chat to execution node');
    } else {
      logger.warn({ chatId }, 'No available execution node found');
    }
    return availableNode;
  }

  /**
   * Switch a chat to a specific execution node.
   */
  switchChatNode(chatId: string, targetNodeId: string): boolean {
    const targetNode = this.execNodes.get(targetNodeId);
    if (!targetNode) {
      logger.warn({ chatId, targetNodeId }, 'Target node not found');
      return false;
    }

    // For local node, just assign
    if (targetNode.isLocal) {
      this.chatToNode.set(chatId, targetNodeId);
      logger.info({ chatId, newNode: targetNodeId }, 'Switched chat to local execution');
      return true;
    }

    // For remote node, check connection
    if (!targetNode.ws || targetNode.ws.readyState !== WebSocket.OPEN) {
      logger.warn({ chatId, targetNodeId }, 'Target node not available for switch');
      return false;
    }

    const previousNodeId = this.chatToNode.get(chatId);
    this.chatToNode.set(chatId, targetNodeId);
    logger.info({ chatId, previousNode: previousNodeId, newNode: targetNodeId }, 'Switched chat to new execution node');
    return true;
  }

  /**
   * Get list of all execution nodes (local + remote).
   */
  getNodes(): ExecNodeInfo[] {
    const result: ExecNodeInfo[] = [];
    for (const [nodeId, node] of this.execNodes) {
      // Count active chats for this node
      let activeChats = 0;
      for (const assignedNodeId of this.chatToNode.values()) {
        if (assignedNodeId === nodeId) {
          activeChats++;
        }
      }

      result.push({
        nodeId,
        name: node.name,
        status: node.isLocal ? 'connected' :
          (node.ws && node.ws.readyState === WebSocket.OPEN ? 'connected' : 'disconnected'),
        activeChats,
        connectedAt: node.connectedAt,
        isLocal: node.isLocal,
      });
    }
    return result;
  }

  /**
   * Get the node assignment for a specific chat.
   */
  getChatNodeAssignment(chatId: string): string | undefined {
    return this.chatToNode.get(chatId);
  }

  /**
   * Get a specific node by ID.
   */
  getNode(nodeId: string): ConnectedExecNode | undefined {
    return this.execNodes.get(nodeId);
  }

  /**
   * Check if a remote node is connected.
   * Issue #935: Used by CardActionRouter to check node availability.
   */
  isNodeConnected(nodeId: string): boolean {
    const node = this.execNodes.get(nodeId);
    if (!node) {
      return false;
    }
    // Local node is always "connected" if enabled
    if (node.isLocal) {
      return this.localExecEnabled;
    }
    // Remote node is connected if WebSocket is open
    return node.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Get the local node ID.
   */
  getLocalNodeId(): string {
    return this.localNodeId;
  }

  /**
   * Check if local execution is enabled.
   */
  isLocalExecEnabled(): boolean {
    return this.localExecEnabled;
  }

  /**
   * Check if there are any available execution nodes.
   */
  hasAvailableNode(): boolean {
    return this.getFirstAvailableNode() !== undefined;
  }

  /**
   * Clear all nodes and assignments.
   * Used during shutdown.
   */
  clear(): void {
    // Close all remote connections
    for (const [nodeId, node] of this.execNodes) {
      if (!node.isLocal && node.ws) {
        try {
          node.ws.close();
          logger.info({ nodeId }, 'Worker Node connection closed');
        } catch (error) {
          logger.error({ err: error, nodeId }, 'Failed to close Worker Node connection');
        }
      }
    }

    this.execNodes.clear();
    this.chatToNode.clear();
    logger.info('All execution nodes cleared');
  }
}
