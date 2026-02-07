/**
 * Long task tracker for persisting long task state to disk.
 *
 * Handles persistence for:
 * - Long task plans (/long command workflow)
 * - Subtask results
 * - Final summaries
 * - Dialogue task plans (Manager + Worker dialogue mode)
 *
 * Directory structure:
 * tasks/
 * └── long-tasks/           # Long multi-step tasks
 *     └── {task_id}/
 *         ├── TASK_PLAN.md
 *         ├── subtask-1-result.json
 *         ├── subtask-2-result.json
 *         └── FINAL_SUMMARY.md
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { Config } from '../config/index.js';
import type { LongTaskPlan, SubtaskResult } from './types.js';

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
 * Tracker for long task persistence.
 */
export class LongTaskTracker {
  private readonly tasksDir: string;
  private readonly longTasksDir: string;

  constructor(baseDir?: string) {
    const workspaceDir = baseDir || Config.getWorkspaceDir();
    this.tasksDir = path.join(workspaceDir, 'tasks');
    this.longTasksDir = path.join(this.tasksDir, 'long-tasks');
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
