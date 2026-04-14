/**
 * IPC Transport abstraction for dependency injection.
 *
 * Allows replacing Unix socket communication with in-memory
 * transport for testing, following the ACP MockTransport pattern (Issue #2352).
 *
 * @module ipc/transport
 */

// ============================================================================
// IIpcTransport Interface
// ============================================================================

/**
 * Bidirectional transport for IPC message exchange.
 *
 * Abstracts the underlying communication mechanism (Unix socket, in-memory, etc.)
 * to enable dependency injection and testing without filesystem side effects.
 */
export interface IIpcTransport {
  /** Send data through the transport */
  write(data: string): void;
  /** Register handler for incoming data */
  onData(handler: (data: string) => void): void;
  /** Register handler for transport close */
  onClose(handler: () => void): void;
  /** Destroy the transport and release resources */
  destroy(): void;
}

// ============================================================================
// In-Memory Transport (for testing)
// ============================================================================

/**
 * Create a pair of connected in-memory IPC transports.
 *
 * Data written to one transport appears on the other's data handler,
 * enabling zero-filesystem IPC testing.
 *
 * @returns A pair of connected transports (server side and client side)
 */
export function createInMemoryTransportPair(): {
  /** Transport for the server side (receives requests, sends responses) */
  serverTransport: IIpcTransport;
  /** Transport for the client side (sends requests, receives responses) */
  clientTransport: IIpcTransport;
} {
  let serverDataHandler: ((data: string) => void) | undefined;
  let clientDataHandler: ((data: string) => void) | undefined;
  let serverCloseHandler: (() => void) | undefined;
  let clientCloseHandler: (() => void) | undefined;

  const serverTransport: IIpcTransport = {
    write(data: string) {
      // Server writing → client receives
      clientDataHandler?.(data);
    },
    onData(handler: (data: string) => void) {
      serverDataHandler = handler;
    },
    onClose(handler: () => void) {
      serverCloseHandler = handler;
    },
    destroy() {
      // Notify the other side that this transport closed
      clientCloseHandler?.();
    },
  };

  const clientTransport: IIpcTransport = {
    write(data: string) {
      // Client writing → server receives
      serverDataHandler?.(data);
    },
    onData(handler: (data: string) => void) {
      clientDataHandler = handler;
    },
    onClose(handler: () => void) {
      clientCloseHandler = handler;
    },
    destroy() {
      // Notify the other side that this transport closed
      serverCloseHandler?.();
    },
  };

  return { serverTransport, clientTransport };
}
