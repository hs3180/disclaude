/**
 * /project command handler.
 *
 * Provides admin commands for managing project instances and viewing project state.
 *
 * Subcommands:
 * - `list` — List all project instances and their bindings
 * - `status [projectKey]` — Show project agent status and state summary
 * - `info` — Show current chat's active project info
 *
 * Note: `trigger` and `stop` subcommands require Phase 2 (Issue #3332)
 * for project-scoped ChatAgent support and are not yet implemented.
 *
 * @see Issue #3335 (Project state persistence and admin commands)
 */

import type { ControlCommand, ControlResponse } from '../../types/channel.js';
import type { ControlHandlerContext, CommandHandler } from '../types.js';
import { readProjectState } from '../../project/project-state.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Subcommand Handlers
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * `/project list` — List all project instances.
 */
function handleList(context: ControlHandlerContext): ControlResponse {
  const pm = context.projectManager;
  if (!pm) {
    return {
      success: false,
      error: 'ProjectManager 未配置',
    };
  }

  const instances = pm.listInstances();
  if (instances.length === 0) {
    return {
      success: true,
      message: '📋 **项目实例列表**\n\n暂无项目实例。使用 `/project create <template> <name>` 创建。',
    };
  }

  const lines = instances.map((inst) => {
    const chatCount = inst.chatIds.length;
    const bindingInfo = chatCount > 0 ? `绑定 ${chatCount} 个会话` : '无绑定';
    return `- **${inst.name}** (${inst.templateName}) — ${bindingInfo}\n  \`${inst.workingDir}\``;
  });

  return {
    success: true,
    message: `📋 **项目实例列表**\n\n${lines.join('\n')}`,
  };
}

/**
 * `/project info` — Show current chat's active project.
 */
function handleInfo(command: ControlCommand, context: ControlHandlerContext): ControlResponse {
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
      message: '📂 **当前项目**: default（工作空间根目录）',
    };
  }

  // Try to read project state
  const state = readProjectState(active.workingDir);
  const issueCount = state ? Object.keys(state.issues).length : 0;
  const prCount = state ? Object.keys(state.prs).length : 0;
  const lastSync = state?.sync?.issues ?? '从未';

  return {
    success: true,
    message: [
      `📂 **当前项目**: ${active.name}`,
      `**模板**: ${active.templateName ?? '无'}`,
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
 * `/project status [name]` — Show detailed status for a project instance.
 */
function handleStatus(command: ControlCommand, context: ControlHandlerContext): ControlResponse {
  const pm = context.projectManager;
  if (!pm) {
    return {
      success: false,
      error: 'ProjectManager 未配置',
    };
  }

  const targetName = (command.data?.name as string) ?? '';
  let workingDir: string;
  let displayName: string;

  if (targetName) {
    const instances = pm.listInstances();
    const target = instances.find((i) => i.name === targetName);
    if (!target) {
      return {
        success: false,
        error: `项目实例 "${targetName}" 不存在`,
      };
    }
    const { workingDir: wd, name } = target;
    workingDir = wd;
    displayName = name;
  } else {
    // Use current chat's active project
    const active = pm.getActive(command.chatId);
    if (active.name === 'default') {
      return {
        success: true,
        message: '📂 当前会话未绑定项目（使用 default 工作空间）',
      };
    }
    const { workingDir: wd, name } = active;
    workingDir = wd;
    displayName = name;
  }

  const state = readProjectState(workingDir);
  if (!state) {
    return {
      success: true,
      message: `📊 **项目 ${displayName} 状态**\n\n暂无状态数据（.disclaude/project-state.json 不存在）`,
    };
  }

  const issueEntries = Object.entries(state.issues);
  const prEntries = Object.entries(state.prs);

  const issueLines = issueEntries.length > 0
    ? issueEntries.slice(0, 10).map(([num, issue]) =>
        `- #${num} ${issue.title} [${issue.triageStatus}] ${issue.state === 'open' ? '🟢' : '🔴'}`
      ).join('\n') + (issueEntries.length > 10 ? `\n... 还有 ${issueEntries.length - 10} 个` : '')
    : '无';

  const prLines = prEntries.length > 0
    ? prEntries.slice(0, 10).map(([num, pr]) =>
        `- PR #${num} ${pr.title} [${pr.reviewStatus}]${pr.issueNumber ? ` → #${pr.issueNumber}` : ''}`
      ).join('\n') + (prEntries.length > 10 ? `\n... 还有 ${prEntries.length - 10} 个` : '')
    : '无';

  return {
    success: true,
    message: [
      `📊 **项目 ${displayName} 状态**`,
      `**Key**: ${state.projectKey}`,
      `**最后活跃**: ${state.lastActive}`,
      `**Issues 同步**: ${state.sync.issues ?? '从未'}`,
      `**PRs 同步**: ${state.sync.prs ?? '从未'}`,
      '',
      `**Issues (${issueEntries.length})**`,
      issueLines,
      '',
      `**PRs (${prEntries.length})**`,
      prLines,
    ].join('\n'),
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Main Handler
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * `/project` command handler.
 *
 * Dispatches to subcommands based on `command.data.subcommand`.
 */
export const handleProject: CommandHandler = (
  command: ControlCommand,
  context: ControlHandlerContext,
): ControlResponse => {
  const subcommand = (command.data?.subcommand as string) ?? 'info';

  switch (subcommand) {
    case 'list':
      return handleList(context);
    case 'info':
      return handleInfo(command, context);
    case 'status':
      return handleStatus(command, context);
    default:
      return {
        success: false,
        error: `未知子命令: ${subcommand}。可用: list, info, status`,
      };
  }
};
