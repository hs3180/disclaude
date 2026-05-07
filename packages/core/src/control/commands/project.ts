/**
 * Project management command handlers.
 *
 * Implements /project status, /project trigger, /project stop, /project list
 * commands for managing project-bound agents.
 *
 * @see Issue #3335 (Phase 5: Project state persistence and admin commands)
 */

import type { ControlCommand, ControlResponse } from '../../types/channel.js';
import type { CommandHandler } from '../types.js';

/**
 * /project status command handler.
 *
 * Shows project agent status and state summary.
 * Usage: /project status [projectKey]
 * If no projectKey is provided, shows status for all projects.
 */
export const handleProjectStatus: CommandHandler = (
  command: ControlCommand,
  context,
): ControlResponse => {
  if (!context.project) {
    return {
      success: false,
      error: '项目管理功能未启用（未配置 projects）',
    };
  }

  const projectKey = command.data?.projectKey as string | undefined;

  try {
    const summary = context.project.getProjectStatus(projectKey);
    return {
      success: true,
      message: summary,
    };
  } catch (err) {
    return {
      success: false,
      error: `获取项目状态失败: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
};

/**
 * /project trigger command handler.
 *
 * Manually trigger a task for a project agent.
 * Usage: /project trigger <projectKey>
 */
export const handleProjectTrigger: CommandHandler = (
  command: ControlCommand,
  context,
): ControlResponse => {
  if (!context.project) {
    return {
      success: false,
      error: '项目管理功能未启用（未配置 projects）',
    };
  }

  const projectKey = command.data?.projectKey as string | undefined;

  if (!projectKey) {
    return {
      success: false,
      error: '用法: /project trigger <projectKey>',
    };
  }

  try {
    const result = context.project.triggerProject(projectKey);
    return {
      success: true,
      message: result,
    };
  } catch (err) {
    return {
      success: false,
      error: `触发项目任务失败: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
};

/**
 * /project stop command handler.
 *
 * Stop a project agent (dispose from pool).
 * Usage: /project stop <projectKey>
 */
export const handleProjectStop: CommandHandler = (
  command: ControlCommand,
  context,
): ControlResponse => {
  if (!context.project) {
    return {
      success: false,
      error: '项目管理功能未启用（未配置 projects）',
    };
  }

  const projectKey = command.data?.projectKey as string | undefined;

  if (!projectKey) {
    return {
      success: false,
      error: '用法: /project stop <projectKey>',
    };
  }

  try {
    const result = context.project.stopProject(projectKey);
    return {
      success: true,
      message: result,
    };
  } catch (err) {
    return {
      success: false,
      error: `停止项目 Agent 失败: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
};

/**
 * /project list command handler.
 *
 * List all configured projects.
 * Usage: /project list
 */
export const handleProjectList: CommandHandler = (
  _command: ControlCommand,
  context,
): ControlResponse => {
  if (!context.project) {
    return {
      success: false,
      error: '项目管理功能未启用（未配置 projects）',
    };
  }

  try {
    const projects = context.project.listProjects();

    if (projects.length === 0) {
      return {
        success: true,
        message: '📋 没有配置任何项目',
      };
    }

    const lines: string[] = [
      '📋 **已配置的项目**',
      '',
    ];

    for (const project of projects) {
      lines.push(`- **${project.key}**`);
      if (project.chatId) {
        lines.push(`  - Chat: \`${project.chatId}\``);
      }
      if (project.workingDir) {
        lines.push(`  - 工作目录: \`${project.workingDir}\``);
      }
      if (project.modelTier) {
        lines.push(`  - 模型层级: \`${project.modelTier}\``);
      }
      if (project.idleTimeoutMs) {
        const minutes = Math.round(project.idleTimeoutMs / 60000);
        lines.push(`  - 空闲超时: ${minutes} 分钟`);
      }
    }

    return {
      success: true,
      message: lines.join('\n'),
    };
  } catch (err) {
    return {
      success: false,
      error: `获取项目列表失败: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
};
