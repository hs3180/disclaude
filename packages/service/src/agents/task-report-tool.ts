import type { ToolDefinition } from '@disclaude/core';

export interface AgentTaskReport { summary: string; artifacts: string[] }
export function createTaskReportTool(): { tool: ToolDefinition; read(): AgentTaskReport | undefined; close(): void } {
  let value: AgentTaskReport | undefined, closed = false;
  return {
    tool: {
      name: 'agent_task_report', description: 'Record this task summary and known artifact references before ending the query. Native success/failure is determined by the host; this is not Goal acceptance.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {
        summary: { type: 'string', minLength: 1, maxLength: 16000 },
        artifacts: { type: 'array', maxItems: 100, items: { type: 'string', minLength: 1, maxLength: 2000 } },
      }, required: ['summary', 'artifacts'] },
      outputSchema: { type: 'object', additionalProperties: false, properties: {
        recorded: { type: 'boolean' }, nativeOutcomePending: { type: 'boolean' },
      }, required: ['recorded', 'nativeOutcomePending'] },
      execute: (input, context) => {
        context.signal.throwIfAborted();
        const report = input as unknown as AgentTaskReport;
        if (closed || !report.summary.trim() || report.artifacts.some(item => !item.trim())) { return Promise.reject(new Error('Task report collection is unavailable or empty')); }
        value = structuredClone(report); return Promise.resolve({ recorded: true, nativeOutcomePending: true });
      },
    },
    read: () => value && structuredClone(value), close: () => { closed = true; },
  };
}
