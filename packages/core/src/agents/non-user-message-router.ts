/**
 * NonUserMessageRouter — Routes system-driven messages to project-bound ChatAgents.
 *
 * This router is the core infrastructure for Issue #3329 Phase 1.
 * It looks up the project configuration by projectKey → finds the bound chatId →
 * delivers the message via the registered handler.
 *
 * Architecture:
 * ```
 * Scheduler / A2A / Webhook
 *         │
 *         ▼
 *   NonUserMessage
 *         │
 *         ▼
 *   NonUserMessageRouter
 *         │
 *         ├─ registerProject(config) → Map<projectKey, NonUserProjectConfig>
 *         │
 *         ├─ route(message) → lookup project → handler(chatId, message)
 *         │
 *         └─ enqueue(message) → queue per projectKey → process when idle
 * ```
 *
 * @see Issue #3329 (RFC: NonUserMessage — System-Driven Task Pipeline)
 */

import type {
  NonUserMessage,
  NonUserMessageRouteResult,
  NonUserMessageRouterConfig,
  NonUserMessageRouterLogger,
  NonUserProjectConfig,
} from '../types/non-user-message.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Default Logger
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** No-op logger used when no logger is provided. */
const noopLogger: NonUserMessageRouterLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// NonUserMessageRouter
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Routes NonUserMessages to the appropriate ChatAgent.
 *
 * Workflow:
 * 1. Register projects with `registerProject(config)` — binds projectKey → chatId
 * 2. Route messages with `route(message)` — looks up project, calls handler
 * 3. Enqueue messages with `enqueue(message)` — queues for later processing
 *
 * The router does NOT create or manage ChatAgents directly. Instead, it
 * delegates to a handler function that is responsible for agent interaction
 * (typically calling AgentPool.getOrCreate(chatId) and processMessage()).
 */
export class NonUserMessageRouter {
  private readonly projects = new Map<string, NonUserProjectConfig>();
  private readonly queues = new Map<string, NonUserMessage[]>();
  private readonly processing = new Set<string>();
  private readonly handler: NonUserMessageRouterConfig['handler'];
  private readonly log: NonUserMessageRouterLogger;

  constructor(config: NonUserMessageRouterConfig) {
    this.handler = config.handler;
    this.log = config.logger ?? noopLogger;
  }

  // ───────────────────────────────────────────
  // Project Registration
  // ───────────────────────────────────────────

  /**
   * Register a project configuration.
   *
   * Associates a projectKey with its bound chatId and working directory.
   * This allows the router to resolve projectKey → chatId for message routing.
   *
   * @param config - Project configuration with key, workingDir, and chatId
   * @throws Error if config.key is empty
   */
  registerProject(config: NonUserProjectConfig): void {
    if (!config.key) {
      throw new Error('projectKey cannot be empty');
    }
    if (!config.chatId) {
      throw new Error('chatId cannot be empty');
    }

    this.projects.set(config.key, config);
    this.log.info(
      'Registered project for NonUserMessage routing',
      { projectKey: config.key, chatId: config.chatId }
    );
  }

  /**
   * Unregister a project configuration.
   *
   * Removes the project from the router. Any queued messages for this
   * project will remain in the queue but cannot be routed until the
   * project is re-registered.
   *
   * @param projectKey - Project key to unregister
   * @returns true if the project was registered and removed
   */
  unregisterProject(projectKey: string): boolean {
    const existed = this.projects.delete(projectKey);
    if (existed) {
      this.log.info('Unregistered project from NonUserMessage routing', { projectKey });
    }
    return existed;
  }

  /**
   * Get the configuration for a registered project.
   *
   * @param projectKey - Project key to look up
   * @returns Project configuration or undefined if not registered
   */
  getProject(projectKey: string): NonUserProjectConfig | undefined {
    return this.projects.get(projectKey);
  }

  /**
   * List all registered project keys.
   *
   * @returns Array of registered project keys
   */
  listProjects(): string[] {
    return Array.from(this.projects.keys());
  }

  // ───────────────────────────────────────────
  // Message Routing
  // ───────────────────────────────────────────

  /**
   * Route a NonUserMessage to the appropriate ChatAgent.
   *
   * Looks up the project configuration by projectKey → finds the bound
   * chatId → calls the registered handler with (chatId, message).
   *
   * If the target ChatAgent is currently processing another message
   * (for the same projectKey), the message is queued automatically.
   *
   * @param message - The NonUserMessage to route
   * @returns RouteResult indicating success or failure
   */
  async route(message: NonUserMessage): Promise<NonUserMessageRouteResult> {
    // Validate message
    const validationError = this.validateMessage(message);
    if (validationError) {
      return { ok: false, error: validationError };
    }

    // Look up project
    const project = this.projects.get(message.projectKey);
    if (!project) {
      this.log.warn(
        'No project registered for NonUserMessage',
        { projectKey: message.projectKey, messageId: message.id }
      );
      return {
        ok: false,
        error: `Project "${message.projectKey}" is not registered. Call registerProject() first.`,
      };
    }

    // Check if project is currently processing
    if (this.processing.has(message.projectKey)) {
      this.log.info(
        'Project is busy, enqueueing NonUserMessage',
        { projectKey: message.projectKey, messageId: message.id }
      );
      this.enqueue(message);
      return { ok: true, chatId: project.chatId };
    }

    // Route to handler
    return await this.deliver(project.chatId, message);
  }

  /**
   * Enqueue a message for later processing.
   *
   * If the target ChatAgent is busy processing another message
   * (user or non-user), the message waits in a per-project queue.
   * Messages are ordered by priority (high > normal > low) and
   * then by creation time.
   *
   * @param message - The NonUserMessage to enqueue
   */
  enqueue(message: NonUserMessage): void {
    const validationError = this.validateMessage(message);
    if (validationError) {
      this.log.warn(
        'Invalid NonUserMessage, skipping enqueue',
        { messageId: message.id, error: validationError }
      );
      return;
    }

    let queue = this.queues.get(message.projectKey);
    if (!queue) {
      queue = [];
      this.queues.set(message.projectKey, queue);
    }

    queue.push(message);
    this.log.debug(
      'NonUserMessage enqueued',
      { projectKey: message.projectKey, messageId: message.id, queueSize: queue.length }
    );
  }

  /**
   * Process the next message in the queue for a project.
   *
   * Called after a message delivery completes to process the next
   * queued message (if any).
   *
   * @param projectKey - Project key to process queue for
   * @returns true if a queued message was processed, false if queue was empty
   */
  async processNext(projectKey: string): Promise<boolean> {
    const queue = this.queues.get(projectKey);
    if (!queue || queue.length === 0) {
      this.processing.delete(projectKey);
      return false;
    }

    // Sort by priority (high > normal > low), then by creation time
    const priorityOrder: Record<string, number> = { high: 0, normal: 1, low: 2 };
    queue.sort((a, b) => {
      const pa = priorityOrder[a.priority] ?? 1;
      const pb = priorityOrder[b.priority] ?? 1;
      if (pa !== pb) { return pa - pb; }
      return a.createdAt.localeCompare(b.createdAt);
    });

    const next = queue.shift();
    if (!next) {
      this.processing.delete(projectKey);
      return false;
    }
    const project = this.projects.get(projectKey);
    if (!project) {
      this.processing.delete(projectKey);
      return false;
    }
    try {
      await this.deliver(project.chatId, next);
    } catch {
      // Log error but continue processing queue
    }
    return true;
  }

  /**
   * Get the queue size for a project.
   *
   * @param projectKey - Project key
   * @returns Number of queued messages
   */
  getQueueSize(projectKey: string): number {
    return this.queues.get(projectKey)?.length ?? 0;
  }

  /**
   * Clear the queue for a project.
   *
   * @param projectKey - Project key
   * @returns Number of messages cleared
   */
  clearQueue(projectKey: string): number {
    const queue = this.queues.get(projectKey);
    if (!queue) { return 0; }
    const count = queue.length;
    queue.length = 0;
    this.queues.delete(projectKey);
    return count;
  }

  // ───────────────────────────────────────────
  // Internal Methods
  // ───────────────────────────────────────────

  /**
   * Deliver a message to the handler.
   *
   * Marks the project as processing, calls the handler, then
   * automatically processes the next queued message.
   */
  private async deliver(
    chatId: string,
    message: NonUserMessage
  ): Promise<NonUserMessageRouteResult> {
    this.processing.add(message.projectKey);
    this.log.info(
      'Delivering NonUserMessage to ChatAgent',
      { projectKey: message.projectKey, chatId, messageId: message.id, type: message.type }
    );

    try {
      await this.handler(chatId, message);

      this.log.info(
        'NonUserMessage delivered successfully',
        { projectKey: message.projectKey, messageId: message.id }
      );

      // Process next queued message (fire-and-forget to avoid blocking)
      this.processNext(message.projectKey).catch(() => {});

      return { ok: true, chatId };
    } catch (err) {
      this.log.error(
        'Failed to deliver NonUserMessage',
        {
          projectKey: message.projectKey,
          messageId: message.id,
          error: err instanceof Error ? err.message : String(err),
        }
      );

      // Still process next queued message on failure
      this.processNext(message.projectKey).catch(() => {});

      return {
        ok: false,
        error: `Handler failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    } finally {
      // Only remove from processing if queue is empty
      // (processNext will handle removal when queue drains)
      const queue = this.queues.get(message.projectKey);
      if (!queue || queue.length === 0) {
        this.processing.delete(message.projectKey);
      }
    }
  }

  /**
   * Validate a NonUserMessage.
   *
   * @param message - Message to validate
   * @returns Error message string, or null if valid
   */
  private validateMessage(message: NonUserMessage): string | null {
    if (!message.id) {
      return 'Message id is required';
    }
    if (!message.projectKey) {
      return 'Message projectKey is required';
    }
    if (!message.payload) {
      return 'Message payload is required';
    }
    if (!message.createdAt) {
      return 'Message createdAt is required';
    }
    const validTypes = ['scheduled', 'a2a', 'webhook', 'system'];
    if (!validTypes.includes(message.type)) {
      return `Invalid message type: ${message.type}. Must be one of: ${validTypes.join(', ')}`;
    }
    const validPriorities = ['low', 'normal', 'high'];
    if (!validPriorities.includes(message.priority)) {
      return `Invalid priority: ${message.priority}. Must be one of: ${validPriorities.join(', ')}`;
    }
    return null;
  }
}
