/**
 * /project command handler.
 *
 * Provides commands for managing chatId → working directory bindings.
 *
 * Subcommands:
 * - `use <workingDir>` — Bind current chat to a working directory
 * - `reset` — Reset current chat to default workspace
 * - `info` — Show current chat's active project info
 * - `status` — Show all configured projects and their runtime state
 * - `stop <key>` — Stop agent for a configured project
 *
 * @see Issue #3519 (simplify /project command)
 * @see Issue #3329 Phase 5 (Configuration & DX)
 * @see Issue #1916 (unified ProjectContext system)
 * @see Issue #3529 (typed command data)
 */

import type { ControlCommand, ControlResponse } from '../../types/channel.js';
import type { ControlHandlerContext, CommandHandler } from '../types.js';
import { readProjectState } from '../../project/project-state.js';
import { basename } from 'node:path';

/** Typed command for /project handlers */
type ProjectCommand = ControlCommand<'project'>;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Subcommand Handlers
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * `/project info` — Show current chat's active project.
 */
function handleInfo(command: ProjectCommand, context: ControlHandlerContext): ControlResponse {
  const pm = context.projectManager;
  if (!pm) {
    return {
      success: false,
      error: 'ProjectManager 未配置',
    };
  }

  const active = pm.getActive(command.chatId);

  if (active.name === 'default') {
    return {
      success: true,
      message: `📂 **当前项目**: default（工作空间根目录）\n\`${active.workingDir}\``,
    };
  }

  // Try to read project state
  const state = readProjectState(active.workingDir);
  const issueCount = state ? Object.keys(state.issues).length : 0;
  const prCount = state ? Object.keys(state.prs).length : 0;
  const lastSync = state?.sync?.issues ?? '从不';

  return {
    success: true,
    message: [
      `📂 **当前项目**: ${basename(active.workingDir)}`,
      `**工作目录**: \`${active.workingDir}\``,
      '',
      '**状态摘要**:',
      `- Issues: ${issueCount} 个已追踪`,
      `- PRs: ${prCount} 个已追踪`,
      `- 上次同步: ${lastSync}`,
    ].join('\n'),
  };
}

/**
 * `/project use <workingDir>` — Bind current chat to a working directory.
 */
function handleUse(command: ProjectCommand, context: ControlHandlerContext): ControlResponse {
  const pm = context.projectManager;
  if (!pm) {
    return {
      success: false,
      error: 'ProjectManager 未配置',
    };
  }

  const workingDir = command.data?.workingDir;

  if (!workingDir) {
    return {
      success: false,
      error: '用法: /project use <workingDir>\n请指定工作目录路径（相对或绝对路径）',
    };
  }

  const result = pm.use(command.chatId, workingDir);
  if (!result.ok) {
    return {
      success: false,
      error: result.error,
    };
  }

  // Reset the agent session so the next message uses the new cwd
  context.agentPool.reset(command.chatId);

  return {
    success: true,
    message: [
      `✅ **已切换工作目录**: \`${result.data.workingDir}\``,
      '',
      'Agent 会话已重置，下次对话将使用新工作目录。',
    ].join('\n'),
  };
}

/**
 * `/project reset` — Reset current chat to default workspace.
 */
function handleReset(command: ProjectCommand, context: ControlHandlerContext): ControlResponse {
  const pm = context.projectManager;
  if (!pm) {
    return {
      success: false,
      error: 'ProjectManager 未配置',
    };
  }

  const result = pm.reset(command.chatId);
  if (!result.ok) {
    return {
      success: false,
      error: result.error,
    };
  }

  // Reset the agent session so the next message uses the default cwd
  context.agentPool.reset(command.chatId);

  return {
    success: true,
    message: '✅ **已重置为默认项目**（工作空间根目录）\n\nAgent 会话已重置。',
  };
}

/**
 * `/project status` — Show all configured projects and their runtime state.
 *
 * Lists pre-configured projects from disclaude.config.yaml along with
 * their current binding state and activity info.
 */
function handleStatus(_command: ProjectCommand, context: ControlHandlerContext): ControlResponse {
  const pm = context.projectManager;
  if (!pm) {
    return {
      success: false,
      error: 'ProjectManager 未配置',
    };
  }

  const configuredProjects = pm.listConfiguredProjects();
  const bindings = pm.listBindings();

  if (configuredProjects.length === 0 && bindings.length === 0) {
    return {
      success: true,
      message: '📋 没有已配置的项目或活跃的项目绑定。\n\n使用 `/project use <dir>` 绑定工作目录，或在 `disclaude.config.yaml` 中配置 `projects`。',
    };
  }

  const lines: string[] = ['📋 **项目状态概览**', ''];

  // Show configured projects
  if (configuredProjects.length > 0) {
    lines.push('**配置文件中的项目**:');
    for (const project of configuredProjects) {
      const chatIdDisplay = project.chatId
        ? `已绑定 (\`${project.chatId.substring(0, 12)}...\`)`
        : '未绑定 chatId';
      const tierDisplay = project.modelTier ? ` | 模型: ${project.modelTier}` : '';
      lines.push(`- **${project.key}**: \`${project.workingDir}\` | ${chatIdDisplay}${tierDisplay}`);
    }
    lines.push('');
  }

  // Show runtime bindings
  if (bindings.length > 0) {
    lines.push('**运行时绑定**:');
    for (const binding of bindings) {
      const projectDir = basename(binding.workingDir);
      const state = readProjectState(binding.workingDir);
      const issueCount = state ? Object.keys(state.issues).length : 0;
      const prCount = state ? Object.keys(state.prs).length : 0;
      lines.push(`- \`${binding.chatId.substring(0, 12)}...\` → ${projectDir} (${issueCount} issues, ${prCount} PRs)`);
    }
  }

  return {
    success: true,
    message: lines.join('\n'),
  };
}

/**
 * `/project stop <key>` — Stop agent for a configured project.
 *
 * Stops the agent running for a specific configured project identified by key.
 * The project must have a chatId binding in the config.
 */
function handleProjectStop(command: ProjectCommand, context: ControlHandlerContext): ControlResponse {
  const pm = context.projectManager;
  if (!pm) {
    return {
      success: false,
      error: 'ProjectManager 未配置',
    };
  }

  const projectKey = command.data?.projectKey;

  if (!projectKey) {
    return {
      success: false,
      error: '用法: /project stop <projectKey>\n请指定项目 key（在 disclaude.config.yaml 中配置的 projects 列表）',
    };
  }

  const project = pm.getConfiguredProject(projectKey);
  if (!project) {
    const available = pm.listConfiguredProjects().map(p => p.key);
    const availableText = available.length > 0
      ? `\n可用项目: ${available.join(', ')}`
      : '\n没有已配置的项目。请在 disclaude.config.yaml 中添加 projects 配置。';
    return {
      success: false,
      error: `未找到项目: ${projectKey}${availableText}`,
    };
  }

  if (!project.chatId) {
    return {
      success: false,
      error: `项目 ${projectKey} 没有绑定 chatId，无法停止 agent。`,
    };
  }

  const stopped = context.agentPool.stop(project.chatId);
  if (stopped) {
    return {
      success: true,
      message: `✅ 已停止项目 **${projectKey}** 的 agent。`,
    };
  }

  return {
    success: true,
    message: `ℹ️ 项目 **${projectKey}** 当前没有正在运行的 agent。`,
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Main Handler
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * `/project` command handler.
 *
 * Dispatches to subcommands based on `command.data.subcommand`.
 * Data is normalized by `normalizeCommandData()` before reaching this handler.
 */
export const handleProject: CommandHandler<'project'> = (
  command: ControlCommand<'project'>,
  context: ControlHandlerContext,
): ControlResponse => {
  const subcommand = command.data?.subcommand ?? 'info';

  switch (subcommand) {
    case 'use':
      return handleUse(command, context);
    case 'reset':
      return handleReset(command, context);
    case 'info':
      return handleInfo(command, context);
    case 'status':
      return handleStatus(command, context);
    case 'stop':
      return handleProjectStop(command, context);
    default:
      return {
        success: false,
        error: `未知子命令: ${subcommand}。可用: use, reset, info, status, stop`,
      };
  }
};
