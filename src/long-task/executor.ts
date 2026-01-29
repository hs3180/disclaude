/**
 * Subtask executor - runs individual subtasks with isolated agents.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { createAgentSdkOptions, parseSDKMessage } from '../utils/sdk.js';
import { FeishuOutputAdapter } from '../utils/output-adapter.js';
import type { Subtask, SubtaskResult, LongTaskConfig } from './types.js';

/**
 * Executor for running individual subtasks.
 */
export class SubtaskExecutor {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly config: LongTaskConfig;

  constructor(apiKey: string, model: string, config: LongTaskConfig) {
    this.apiKey = apiKey;
    this.model = model;
    this.config = config;
  }

  /**
   * Execute a single subtask with a fresh agent.
   */
  async executeSubtask(
    subtask: Subtask,
    previousResults: SubtaskResult[],
    workspaceDir: string
  ): Promise<SubtaskResult> {
    const subtaskDir = path.join(workspaceDir, `subtask-${subtask.sequence}`);

    // Check for cancellation before starting
    if (this.config.abortSignal?.aborted) {
      throw new Error('AbortError');
    }

    await fs.mkdir(subtaskDir, { recursive: true });

    console.log(`[Executor] Starting subtask ${subtask.sequence}: ${subtask.title}`);

    // Prepare context from previous results
    const contextInfo = this.buildContextInfo(previousResults);

    // Create execution prompt
    const prompt = this.createExecutionPrompt(subtask, contextInfo, subtaskDir);

    // Create SDK options for isolated agent using shared utility
    const sdkOptions = createAgentSdkOptions({
      apiKey: this.apiKey,
      model: this.model,
      apiBaseUrl: this.config.apiBaseUrl,
      cwd: subtaskDir,
      permissionMode: 'bypassPermissions',
    });

    const startTime = Date.now();

    try {
      // Send progress update
      const totalSteps = this.config.totalSteps ?? '?';
      await this.config.sendMessage(
        this.config.chatId,
        `🔄 **Step ${subtask.sequence}/${totalSteps}**: ${subtask.title}\n\n${subtask.description}`
      );

      // Create Feishu output adapter for streaming messages
      const adapter = new FeishuOutputAdapter({
        sendMessage: async (chatId: string, text: string) => {
          // Prefix message with step context
          const prefixedText = `[Step ${subtask.sequence}/${totalSteps}] ${text}`;
          await this.config.sendMessage(chatId, prefixedText);
        },
        sendCard: async (chatId: string, card: Record<string, unknown>) => {
          await this.config.sendCard(chatId, card);
        },
        chatId: this.config.chatId,
      });

      // Clear throttle state for new subtask
      adapter.clearThrottleState();

      // Execute subtask with fresh agent
      const queryResult = query({
        prompt,
        options: sdkOptions,
      });

      // Collect response and track created files
      let fullResponse = '';
      const createdFiles: string[] = [];

      // Add abort listener
      const abortHandler = () => {
        console.log(`[Executor] Subtask ${subtask.sequence} aborted`);
        throw new Error('AbortError');
      };

      if (this.config.abortSignal) {
        this.config.abortSignal.addEventListener('abort', abortHandler, { once: true });
      }

      try {
        for await (const message of queryResult) {
          // Check for cancellation during iteration
          if (this.config.abortSignal?.aborted) {
            throw new Error('AbortError');
          }

          const parsed = parseSDKMessage(message);

          if (parsed.content) {
            fullResponse += parsed.content;
          }

          // Stream message to Feishu using the adapter
          await adapter.write(parsed.content, parsed.type, {
            toolName: parsed.metadata?.toolName as string | undefined,
            toolInputRaw: parsed.metadata?.toolInputRaw as Record<string, unknown> | undefined,
          });

          // Track file operations from metadata
          if (parsed.type === 'tool_use' && parsed.metadata?.toolName) {
            if (parsed.metadata.toolName === 'Write' || parsed.metadata.toolName === 'Edit') {
              // Extract file path from tool input if available in metadata
              if (parsed.metadata.toolInput && typeof parsed.metadata.toolInput === 'string' && parsed.metadata.toolInput.includes('Writing:')) {
                // Parse file path from toolInput format: "Writing: /path/to/file"
                const match = parsed.metadata.toolInput.match(/Writing:|Editing:\s*(.+)/);
                if (match && match[1]) {
                  createdFiles.push(match[1].trim());
                }
              }
            }
          }
        }
      } finally {
        // Remove abort listener
        if (this.config.abortSignal) {
          this.config.abortSignal.removeEventListener('abort', abortHandler);
        }
      }

      // Ensure summary file exists (use basename to avoid path duplication)
      const summaryFile = path.join(subtaskDir, path.basename(subtask.outputs.summaryFile));

      // Check if summary file was created
      try {
        await fs.access(summaryFile);
      } catch {
        // Create default summary if agent didn't create one
        const defaultSummary = this.createDefaultSummary(subtask, fullResponse, createdFiles);
        await fs.writeFile(summaryFile, defaultSummary, 'utf-8');
      }

      // List all files created in subtask directory
      const files = await this.listCreatedFiles(subtaskDir);

      const duration = Date.now() - startTime;

      console.log(`[Executor] Completed subtask ${subtask.sequence} in ${duration}ms`);

      // Send completion update
      await this.config.sendMessage(
        this.config.chatId,
        `✅ **Step ${subtask.sequence} completed**: ${subtask.title}\n\n📄 Summary: \`${subtask.outputs.summaryFile}\`\n📁 Created ${files.length} file(s)`
      );

      return {
        sequence: subtask.sequence,
        success: true,
        summary: fullResponse,
        files,
        summaryFile,
        completedAt: new Date().toISOString(),
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      console.error(`[Executor] Subtask ${subtask.sequence} failed after ${duration}ms:`, error);

      // Check if it's an abort error
      if (error instanceof Error && error.message === 'AbortError') {
        throw error; // Re-raise abort error without sending message
      }

      // Send error update
      await this.config.sendMessage(
        this.config.chatId,
        `❌ **Step ${subtask.sequence} failed**: ${subtask.title}\n\nError: ${error instanceof Error ? error.message : String(error)}`
      );

      return {
        sequence: subtask.sequence,
        success: false,
        summary: '',
        files: [],
        summaryFile: path.join(subtaskDir, path.basename(subtask.outputs.summaryFile)),
        error: error instanceof Error ? error.message : String(error),
        completedAt: new Date().toISOString(),
      };
    }
  }

  /**
   * Build context information from previous subtask results.
   */
  private buildContextInfo(previousResults: SubtaskResult[]): string {
    if (previousResults.length === 0) {
      return 'This is the first subtask. Start fresh based on the task description.';
    }

    const info: string[] = ['## Context from Previous Steps\n'];

    for (const result of previousResults) {
      info.push(`### Step ${result.sequence}\n`);
      info.push(`**Status**: ${result.success ? '✅ Completed' : '❌ Failed'}\n`);

      if (result.success) {
        info.push(`**Summary File**: \`${result.summaryFile}\`\n`);
        info.push('**Created Files**:\n');

        if (result.files.length > 0) {
          for (const file of result.files) {
            info.push(`- \`${file}\`\n`);
          }
        } else {
          info.push('(No files tracked)\n');
        }
      } else if (result.error) {
        info.push(`**Error**: ${result.error}\n`);
      }

      info.push('\n');
    }

    return info.join('');
  }

  /**
   * Create execution prompt for a subtask.
   */
  private createExecutionPrompt(subtask: Subtask, contextInfo: string, workspaceDir: string): string {
    const markdownRequirements = this.formatMarkdownRequirements(subtask);

    return `You are executing a subtask in a long task workflow. You have a specific responsibility within the larger plan.

## Your Subtask

**Title**: ${subtask.title}

**Description**: ${subtask.description}

**Sequence**: Step ${subtask.sequence} in the workflow

## Inputs

${subtask.inputs.description}

**Sources**: ${subtask.inputs.sources.join(', ') || 'None (first step)'}

${subtask.inputs.context ? `**Additional Context**:\n${JSON.stringify(subtask.inputs.context, null, 2)}\n` : ''}

## Expected Outputs

${subtask.outputs.description}

**Required Files**:
${subtask.outputs.files.map(f => `- \`${f}\``).join('\n')}${markdownRequirements}

## Context from Previous Steps

${contextInfo}

## Working Directory

You are working in: \`${workspaceDir}\`

All files you create will be saved here. Use relative paths for file operations.

## Instructions

1. Read and understand the context from previous steps
2. If inputs reference specific markdown sections (using # notation), read those sections carefully
3. Execute your specific task as described
4. Create the required output files
5. **Crucially**: Create a comprehensive markdown summary at \`${subtask.outputs.summaryFile}\`
   - Follow the structure requirements above exactly
   - Ensure each section contains the specified content
   - This summary will be used by subsequent steps
6. Report your completion and summary

Begin your work now. Focus only on your assigned subtask.`;
  }

  /**
   * Format markdown requirements for the execution prompt.
   */
  private formatMarkdownRequirements(subtask: Subtask): string {
    if (!subtask.outputs.markdownRequirements || subtask.outputs.markdownRequirements.length === 0) {
      return `

**Critical**: You MUST create a summary file at \`${subtask.outputs.summaryFile}\` containing:
- What was accomplished
- Key findings or results
- Files created (with brief descriptions)
- Any issues encountered
- Recommendations for next steps`;
    }

    const sections = subtask.outputs.markdownRequirements.map(req => {
      const requiredMark = req.required ? '✅ (Required)' : '⚪ (Optional)';
      return `
### ${req.title} ${requiredMark}
**Section ID**: \`${req.id}\`
**Content**: ${req.content}`;
    }).join('\n');

    return `

**Critical**: You MUST create a summary file at \`${subtask.outputs.summaryFile}\` with the following structure:

${sections}

**Important**: The section IDs (like \`${subtask.outputs.markdownRequirements[0]?.id || 'section-name'}\`) can be referenced by subsequent steps. Ensure your markdown uses these exact headings so the next step can find the information it needs.`;
  }

  /**
   * Create default summary if agent doesn't provide one.
   */
  private createDefaultSummary(subtask: Subtask, response: string, files: string[]): string {
    const date = new Date().toISOString();

    return `# Summary: ${subtask.title}

**Subtask Sequence**: ${subtask.sequence}
**Completed At**: ${date}

## What Was Done

${subtask.description}

## Agent Response

\`\`\`
${response.substring(0, 2000)}${response.length > 2000 ? '\n... (truncated)' : ''}
\`\`\`

## Files Created

${files.length > 0 ? files.map(f => `- \`${f}\``).join('\n') : 'No files were tracked.'}

## Notes

This summary was automatically generated. The agent should have created a more detailed summary.
`;
  }

  /**
   * List all files created in the subtask directory.
   */
  private async listCreatedFiles(subtaskDir: string): Promise<string[]> {
    const files: string[] = [];

    try {
      const entries = await fs.readdir(subtaskDir, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isFile()) {
          files.push(entry.name);
        } else if (entry.isDirectory()) {
          // Recursively list subdirectories
          const subPath = path.join(subtaskDir, entry.name);
          const subFiles = await this.listCreatedFiles(subPath);
          files.push(...subFiles.map(f => path.join(entry.name, f)));
        }
      }
    } catch (error) {
      console.error(`[Executor] Failed to list files in ${subtaskDir}:`, error);
    }

    return files;
  }
}
