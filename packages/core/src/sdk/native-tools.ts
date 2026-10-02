/** A tool's business contract, independent of a Harness or MCP transport. */
export interface NativeAgentTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  /** Successful results are canonical JSON, validated by the native registry. */
  readonly outputSchema: Readonly<Record<string, unknown>>;
  execute(input: Record<string, unknown>, context: NativeAgentToolContext): Promise<unknown>;
}

export interface NativeAgentToolContext {
  readonly signal: AbortSignal;
  /** Optional native trace identity; never Notebook identity or execution authority. */
  readonly invocationId?: string;
}
