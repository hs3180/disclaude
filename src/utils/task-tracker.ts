import * as fs from 'fs/promises';
import * as syncFs from 'fs';
import * as path from 'path';
import { Config } from '../config/index.js';
import type { TaskDefinitionDetails } from '../mcp/feishu-context-mcp.js';

// Re-export TaskDefinitionDetails for convenience
export type { TaskDefinitionDetails };

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
 * Dialogue task plan interface for type safety.
 * Used by AgentDialogueBridge for Manager + Worker dialogue mode.
 */
export interface DialogueTaskPlan {
  taskId: string;
  title: string;
  description: string;
  milestones: string[];
  originalRequest: string;
  createdAt: string;
}

/**
 * Task tracker for persisting message processing records to disk.
 * Provides unified recording for both regular tasks and long tasks.
 *
 * Directory structure:
 * tasks/
 * ├── regular/              # All dialogue tasks (default + Flow 2)
 * │   └── {message_id}/
 * │       └── task.md
 * └── long-tasks/           # Long multi-step tasks (/long command)
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
   * Ensure a specific task directory exists.
   * @param messageId - Unique message identifier
   */
  private async ensureTaskDir(messageId: string): Promise<string> {
    await this.ensureRegularTasksDir();
    const sanitized = messageId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const taskDir = path.join(this.regularTasksDir, sanitized);
    try {
      await fs.mkdir(taskDir, { recursive: true });
      return taskDir;
    } catch (error) {
      console.error(`Failed to create task directory for ${messageId}:`, error);
      throw error;
    }
  }

  /**
   * Ensure a specific task directory exists (synchronous).
   * @param messageId - Unique message identifier
   */
  private ensureTaskDirSync(messageId: string): string {
    const dirExists = syncFs.existsSync(this.regularTasksDir);
    if (!dirExists) {
      try {
        syncFs.mkdirSync(this.regularTasksDir, { recursive: true });
      } catch (error) {
        console.error('Failed to create regular tasks directory:', error);
        throw error;
      }
    }
    const sanitized = messageId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const taskDir = path.join(this.regularTasksDir, sanitized);
    const taskDirExists = syncFs.existsSync(taskDir);
    if (!taskDirExists) {
      try {
        syncFs.mkdirSync(taskDir, { recursive: true });
      } catch (error) {
        console.error(`Failed to create task directory for ${messageId}:`, error);
        throw error;
      }
    }
    return taskDir;
  }

  /**
   * Get file path for a regular task record.
   */
  getTaskFilePath(messageId: string): string {
    // Sanitize message_id to make it a valid filename
    // Replace characters that are invalid in filenames
    const sanitized = messageId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.regularTasksDir, sanitized, 'task.md');
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
    await this.ensureTaskDir(messageId);

    const filePath = this.getTaskFilePath(messageId);
    const timestamp = metadata.timestamp || new Date().toISOString();

    // Use new dialogue format
    const markdown = this.formatDialogueTaskRecord(messageId, metadata, content, timestamp);

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
    // Ensure task directory exists synchronously
    this.ensureTaskDirSync(messageId);

    const filePath = this.getTaskFilePath(messageId);
    const timestamp = metadata.timestamp || new Date().toISOString();

    // Use new dialogue format
    const markdown = this.formatDialogueTaskRecord(messageId, metadata, content, timestamp);

    try {
      syncFs.writeFileSync(filePath, markdown, 'utf-8');
      console.log(`[Task saved sync] ${messageId} -> ${filePath}`);
    } catch (error) {
      console.error(`[Task save failed] ${messageId}:`, error);
    }
  }

  /**
   * Format task record as Markdown (new dialogue format).
   * Note: Bot Response section is intentionally excluded as per requirements.
   */
  private formatDialogueTaskRecord(
    messageId: string,
    metadata: {
      chatId: string;
      senderType?: string;
      senderId?: string;
      text: string;
    },
    _content: string,
    timestamp: string
  ): string {
    // Extract title from first line or first 50 chars
    const [firstLine] = metadata.text.split('\n');
    const title = firstLine.substring(0, 50) + (firstLine.length > 50 ? '...' : '');

    return `# Task: ${title}

**Task ID**: ${messageId}
**Created**: ${timestamp}
**Chat ID**: ${metadata.chatId}
**User ID**: ${metadata.senderId || 'N/A'}
${metadata.senderType ? `**Sender Type**: ${metadata.senderType}` : ''}

## Original Request

\`\`\`
${metadata.text}
\`\`\`
`;
  }

  // ===== Dialogue Task Methods (Flow 1: Task.md creation) =====

  /**
   * Get dialogue task file path.
   * Uses regular tasks directory for all dialogue tasks.
   * @param messageId - Unique message identifier
   * @returns Full path to the dialogue task file
   */
  getDialogueTaskPath(messageId: string): string {
    const sanitized = messageId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.regularTasksDir, sanitized, 'task.md');
  }

  /**
   * Create initial Task.md file (Flow 1 output).
   * This creates the task file that will be used as input for Flow 2.
   * Note: Bot Response section is intentionally excluded as per requirements.
   *
   * @param messageId - Unique message identifier
   * @param metadata - Task metadata (chatId, userId, text, timestamp)
   * @returns Path to the created task file
   */
  async createDialogueTask(
    messageId: string,
    metadata: {
      chatId: string;
      userId?: string;
      text: string;
      timestamp?: string;
    }
  ): Promise<string> {
    await this.ensureTaskDir(messageId);

    const taskPath = this.getDialogueTaskPath(messageId);
    const timestamp = metadata.timestamp || new Date().toISOString();

    // Extract title from first line or first 50 chars
    const [firstLine] = metadata.text.split('\n');
    const title = firstLine.substring(0, 50) + (firstLine.length > 50 ? '...' : '');

    const content = `# Task: ${title}

**Task ID**: ${messageId}
**Created**: ${timestamp}
**Chat ID**: ${metadata.chatId}
**User ID**: ${metadata.userId || 'N/A'}

## Original Request

\`\`\`
${metadata.text}
\`\`\`
`;

    try {
      await fs.writeFile(taskPath, content, 'utf-8');
      console.log(`[Dialogue task created] ${messageId} -> ${taskPath}`);
      return taskPath;
    } catch (error) {
      console.error(`[Dialogue task creation failed] ${messageId}:`, error);
      throw error;
    }
  }

  /**
   * Append task definition details to existing Task.md file.
   * Called after Planner completes the definition phase.
   *
   * @param taskPath - Path to the Task.md file
   * @param details - Task definition details from Planner
   */
  async appendTaskDefinition(
    taskPath: string,
    details: TaskDefinitionDetails
  ): Promise<void> {
    const existingContent = await fs.readFile(taskPath, 'utf-8');

    const appendContent = `

## Task Objectives

### Primary Goal
${details.primary_goal}

### Success Criteria
${details.success_criteria.map(c => `- ${c}`).join('\n')}

### Expected Outcome
${details.expected_outcome}

## Delivery Specifications

### Required Deliverables
${details.deliverables.map(d => `- ${d}`).join('\n')}
${details.format_requirements?.length ? `
### Format Requirements
${details.format_requirements.map(r => `- ${r}`).join('\n')}
` : ''}
${details.constraints?.length ? `
### Constraints
${details.constraints.map(c => `- ${c}`).join('\n')}
` : ''}

## Quality Criteria

${details.quality_criteria.map(q => `- ${q}`).join('\n')}

---

*Task definition generated by Planner*
*This document serves as a record and will not be modified during execution.*
`;

    try {
      await fs.writeFile(taskPath, existingContent + appendContent, 'utf-8');
      console.log(`[Task definition appended] ${taskPath}`);
    } catch (error) {
      console.error(`[Task definition append failed] ${taskPath}:`, error);
      throw error;
    }
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

  // ===== Dialogue Task Methods =====

  /**
   * Save dialogue task plan to disk.
   * Used by AgentDialogueBridge for Manager + Worker dialogue mode.
   * @param plan - Dialogue task plan object
   */
  async saveDialogueTaskPlan(plan: DialogueTaskPlan): Promise<void> {
    const taskDir = await this.ensureLongTaskDir(plan.taskId);
    const planFile = path.join(taskDir, 'TASK_PLAN.md');

    const content = this.formatDialogueTaskPlan(plan);

    try {
      await fs.writeFile(planFile, content, 'utf-8');
      console.log(`[Dialogue task plan saved] ${plan.taskId} -> ${planFile}`);
    } catch (error) {
      console.error(`[Dialogue task plan save failed] ${plan.taskId}:`, error);
      // Don't throw - dialogue should continue even if plan save fails
    }
  }

  /**
   * Format dialogue task plan as Markdown.
   */
  private formatDialogueTaskPlan(plan: DialogueTaskPlan): string {
    const milestonesList = plan.milestones.length > 0
      ? plan.milestones.map((m, i) => `${i + 1}. ${m}`).join('\n')
      : 'No specific milestones defined';

    const content = `# Task Plan: ${plan.title}

**Task ID**: ${plan.taskId}
**Created**: ${plan.createdAt}
**Mode**: Manager + Worker Dialogue

## Original Request

${plan.originalRequest}

## Description

${plan.description}

## Milestones

${milestonesList}

---

*Generated by Manager via AgentDialogueBridge*
`;

    return content;
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
