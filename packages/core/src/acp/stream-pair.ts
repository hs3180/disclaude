/**
 * In-process ACP Stream Pair
 *
 * 创建一对连接的 ACP Stream，用于在同一进程内的 Agent 和 Client 之间通信。
 * 基于 Web Streams API 的 TransformStream 实现。
 */

import type { Stream } from '@agentclientprotocol/sdk';
import type { AnyMessage } from '@agentclientprotocol/sdk';

/**
 * 创建一对连接的 ACP Stream
 *
 * 返回的 [agentStream, clientStream] 可以分别用于创建
 * AgentSideConnection 和 ClientSideConnection。
 *
 * @example
 * ```typescript
 * const [agentStream, clientStream] = createStreamPair();
 *
 * const agentConn = new AgentSideConnection(
 *   (conn) => new ClaudeAcpAgent(conn),
 *   agentStream
 * );
 *
 * const clientConn = new ClientSideConnection(
 *   (agent) => clientHandler,
 *   clientStream
 * );
 * ```
 */
export function createStreamPair(): [Stream, Stream] {
  // Client → Agent direction
  const clientToAgent = new TransformStream<AnyMessage>();
  // Agent → Client direction
  const agentToClient = new TransformStream<AnyMessage>();

  const agentStream: Stream = {
    writable: agentToClient.writable,  // Agent writes → Client reads
    readable: clientToAgent.readable,   // Agent reads ← Client writes
  };

  const clientStream: Stream = {
    writable: clientToAgent.writable,   // Client writes → Agent reads
    readable: agentToClient.readable,  // Client reads ← Agent writes
  };

  return [agentStream, clientStream];
}

/**
 * 异步消息队列
 *
 * 用于在 ACP session/update 通知处理器和消息消费者之间缓冲消息。
 */
export class AsyncMessageQueue<T> {
  private queue: Array<{ value: T; resolve: () => void }> = [];
  private waitForItem: (() => void) | null = null;
  private closed = false;

  /**
   * 向队列中添加消息
   */
  push(value: T): void {
    if (this.closed) return;
    this.queue.push({ value, resolve: () => {} });
    if (this.waitForItem) {
      this.waitForItem();
      this.waitForItem = null;
    }
  }

  /**
   * 关闭队列
   */
  close(): void {
    this.closed = true;
    if (this.waitForItem) {
      this.waitForItem();
      this.waitForItem = null;
    }
  }

  /**
   * 从队列中取出下一个消息
   *
   * @returns 下一个消息，如果队列已关闭则返回 null
   */
  async next(): Promise<T | null> {
    if (this.queue.length > 0) {
      return this.queue.shift()!.value;
    }

    if (this.closed) {
      return null;
    }

    return new Promise<T | null>((resolve) => {
      this.waitForItem = () => {
        if (this.queue.length > 0) {
          resolve(this.queue.shift()!.value);
        } else if (this.closed) {
          resolve(null);
        }
      };
    });
  }

  /**
   * 清空队列
   */
  clear(): void {
    this.queue = [];
  }
}
