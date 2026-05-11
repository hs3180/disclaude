/**
 * /project command handler.
 *
 * Provides commands for managing project instances and viewing project state.
 *
 * Subcommands:
 * - `list` — List all project instances and their bindings
 * - `create <template> <name>` — Create a new project instance from template
 * - `use <name>` — Bind current chat to an existing instance
 * - `reset` — Reset current chat to default project
 * - `status [projectKey]` — Show project agent status and state summary
 * - `info` — Show current chat's active project info
 * - `templates` — List all available templates
 *
 * @see Issue #1916 (unified ProjectContext system)
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
 * `/project templates` — List all available templates.
 */
function handleTemplates(context: ControlHandlerContext): ControlResponse {
  const pm = context.projectManager;
  if (!pm) {
    return {
      success: false,
      error: 'ProjectManager 未配置',
    };
  }

  const templates = pm.listTemplates();
  if (templates.length === 0) {
    return {
      success: true,
      message: '📋 **可用模板**\n\n暂无模板。可在 disclaude.config.yaml 中配置 projectTemplates。',
    };
  }

  const lines = templates.map((t) => {
    const desc = t.description ? ` — ${t.description}` : '';
    const display = t.displayName ? ` (${t.displayName})` : '';
    return `- **${t.name}**${display}${desc}`;
  });

  return {
    success: true,
    message: `📋 **可用模板**\n\n${lines.join('\n')}`,
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
  const lastSync = state?.sync?.issues ?? '从不';

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
 * `/project create <template> <name>` — Create a new project instance from a template.
 *
 * Creates the instance, binds it to the requesting chatId, and resets the
 * ChatAgent session so the next message uses the new working directory.
 */
function handleCreate(command: ControlCommand, context: ControlHandlerContext): ControlResponse {
  const pm = context.projectManager;
  if (!pm) {
    return {
      success: false,
      error: 'ProjectManager 未配置',
    };
  }

  const templateName = command.data?.templateName as string | undefined;
  const instanceName = command.data?.instanceName as string | undefined;

  if (!templateName) {
    return {
      success: false,
      error: '用法: /project create <template> <name>\n使用 /project templates 查看可用模板',
    };
  }

  if (!instanceName) {
    return {
      success: false,
      error: '用法: /project create <template> <name>\n请指定实例名称',
    };
  }

  const result = pm.create(command.chatId, templateName, instanceName);
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
      `✅ **项目实例已创建**: ${result.data.name}`,
      `**模板**: ${result.data.templateName}`,
      `**工作目录**: \`${result.data.workingDir}\``,
      '',
      'Agent 会话已重置，下次对话将使用新工作目录。',
    ].join('\n'),
  };
}

/**
 * `/project use <name>` — Bind current chat to an existing instance.
 */
function handleUse(command: ControlCommand, context: ControlHandlerContext): ControlResponse {
  const pm = context.projectManager;
  if (!pm) {
    return {
      success: false,
      error: 'ProjectManager 未配置',
    };
  }

  const instanceName = command.data?.instanceName as string | undefined;

  if (!instanceName) {
    return {
      success: false,
      error: '用法: /project use <name>\n使用 /project list 查看已有实例',
    };
  }

  const result = pm.use(command.chatId, instanceName);
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
      `✅ **已切换到项目**: ${result.data.name}`,
      `**工作目录**: \`${result.data.workingDir}\``,
      '',
      'Agent 会话已重置，下次对话将使用新工作目录。',
    ].join('\n'),
  };
}

/**
 * `/project reset` — Reset current chat to default project.
 */
function handleReset(command: ControlCommand, context: ControlHandlerContext): ControlResponse {
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
      `**Issues 同步**: ${state.sync.issues ?? '从不'}`,
      `**PRs 同步**: ${state.sync.prs ?? '从不'}`,
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
    case 'templates':
      return handleTemplates(context);
    case 'create':
      return handleCreate(command, context);
    case 'use':
      return handleUse(command, context);
    case 'reset':
      return handleReset(command, context);
    case 'info':
      return handleInfo(command, context);
    case 'status':
      return handleStatus(command, context);
    default:
      return {
        success: false,
        error: `未知子命令: ${subcommand}。可用: list, templates, create, use, reset, info, status`,
      };
  }
};
