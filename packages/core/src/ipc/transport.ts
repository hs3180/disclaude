/**
 * IPC Transport abstraction for testability.
 *
 * The IPC layer uses a transport-abstraction pattern to decouple
 * connection management from business logic:
 *
 * - `IIpcServerTransport` and `IIpcClientTransport` define the transport contract
 * - `UnixSocketIpcServer`/`UnixSocketIpcClient` provide the production net-based transport
 * - Tests inject `InMemoryIpcTransport` implementations (no filesystem side effects)
 *
 * @module core/ipc/transport
 * @see Issue #2352
 */

// ============================================================================
// Connection Interface
// ============================================================================

/**
 * Minimal abstraction over `net.Socket` for IPC connections.
 *
 * Both `net.Socket` (production) and in-memory connections (tests)
 * satisfy this interface, enabling dependency injection without
 * type-unsafe casts or wrapper classes.
 */
export interface IpcConnectionLike {
  /** Send data to the other end of the connection */
  write(data: string): void;
  /** Forcibly close the connection */
  destroy(): void;
  /** Register an event handler (supports 'data', 'close', 'error') */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, handler: (...args: any[]) => void): void;
  /** Remote address for logging (e.g., socket path or 'in-memory') */
  remoteAddress?: string | undefined;
}

// ============================================================================
// Server Transport Interface
// ============================================================================

/**
 * Abstract interface for an IPC server transport.
 *
 * Implementations handle accepting connections (Unix socket, in-memory, etc.).
 * The server delegates connection handling to this transport while keeping
 * its message processing logic unchanged.
 */
export interface IIpcServerTransport {
  /**
   * Start accepting connections.
   * @param onConnection - Called when a new client connects
   */
  start(onConnection: (conn: IpcConnectionLike) => void): Promise<void>;
  /** Stop accepting connections and close all active ones */
  stop(): Promise<void>;
  /** Whether the transport is currently listening */
  isListening(): boolean;
}

// ============================================================================
// Client Transport Interface
// ============================================================================

/**
 * Callbacks for client transport connection lifecycle events.
 */
export interface IpcClientTransportHandlers {
  /** Called when the connection is established */
  onConnect(): void;
  /** Called when data is received from the server */
  onData(data: string): void;
  /** Called when the connection is closed */
  onClose(): void;
  /** Called when a connection error occurs */
  onError(error: Error): void;
}

/**
 * Abstract interface for an IPC client transport.
 *
 * Implementations handle connecting to the server (Unix socket, in-memory, etc.).
 * The client delegates connection to this transport while keeping
 * its request/response correlation logic unchanged.
 */
export interface IIpcClientTransport {
  /**
   * Connect to the server.
   * @param handlers - Lifecycle event callbacks
   */
  connect(handlers: IpcClientTransportHandlers): Promise<void>;
  /** Send data to the server */
  write(data: string): void;
  /** Forcibly close the connection */
  destroy(): void;
}
