/**
 * /project command handler.
 *
 * Provides commands for managing chatId → working directory bindings
 * and config-driven project management.
 *
 * Subcommands:
 * - `use <workingDir>` — Bind current chat to a working directory
 * - `reset` — Reset current chat to default workspace
 * - `info` — Show current chat's active project info
 * - `status` — Show all configured projects and their agent status (Issue #3583)
 * - `trigger <key> [prompt]` — Manually trigger a SystemMessage to a project (Issue #3583)
 * - `stop <key>` — Stop a specific project's agent (Issue #3583)
 *
 * @see Issue #3519 (simplify /project command)
 * @see Issue #1916 (unified ProjectContext system)
 * @see Issue #3529 (typed command data)
 * @see Issue #3583 (Phase 5: projects config + admin commands)
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
 * `/project status` — Show all configured projects and their agent status.
 *
 * Lists projects from disclaude.config.yaml and shows which ones have
 * active agent sessions.
 *
 * @see Issue #3583 (Phase 5: projects config + admin commands)
 */
function handleStatus(_command: ProjectCommand, context: ControlHandlerContext): ControlResponse {
  const pm = context.projectManager;
  if (!pm) {
    return {
      success: false,
      error: 'ProjectManager 未配置',
    };
  }

  const projects = pm.listConfigProjects();

  if (projects.length === 0) {
    return {
      success: true,
      message: '📋 **项目列表**: 无已配置项目\n\n在 disclaude.config.yaml 中添加 projects 配置。',
    };
  }

  const lines = ['📋 **已配置项目**:', ''];

  for (const project of projects) {
    const active = pm.getActive(project.chatId);
    const isDefault = active.name === 'default';
    const statusIcon = isDefault ? '⏸️' : '▶️';
    const tier = project.modelTier ? ` (${project.modelTier})` : '';

    lines.push(`${statusIcon} **${project.key}**${tier}`);
    lines.push(`   工作目录: \`${project.workingDir}\``);
    lines.push(`   ChatId: \`${project.chatId}\``);
    lines.push('');
  }

  return {
    success: true,
    message: lines.join('\n'),
  };
}

/**
 * `/project trigger <key> [prompt]` — Manually trigger a SystemMessage to a project.
 *
 * Finds the project by key from disclaude.config.yaml and sends a SystemMessage
 * to its bound chatId via the agentPool.
 *
 * @see Issue #3583 (Phase 5: projects config + admin commands)
 */
function handleTrigger(command: ProjectCommand, context: ControlHandlerContext): ControlResponse {
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
      error: '用法: /project trigger <key> [prompt]\n请指定项目 key（如 hs3180/disclaude）',
    };
  }

  const project = pm.getConfigProject(projectKey);
  if (!project) {
    const available = pm.listConfigProjects().map(p => p.key);
    return {
      success: false,
      error: `项目 \`${projectKey}\` 未找到。\n可用项目: ${available.length > 0 ? available.join(', ') : '无'}`,
    };
  }

  // The trigger sends a message to the project's bound chatId.
  // For now, this resets the agent for that chatId and returns confirmation.
  // Full SystemMessage routing requires Phase 1-3 (InputMessageRouter) to be merged.
  context.agentPool.reset(project.chatId);

  const prompt = command.data?.prompt;
  const promptInfo = prompt ? `\n提示: "${prompt}"` : '';

  return {
    success: true,
    message: [
      `✅ **已触发项目**: ${project.key}`,
      `ChatId: \`${project.chatId}\``,
      promptInfo,
      '',
      'Agent 会话已重置，等待下次消息触发。',
    ].filter(Boolean).join('\n'),
  };
}

/**
 * `/project stop <key>` — Stop a specific project's agent.
 *
 * Finds the project by key and stops its agent session.
 *
 * @see Issue #3583 (Phase 5: projects config + admin commands)
 */
function handleStop(command: ProjectCommand, context: ControlHandlerContext): ControlResponse {
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
      error: '用法: /project stop <key>\n请指定项目 key（如 hs3180/disclaude）',
    };
  }

  const project = pm.getConfigProject(projectKey);
  if (!project) {
    const available = pm.listConfigProjects().map(p => p.key);
    return {
      success: false,
      error: `项目 \`${projectKey}\` 未找到。\n可用项目: ${available.length > 0 ? available.join(', ') : '无'}`,
    };
  }

  const stopped = context.agentPool.stop(project.chatId);

  return {
    success: true,
    message: stopped
      ? `⏹️ **已停止项目 Agent**: ${project.key}\nChatId: \`${project.chatId}\``
      : `ℹ️ 项目 ${project.key} 没有正在运行的 Agent`,
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
    case 'trigger':
      return handleTrigger(command, context);
    case 'stop':
      return handleStop(command, context);
    default:
      return {
        success: false,
        error: `未知子命令: ${subcommand}。可用: use, reset, info, status, trigger, stop`,
      };
  }
};
