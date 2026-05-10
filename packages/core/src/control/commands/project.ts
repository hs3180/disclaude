/**
 * /project command handler.
 *
 * Provides admin commands for managing project instances and viewing project state.
 *
 * Subcommands:
 * - `list` — List all project instances and their bindings
 * - `status [projectKey]` — Show project agent status and state summary
 * - `info` — Show current chat's active project info
 * - `stop <name>` — Stop and dispose a project agent from the pool
 * - `trigger <name> [prompt]` — Trigger a task for a project agent
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
      message: '📋 **项目实例列表**\n\n暂无项目实例。',
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

/**
 * `/project stop <name>` — Stop and dispose a project agent from the pool.
 *
 * Finds the project instance by name, then disposes all ChatAgents
 * for chatIds bound to that instance.
 */
function handleStop(command: ControlCommand, context: ControlHandlerContext): ControlResponse {
  const pm = context.projectManager;
  if (!pm) {
    return {
      success: false,
      error: 'ProjectManager 未配置',
    };
  }

  const targetName = (command.data?.name as string) ?? '';
  if (!targetName) {
    return {
      success: false,
      error: '用法: /project stop <name>（请指定项目名称）',
    };
  }

  const instances = pm.listInstances();
  const target = instances.find((i) => i.name === targetName);
  if (!target) {
    return {
      success: false,
      error: `项目实例 "${targetName}" 不存在`,
    };
  }

  // Dispose all ChatAgents bound to this project instance
  const disposedChatIds: string[] = [];
  const notActiveChatIds: string[] = [];

  for (const chatId of target.chatIds) {
    if (context.agentPool.has(chatId)) {
      context.agentPool.dispose(chatId);
      disposedChatIds.push(chatId);
    } else {
      notActiveChatIds.push(chatId);
    }
  }

  const lines = [`🛑 **项目 ${targetName} 已停止**`];
  if (disposedChatIds.length > 0) {
    lines.push(`已释放 ${disposedChatIds.length} 个 Agent 会话`);
  }
  if (notActiveChatIds.length > 0) {
    lines.push(`${notActiveChatIds.length} 个会话无活跃 Agent（已跳过）`);
  }

  return {
    success: true,
    message: lines.join('\n'),
  };
}

/**
 * `/project trigger <name> [prompt]` — Trigger a task for a project agent.
 *
 * Finds the project instance by name, gets the first bound chatId,
 * and sends a prompt to the ChatAgent for that chatId.
 *
 * Uses the `triggerAgent` callback from context. If no prompt is provided,
 * sends a default "check project status" prompt.
 */
async function handleTrigger(command: ControlCommand, context: ControlHandlerContext): Promise<ControlResponse> {
  const pm = context.projectManager;
  if (!pm) {
    return {
      success: false,
      error: 'ProjectManager 未配置',
    };
  }

  const targetName = (command.data?.name as string) ?? '';
  if (!targetName) {
    return {
      success: false,
      error: '用法: /project trigger <name> [prompt]（请指定项目名称）',
    };
  }

  if (!context.triggerAgent) {
    return {
      success: false,
      error: 'triggerAgent 未配置（当前运行环境不支持触发项目任务）',
    };
  }

  const instances = pm.listInstances();
  const target = instances.find((i) => i.name === targetName);
  if (!target) {
    return {
      success: false,
      error: `项目实例 "${targetName}" 不存在`,
    };
  }

  if (target.chatIds.length === 0) {
    return {
      success: false,
      error: `项目 "${targetName}" 没有绑定任何会话，无法触发任务`,
    };
  }

  const [chatId] = target.chatIds;
  const prompt = (command.data?.prompt as string) ?? '请检查项目状态并汇报';

  try {
    await context.triggerAgent(chatId, prompt);
    return {
      success: true,
      message: `🚀 **项目 ${targetName} 任务已触发**\n\n目标会话: ${chatId}\n任务: ${prompt}`,
    };
  } catch (err) {
    return {
      success: false,
      error: `触发任务失败: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
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
): Promise<ControlResponse> | ControlResponse => {
  const subcommand = (command.data?.subcommand as string) ?? 'info';

  switch (subcommand) {
    case 'list':
      return handleList(context);
    case 'info':
      return handleInfo(command, context);
    case 'status':
      return handleStatus(command, context);
    case 'stop':
      return handleStop(command, context);
    case 'trigger':
      return handleTrigger(command, context);
    default:
      return {
        success: false,
        error: `未知子命令: ${subcommand}。可用: list, info, status, stop, trigger`,
      };
  }
};
