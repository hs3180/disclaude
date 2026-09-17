/**
 * /project command handler.
 *
 * Provides commands for managing chatId → working directory bindings.
 *
 * Subcommands:
 * - `use <workingDir>` — Bind current chat to a working directory
 * - `reset` — Reset current chat to default workspace
 * - `info` — Show current chat's active project info
 *
 * @see Issue #3519 (simplify /project command)
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
 *
 * Issue #4448: resolve the *effective* cwd (what the agent will actually run
 * in), not just the bound target. When the bound directory is missing the
 * agent silently falls back to the workspace; surface that mismatch here
 * instead of reporting only the (stale) target.
 */
function handleInfo(command: ProjectCommand, context: ControlHandlerContext): ControlResponse {
  const pm = context.projectManager;
  if (!pm) {
    return {
      success: false,
      error: 'ProjectManager 未配置',
    };
  }

  const resolution = pm.resolveCwd(command.chatId);

  if (resolution.reason === 'unbound') {
    return {
      success: true,
      message: `📂 **当前项目**: default（工作空间根目录）\n\`${pm.getWorkspaceDir()}\``,
    };
  }

  // resolution.reason === 'bound' | 'bound-missing'
  const boundDir = resolution.boundWorkingDir as string;

  if (resolution.reason === 'bound-missing') {
    // Issue #4448: bound dir gone → agent silently falls back to workspace.
    // Show both the (stale) target and the actual run dir so the mismatch is
    // visible. Delivered via `message` (not `error`) because the chat command
    // router only relays `message` to the user.
    return {
      success: true,
      message: [
        `⚠️ **绑定目录不存在**: \`${boundDir}\``,
        '',
        `当前 chat 已绑定 \`${basename(boundDir)}\`，但该目录在磁盘上不可用，`,
        'Agent 实际将**回退到工作空间根目录**运行：',
        `- 绑定目标: \`${boundDir}\``,
        `- 实际运行: \`${pm.getWorkspaceDir()}\`（回退）`,
        '',
        '可能原因：容器重启时 volume 尚未就绪 / 目录被移动或卸载 / 路径大小写或规范化差异。',
        '可用 `/project reset` 回到默认，或 `/project use <dir>` 重新绑定。',
      ].join('\n'),
    };
  }

  // resolution.reason === 'bound' (directory exists)
  const state = readProjectState(boundDir);
  const issueCount = state ? Object.keys(state.issues).length : 0;
  const prCount = state ? Object.keys(state.prs).length : 0;
  const lastSync = state?.sync?.issues ?? '从不';

  return {
    success: true,
    message: [
      `📂 **当前项目**: ${basename(boundDir)}`,
      `**工作目录**: \`${boundDir}\``,
      `**实际运行**: \`${resolution.effectiveCwd}\` ✅`,
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
  context: ControlHandlerContext
): ControlResponse => {
  const subcommand = command.data?.subcommand ?? 'info';

  switch (subcommand) {
    case 'use':
      return handleUse(command, context);
    case 'reset':
      return handleReset(command, context);
    case 'info':
      return handleInfo(command, context);
    default:
      return {
        success: false,
        error: `未知子命令: ${subcommand}。可用: use, reset, info`,
      };
  }
};
