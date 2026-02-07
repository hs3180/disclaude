/**
 * Task tracker for persisting regular/dialogue task records to disk.
 *
 * Directory structure:
 * tasks/
 * └── regular/              # All dialogue tasks (default + Flow 2)
 *     └── {message_id}/
 *         └── task.md
 */
import * as fs from 'fs/promises';
import * as syncFs from 'fs';
import * as path from 'path';
import { Config } from '../config/index.js';

/**
 * Task definition details interface.
 * Used by appendTaskDefinition for adding structured task details.
 */
export interface TaskDefinitionDetails {
  primary_goal: string;
  success_criteria: string[];
  expected_outcome: string;
  deliverables: string[];
  format_requirements: string[];
  constraints: string[];
  quality_criteria: string[];
}

/**
 * Task tracker for persisting message processing records to disk.
 * Provides unified recording for regular tasks.
 */
export class TaskTracker {
  private readonly tasksDir: string;
  private readonly regularTasksDir: string;

  constructor(baseDir?: string) {
    const workspaceDir = baseDir || Config.getWorkspaceDir();
    this.tasksDir = path.join(workspaceDir, 'tasks');
    this.regularTasksDir = path.join(this.tasksDir, 'regular');
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
   * Called after Scout completes the definition phase.
   *
   * @param taskPath - Path to the Task.md file
   * @param details - Task definition details from Scout
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

*Task definition generated by Scout*
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
}
