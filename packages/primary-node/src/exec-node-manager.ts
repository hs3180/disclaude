/**
 * ExecNodeManager - Manages execution node connections and routing.
 *
 * This module handles:
 * - Execution node registration and unregistration
 * - Chat-to-node routing with automatic assignment
 * - Node statistics with optimized reverse indexing
 *
 * Part of the PrimaryNode/WorkerNode architecture.
 *
 * @module @disclaude/primary-node
 */

import { WebSocket } from 'ws';
import { EventEmitter } from 'events';
import { createLogger, type RegisterMessage, type ExecNodeInfo } from '@disclaude/core';

const logger = createLogger('ExecNodeManager');

/**
 * Internal representation of a connected execution node.
 */
export interface ConnectedExecNode {
  ws: WebSocket;
  nodeId: string;
  name: string;
  connectedAt: Date;
  clientIp?: string;
}

/**
 * ExecNodeManager - Manages execution node connections and routing.
 *
 * Features:
 * - Registers/unregisters execution nodes
 * - Routes chats to appropriate nodes
 * - Maintains reverse index for O(1) active chat lookup
 * - Auto-reassigns chats when nodes disconnect
 */
export class ExecNodeManager extends EventEmitter {
  private nodes: Map<string, ConnectedExecNode> = new Map();
  private chatToNode: Map<string, string> = new Map();
  // Reverse index: nodeId -> Set of chatIds (for O(1) active chat counting)
  private nodeToChats: Map<string, Set<string>> = new Map();

  /**
   * Register a new execution node.
   * If a node with the same ID exists, close the old connection.
   */
  register(ws: WebSocket, msg: RegisterMessage, clientIp?: string): string {
    const { nodeId, name } = msg;

    // Close existing connection with same nodeId if exists
    const existing = this.nodes.get(nodeId);
    if (existing) {
      logger.warn({ nodeId }, 'Closing existing connection for nodeId');
      existing.ws.close();
      this.nodes.delete(nodeId);
    }

    // Register the new node
    this.nodes.set(nodeId, {
      ws,
      nodeId,
      name: name || `ExecNode-${nodeId.slice(0, 8)}`,
      connectedAt: new Date(),
      clientIp,
    });

    // Initialize reverse index for this node
    if (!this.nodeToChats.has(nodeId)) {
      this.nodeToChats.set(nodeId, new Set());
    }

    logger.info({ nodeId, name: msg.name, clientIp, totalNodes: this.nodes.size }, 'Execution Node registered');
    this.emit('registered', nodeId);

    return nodeId;
  }

  /**
   * Unregister an execution node.
   * Reassigns chats that were assigned to this node to another available node.
   */
  unregister(nodeId: string): void {
    const node = this.nodes.get(nodeId);
    if (!node) {
      return;
    }

    this.nodes.delete(nodeId);
    logger.info({ nodeId, totalNodes: this.nodes.size }, 'Execution Node unregistered');

    // Get chats assigned to this node using reverse index (O(1))
    const chatsToReassign = this.nodeToChats.get(nodeId);
    if (chatsToReassign) {
      // Try to reassign to another available node
      const availableNode = this.getFirstAvailable();

      for (const chatId of chatsToReassign) {
        if (availableNode) {
          this.chatToNode.set(chatId, availableNode.nodeId);
          // Update reverse index for new node
          const newChatsSet = this.nodeToChats.get(availableNode.nodeId);
          if (newChatsSet) {
            newChatsSet.add(chatId);
          }
          logger.info({ chatId, oldNode: nodeId, newNode: availableNode.nodeId }, 'Reassigned chat to available node');
        } else {
          this.chatToNode.delete(chatId);
          logger.warn({ chatId, oldNode: nodeId }, 'No available node to reassign chat');
        }
      }

      // Clear reverse index for disconnected node
      this.nodeToChats.delete(nodeId);
    }

    this.emit('unregistered', nodeId);
  }

  /**
   * Get the first available execution node.
   */
  getFirstAvailable(): ConnectedExecNode | undefined {
    for (const node of this.nodes.values()) {
      if (node.ws.readyState === WebSocket.OPEN) {
        return node;
      }
    }
    return undefined;
  }

  /**
   * Get the execution node assigned to a chat, or assign the first available one.
   */
  getForChat(chatId: string): ConnectedExecNode | undefined {
    // Check if chat already has an assigned node
    const assignedNodeId = this.chatToNode.get(chatId);
    if (assignedNodeId) {
      const node = this.nodes.get(assignedNodeId);
      if (node && node.ws.readyState === WebSocket.OPEN) {
        return node;
      }
      // Assigned node is not available, fall through to assign new one
    }

    // Assign first available node
    const availableNode = this.getFirstAvailable();
    if (availableNode) {
      this.assignChatToNode(chatId, availableNode.nodeId);
      logger.debug({ chatId, nodeId: availableNode.nodeId }, 'Assigned chat to execution node');
    }
    return availableNode;
  }

  /**
   * Assign a chat to a specific node.
   * Updates both forward and reverse indexes.
   */
  private assignChatToNode(chatId: string, nodeId: string): void {
    // Remove from previous node's reverse index if exists
    const previousNodeId = this.chatToNode.get(chatId);
    if (previousNodeId && previousNodeId !== nodeId) {
      const previousChats = this.nodeToChats.get(previousNodeId);
      if (previousChats) {
        previousChats.delete(chatId);
      }
    }

    // Update forward index
    this.chatToNode.set(chatId, nodeId);

    // Update reverse index
    const chatsSet = this.nodeToChats.get(nodeId);
    if (chatsSet) {
      chatsSet.add(chatId);
    } else {
      this.nodeToChats.set(nodeId, new Set([chatId]));
    }
  }

  /**
   * Switch a chat to a specific execution node.
   */
  switchChatNode(chatId: string, targetNodeId: string): boolean {
    const targetNode = this.nodes.get(targetNodeId);
    if (!targetNode || targetNode.ws.readyState !== WebSocket.OPEN) {
      logger.warn({ chatId, targetNodeId }, 'Target node not available for switch');
      return false;
    }

    this.assignChatToNode(chatId, targetNodeId);
    logger.info({ chatId, newNode: targetNodeId }, 'Switched chat to new execution node');
    return true;
  }

  /**
   * Get list of all connected execution nodes with statistics.
   * Uses reverse index for O(n) instead of O(n*m) complexity.
   */
  getStats(): ExecNodeInfo[] {
    const result: ExecNodeInfo[] = [];
    for (const [nodeId, node] of this.nodes) {
      // Get active chat count from reverse index (O(1))
      const activeChats = this.nodeToChats.get(nodeId)?.size || 0;

      result.push({
        nodeId,
        name: node.name,
        status: node.ws.readyState === WebSocket.OPEN ? 'connected' : 'disconnected',
        activeChats,
        connectedAt: node.connectedAt,
      });
    }
    return result;
  }

  /**
   * Get the node assignment for a specific chat.
   */
  getChatAssignment(chatId: string): string | undefined {
    return this.chatToNode.get(chatId);
  }

  /**
   * Get a specific node by ID.
   */
  getNode(nodeId: string): ConnectedExecNode | undefined {
    return this.nodes.get(nodeId);
  }

  /**
   * Get all registered node IDs.
   */
  getNodeIds(): string[] {
    return Array.from(this.nodes.keys());
  }

  /**
   * Get the number of registered nodes.
   */
  size(): number {
    return this.nodes.size;
  }

  /**
   * Clear all nodes and chat assignments.
   */
  clear(): void {
    this.nodes.clear();
    this.chatToNode.clear();
    this.nodeToChats.clear();
  }
}
