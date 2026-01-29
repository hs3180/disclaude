import * as fs from 'fs/promises';
import * as syncFs from 'fs';
import * as path from 'path';
import { Config } from '../config/index.js';

/**
 * Long task plan interface for type safety.
 */
export interface LongTaskPlan {
  taskId: string;
  originalRequest: string;
  title: string;
  description: string;
  subtasks: unknown[];
  totalSteps: number;
  createdAt: string;
}

/**
 * Subtask result interface for type safety.
 */
export interface SubtaskResult {
  sequence: number;
  success: boolean;
  summary: string;
  files: string[];
  summaryFile: string;
  error?: string;
  completedAt: string;
}

/**
 * Task tracker for persisting message processing records to disk.
 * Provides unified recording for both regular tasks and long tasks.
 *
 * Directory structure:
 * tasks/
 * ├── regular/              # Regular single-turn tasks
 * │   └── {message_id}.md
 * └── long-tasks/           # Long multi-step tasks
 *     └── {task_id}/
 *         ├── TASK_PLAN.md
 *         ├── subtask-1-result.json
 *         ├── subtask-2-result.json
 *         └── FINAL_SUMMARY.md
 */
export class TaskTracker {
  private tasksDir: string;
  private regularTasksDir: string;
  private longTasksDir: string;

  constructor(baseDir?: string) {
    const workspaceDir = baseDir || Config.getWorkspaceDir();
    this.tasksDir = path.join(workspaceDir, 'tasks');
    this.regularTasksDir = path.join(this.tasksDir, 'regular');
    this.longTasksDir = path.join(this.tasksDir, 'long-tasks');
  }

  /**
   * Ensure tasks directory exists.
   */
  async ensureTasksDir(): Promise<void> {
    try {
      await fs.mkdir(this.tasksDir, { recursive: true });
    } catch (error) {
      console.error('Failed to create tasks directory:', error);
    }
  }

  /**
   * Ensure regular tasks subdirectory exists.
   */
  private async ensureRegularTasksDir(): Promise<void> {
    try {
      await fs.mkdir(this.regularTasksDir, { recursive: true });
    } catch (error) {
      console.error('Failed to create regular tasks directory:', error);
    }
  }

  /**
   * Ensure long tasks subdirectory exists.
   */
  private async ensureLongTasksDir(): Promise<void> {
    try {
      await fs.mkdir(this.longTasksDir, { recursive: true });
    } catch (error) {
      console.error('Failed to create long tasks directory:', error);
    }
  }

  /**
   * Get file path for a regular task record.
   */
  getTaskFilePath(messageId: string): string {
    // Sanitize message_id to make it a valid filename
    // Replace characters that are invalid in filenames
    const sanitized = messageId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.regularTasksDir, `${sanitized}.md`);
  }

  /**
   * Check if a task record exists on disk.
   */
  async hasTaskRecord(messageId: string): Promise<boolean> {
    try {
      const filePath = this.getTaskFilePath(messageId);
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Save task processing record to disk (asynchronous).
   * @param messageId - Unique message identifier
   * @param metadata - Message metadata (chat_id, sender, timestamp, etc.)
   * @param content - Bot response content (what was sent to user)
   */
  async saveTaskRecord(
    messageId: string,
    metadata: {
      chatId: string;
      senderType?: string;
      senderId?: string;
      text: string;
      timestamp?: string;
    },
    content: string
  ): Promise<void> {
    await this.ensureRegularTasksDir();

    const filePath = this.getTaskFilePath(messageId);
    const timestamp = metadata.timestamp || new Date().toISOString();

    // Format content as Markdown
    const markdown = this.formatTaskRecord(messageId, metadata, content, timestamp);

    try {
      await fs.writeFile(filePath, markdown, 'utf-8');
      console.log(`[Task saved] ${messageId} -> ${filePath}`);
    } catch (error) {
      console.error(`[Task save failed] ${messageId}:`, error);
    }
  }

  /**
   * Save task processing record to disk (synchronous).
   * Use this for critical messages (like restart commands) to ensure the record is written
   * before the process terminates.
   * @param messageId - Unique message identifier
   * @param metadata - Message metadata (chat_id, sender, timestamp, etc.)
   * @param content - Bot response content (what was sent to user)
   */
  saveTaskRecordSync(
    messageId: string,
    metadata: {
      chatId: string;
      senderType?: string;
      senderId?: string;
      text: string;
      timestamp?: string;
    },
    content: string
  ): void {
    // Ensure directory exists synchronously
    const dirExists = syncFs.existsSync(this.regularTasksDir);
    if (!dirExists) {
      try {
        syncFs.mkdirSync(this.regularTasksDir, { recursive: true });
      } catch (error) {
        console.error('Failed to create regular tasks directory:', error);
        return;
      }
    }

    const filePath = this.getTaskFilePath(messageId);
    const timestamp = metadata.timestamp || new Date().toISOString();

    // Format content as Markdown
    const markdown = this.formatTaskRecord(messageId, metadata, content, timestamp);

    try {
      syncFs.writeFileSync(filePath, markdown, 'utf-8');
      console.log(`[Task saved sync] ${messageId} -> ${filePath}`);
    } catch (error) {
      console.error(`[Task save failed] ${messageId}:`, error);
    }
  }

  /**
   * Format task record as Markdown.
   */
  private formatTaskRecord(
    messageId: string,
    metadata: {
      chatId: string;
      senderType?: string;
      senderId?: string;
      text: string;
    },
    content: string,
    timestamp: string
  ): string {
    const lines = [
      `# Task Record: ${messageId}`,
      '',
      '**Metadata**',
      `- Message ID: ${messageId}`,
      `- Chat ID: ${metadata.chatId}`,
      `- Timestamp: ${timestamp}`,
      metadata.senderType ? `- Sender Type: ${metadata.senderType}` : '',
      metadata.senderId ? `- Sender ID: ${metadata.senderId}` : '',
      '',
      '**User Input**',
      '```',
      metadata.text,
      '```',
      '',
      '**Bot Response**',
      '```',
      content,
      '```',
    ].filter(line => line !== ''); // Remove empty lines from conditional fields

    return lines.join('\n');
  }

  // ===== Long Task Methods =====

  /**
   * Get long task directory path.
   */
  getLongTaskDirPath(taskId: string): string {
    // Sanitize task_id to make it a valid directory name
    const sanitized = taskId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.longTasksDir, sanitized);
  }

  /**
   * Ensure long task directory exists.
   */
  async ensureLongTaskDir(taskId: string): Promise<string> {
    await this.ensureLongTasksDir();

    const taskDir = this.getLongTaskDirPath(taskId);
    try {
      await fs.mkdir(taskDir, { recursive: true });
      return taskDir;
    } catch (error) {
      console.error(`Failed to create long task directory for ${taskId}:`, error);
      throw error;
    }
  }

  /**
   * Save long task plan to disk.
   * @param taskId - Unique task identifier
   * @param plan - Long task plan object
   */
  async saveLongTaskPlan(taskId: string, plan: LongTaskPlan): Promise<void> {
    const taskDir = await this.ensureLongTaskDir(taskId);
    const planFile = path.join(taskDir, 'TASK_PLAN.md');

    const content = this.formatLongTaskPlan(plan);

    try {
      await fs.writeFile(planFile, content, 'utf-8');
      console.log(`[Long task plan saved] ${taskId} -> ${planFile}`);
    } catch (error) {
      console.error(`[Long task plan save failed] ${taskId}:`, error);
      throw error;
    }
  }

  /**
   * Save subtask result to disk.
   * @param taskId - Parent task identifier
   * @param result - Subtask result object
   */
  async saveSubtaskResult(taskId: string, result: SubtaskResult): Promise<void> {
    const taskDir = await this.ensureLongTaskDir(taskId);
    const resultFile = path.join(taskDir, `subtask-${result.sequence}-result.json`);

    try {
      await fs.writeFile(resultFile, JSON.stringify(result, null, 2), 'utf-8');
      console.log(`[Subtask result saved] ${taskId}/${result.sequence} -> ${resultFile}`);
    } catch (error) {
      console.error(`[Subtask result save failed] ${taskId}/${result.sequence}:`, error);
      throw error;
    }
  }

  /**
   * Save long task final summary to disk.
   * @param taskId - Task identifier
   * @param summary - Final summary content
   */
  async saveLongTaskSummary(taskId: string, summary: string): Promise<void> {
    const taskDir = await this.ensureLongTaskDir(taskId);
    const summaryFile = path.join(taskDir, 'FINAL_SUMMARY.md');

    try {
      await fs.writeFile(summaryFile, summary, 'utf-8');
      console.log(`[Long task summary saved] ${taskId} -> ${summaryFile}`);
    } catch (error) {
      console.error(`[Long task summary save failed] ${taskId}:`, error);
      throw error;
    }
  }

  /**
   * Format long task plan as Markdown.
   */
  private formatLongTaskPlan(plan: LongTaskPlan): string {
    const content = `# Task Plan: ${plan.title}

**Task ID**: ${plan.taskId}
**Created**: ${plan.createdAt}
**Total Steps**: ${plan.totalSteps}

## Original Request

${plan.originalRequest}

## Description

${plan.description}

## Subtasks

${plan.subtasks.map((st: any) => `
### Step ${st.sequence}: ${st.title}

**Description**: ${st.description}
**Complexity**: ${st.complexity || 'medium'}

**Inputs**:
- ${st.inputs.description}
- Sources: ${st.inputs.sources.join(', ') || 'None'}

**Outputs**:
- ${st.outputs.description}
- Files: ${st.outputs.files.join(', ') || 'None'}
- Summary: \`${st.outputs.summaryFile}\`
${st.outputs.markdownRequirements && st.outputs.markdownRequirements.length > 0 ? `
**Markdown Structure Requirements**:
${st.outputs.markdownRequirements.map((req: any) => `- **${req.title}** (\`${req.id}\`): ${req.content} ${req.required ? '(Required)' : '(Optional)'}`).join('\n')}
` : ''}
`).join('\n')}

---

*This plan was automatically generated by the task planner.*
`;

    return content;
  }
}
