/**
 * IPC Transport layer abstractions for testability.
 *
 * Provides interfaces for the underlying IPC I/O layer,
 * allowing tests to use in-memory implementations instead of
 * real Unix domain sockets.
 *
 * Design follows the ACP MockTransport pattern (packages/core/src/sdk/acp/transport.ts):
 * - Define transport interfaces
 * - Production: socket-based implementations (existing code)
 * - Testing: in-memory implementations (this file)
 *
 * @module core/ipc/transport
 */

// ============================================================================
// Transport Interfaces
// ============================================================================

/**
 * Bidirectional data connection for IPC communication.
 *
 * Represents a single connection between client and server.
 * Data is exchanged as raw strings (NDJSON protocol handled by server/client).
 */
export interface IIpcConnection {
  /** Send raw data to the peer */
  write(data: string): void;
  /** Register handler for data from peer */
  onData(handler: (data: string) => void): void;
  /** Register handler for connection close */
  onClose(handler: () => void): void;
  /** Destroy the connection */
  destroy(): void;
}

/**
 * Server-side transport interface.
 * Accepts incoming connections from clients.
 */
export interface IIpcServerTransport {
  /** Start accepting connections */
  start(): Promise<void>;
  /** Stop accepting connections and close all active connections */
  stop(): Promise<void>;
  /** Register handler for new connections */
  onConnection(handler: (connection: IIpcConnection) => void): void;
  /** Whether the server is listening */
  get listening(): boolean;
}

/**
 * Client-side transport interface.
 * Connects to a server and exchanges data.
 */
export interface IIpcClientTransport {
  /** Connect to the server */
  connect(): Promise<void>;
  /** Send raw data to the server */
  send(data: string): void;
  /** Register handler for data from server */
  onData(handler: (data: string) => void): void;
  /** Register handler for connection close */
  onClose(handler: () => void): void;
  /** Disconnect from the server */
  disconnect(): Promise<void>;
  /** Whether the transport is connected */
  get connected(): boolean;
  /** Check if the server endpoint exists */
  endpointExists(): boolean;
}

// ============================================================================
// In-Memory Implementation
// ============================================================================

/**
 * In-memory bidirectional connection.
 * Data written by one end is synchronously delivered to the peer's handlers.
 */
class InMemoryConnection implements IIpcConnection {
  private dataHandlers: Array<(data: string) => void> = [];
  private closeHandlers: Array<() => void> = [];
  private _destroyed = false;
  private peer: InMemoryConnection | null = null;

  /** Link this connection to its peer (called by factory) */
  setPeer(peer: InMemoryConnection): void {
    this.peer = peer;
  }

  write(data: string): void {
    if (this._destroyed || !this.peer) {return;}
    // Deliver to peer's data handlers
    for (const handler of this.peer.dataHandlers) {
      handler(data);
    }
  }

  onData(handler: (data: string) => void): void {
    this.dataHandlers.push(handler);
  }

  onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }

  destroy(): void {
    if (this._destroyed) {return;}
    this._destroyed = true;
    // Notify peer about close
    const {peer} = this;
    this.peer = null;
    if (peer) {
      for (const handler of peer.closeHandlers) {
        handler();
      }
    }
    this.dataHandlers = [];
    this.closeHandlers = [];
  }
}

/**
 * In-memory server transport for testing.
 *
 * Usage:
 * ```typescript
 * const serverTransport = new InMemoryIpcServerTransport();
 * const clientTransport = new InMemoryIpcClientTransport(serverTransport);
 * ```
 */
export class InMemoryIpcServerTransport implements IIpcServerTransport {
  private _listening = false;
  private connectionHandlers: Array<(connection: IIpcConnection) => void> = [];
  private activeServerConnections: InMemoryConnection[] = [];

  get listening(): boolean {
    return this._listening;
  }

  // eslint-disable-next-line require-await
  async start(): Promise<void> {
    this._listening = true;
  }

  // eslint-disable-next-line require-await
  async stop(): Promise<void> {
    this._listening = false;
    // Destroy all active connections
    for (const conn of this.activeServerConnections) {
      conn.destroy();
    }
    this.activeServerConnections = [];
    this.connectionHandlers = [];
  }

  onConnection(handler: (connection: IIpcConnection) => void): void {
    this.connectionHandlers.push(handler);
  }

  /**
   * Accept a client connection (called by InMemoryIpcClientTransport.connect()).
   * Creates a paired connection and notifies server-side connection handlers.
   * @returns The client-side connection
   */
  acceptConnection(): IIpcConnection {
    const serverConn = new InMemoryConnection();
    const clientConn = new InMemoryConnection();
    serverConn.setPeer(clientConn);
    clientConn.setPeer(serverConn);

    this.activeServerConnections.push(serverConn);

    // Notify server connection handlers
    for (const handler of this.connectionHandlers) {
      handler(serverConn);
    }

    return clientConn;
  }
}

/**
 * In-memory client transport for testing.
 *
 * Connects to an InMemoryIpcServerTransport in the same process.
 */
export class InMemoryIpcClientTransport implements IIpcClientTransport {
  private serverTransport: InMemoryIpcServerTransport;
  private _connected = false;
  private clientConn: IIpcConnection | null = null;
  private dataHandlers: Array<(data: string) => void> = [];
  private closeHandlers: Array<() => void> = [];

  constructor(serverTransport: InMemoryIpcServerTransport) {
    this.serverTransport = serverTransport;
  }

  get connected(): boolean {
    return this._connected;
  }

  // eslint-disable-next-line require-await
  async connect(): Promise<void> {
    if (this._connected) {return;}
    if (!this.serverTransport.listening) {
      throw new Error('IPC server not available');
    }

    this.clientConn = this.serverTransport.acceptConnection();
    this._connected = true;

    // Wire incoming data from server to our handlers
    this.clientConn.onData((data) => {
      for (const handler of this.dataHandlers) {
        handler(data);
      }
    });

    this.clientConn.onClose(() => {
      this._connected = false;
      this.clientConn = null;
      for (const handler of this.closeHandlers) {
        handler();
      }
    });
  }

  send(data: string): void {
    if (!this._connected || !this.clientConn) {
      throw new Error('Not connected');
    }
    this.clientConn.write(data);
  }

  onData(handler: (data: string) => void): void {
    this.dataHandlers.push(handler);
  }

  onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }

  // eslint-disable-next-line require-await
  async disconnect(): Promise<void> {
    if (this.clientConn) {
      this.clientConn.destroy();
      this.clientConn = null;
    }
    this._connected = false;
    this.dataHandlers = [];
    this.closeHandlers = [];
  }

  endpointExists(): boolean {
    return this.serverTransport.listening;
  }
}
