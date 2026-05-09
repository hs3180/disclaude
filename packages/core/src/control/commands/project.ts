/**
 * /project command handler — manage per-chatId project context.
 *
 * Subcommands:
 *   /project              — show current project info (with state summary)
 *   /project list         — list all instances
 *   /project templates    — list available templates
 *   /project create <template> <name> — create instance from template
 *   /project use <name>   — switch to an existing instance
 *   /project reset        — revert to default project
 *   /project status [name] — show detailed project state
 *
 * On switch (create/use/reset), the agent session is reset so the next
 * message starts a fresh SDK query in the new working directory.
 *
 * @see Issue #3335 (Project state persistence)
 * @see Issue #1916 Phase 2 (ProjectManager integration)
 * @module control/commands/project
 */

import type { ControlCommand, ControlResponse } from '../../types/channel.js';
import type { ControlHandlerContext, CommandHandler } from '../types.js';
import { readProjectState } from '../../project/project-state.js';

/**
 * Parse subcommand and positional args from command.data.
 */
function parseArgs(command: ControlCommand): { sub: string; positional: string[] } {
  const raw = command.data?.args;
  const tokens: string[] = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/\s+/).filter(Boolean) : [];
  const sub = tokens[0] ?? '';
  const positional = tokens.slice(1);
  return { sub, positional };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Main Handler
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * `/project` command handler.
 */
export const handleProject: CommandHandler = (
  command: ControlCommand,
  context: ControlHandlerContext,
): ControlResponse => {
  const pm = context.projectManager;
  if (!pm) {
    return {
      success: false,
      message: '⚠️ Project 功能当前不可用。请检查配置。',
    };
  }

  const { chatId } = command;
  const { sub, positional } = parseArgs(command);

  switch (sub) {
    case '':
    case 'info':
      return handleInfo(pm, chatId);

    case 'list':
    case 'instances':
      return handleList(pm);

    case 'templates':
      return handleTemplates(pm);

    case 'create':
      return handleCreate(pm, chatId, positional, context);

    case 'use':
      return handleUse(pm, chatId, positional, context);

    case 'reset':
      return handleReset(pm, chatId, context);

    case 'status':
      return handleStatus(pm, chatId, positional);

    default:
      return {
        success: false,
        message: [
          `⚠️ 未知子命令: "${sub}"`,
          '',
          '用法: `/project [info|list|status|templates|create|use|reset]`',
          '',
          '- `/project` — 查看当前项目',
          '- `/project list` — 列出所有实例',
          '- `/project status [name]` — 查看项目状态详情',
          '- `/project templates` — 列出可用模板',
          '- `/project create <template> <name>` — 从模板创建实例',
          '- `/project use <name>` — 切换到已有实例',
          '- `/project reset` — 重置为默认项目',
        ].join('\n'),
      };
  }
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Subcommand Handlers
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function handleInfo(
  pm: NonNullable<ControlHandlerContext['projectManager']>,
  chatId: string,
): ControlResponse {
  const active = pm.getActive(chatId);
  if (active.name === 'default') {
    return {
      success: true,
      message: '📍 当前项目: **default**（工作空间根目录）',
    };
  }

  // Show state summary (from Issue #3335)
  const state = readProjectState(active.workingDir);
  const issueCount = state ? Object.keys(state.issues).length : 0;
  const prCount = state ? Object.keys(state.prs).length : 0;
  const lastSync = state?.sync?.issues ?? '从未';

  return {
    success: true,
    message: [
      `📍 当前项目: **${active.name}**`,
      `- 模板: ${active.templateName ?? '—'}`,
      `- 工作目录: \`${active.workingDir}\``,
      '',
      '**状态摘要**:',
      `- Issues: ${issueCount} 个已追踪`,
      `- PRs: ${prCount} 个已追踪`,
      `- 上次同步: ${lastSync}`,
    ].join('\n'),
  };
}

function handleList(
  pm: NonNullable<ControlHandlerContext['projectManager']>,
): ControlResponse {
  const instances = pm.listInstances();
  if (instances.length === 0) {
    return {
      success: true,
      message: '📋 暂无项目实例。',
    };
  }

  const lines = ['📋 **项目实例**:', ''];
  for (const inst of instances) {
    lines.push(`- **${inst.name}** (模板: ${inst.templateName})`);
    lines.push(`  工作目录: \`${inst.workingDir}\``);
    if (inst.chatIds.length > 0) {
      lines.push(`  绑定会话: ${inst.chatIds.length} 个`);
    }
  }
  return { success: true, message: lines.join('\n') };
}

function handleTemplates(
  pm: NonNullable<ControlHandlerContext['projectManager']>,
): ControlResponse {
  const templates = pm.listTemplates();
  if (templates.length === 0) {
    return {
      success: true,
      message: '📋 暂无可用模板。请在配置文件中添加 projectTemplates。',
    };
  }

  const lines = ['📋 **可用模板**:', ''];
  for (const t of templates) {
    const desc = t.description ? ` — ${t.description}` : '';
    const display = t.displayName ? ` (${t.displayName})` : '';
    lines.push(`- **${t.name}**${display}${desc}`);
  }
  lines.push('', '使用 `/project create <template> <name>` 创建实例');
  return { success: true, message: lines.join('\n') };
}

function handleCreate(
  pm: NonNullable<ControlHandlerContext['projectManager']>,
  chatId: string,
  positional: string[],
  context: ControlHandlerContext,
): ControlResponse {
  const [templateName, instanceName] = positional;
  if (!templateName || !instanceName) {
    return {
      success: false,
      message: '⚠️ 用法: `/project create <template> <name>`',
    };
  }

  const result = pm.create(chatId, templateName, instanceName);
  if (!result.ok) {
    return { success: false, message: `❌ 创建失败: ${result.error}` };
  }

  // Reset agent session so next message uses new cwd
  context.agentPool.reset(chatId);

  const {data} = result;
  return {
    success: true,
    message: [
      `✅ 项目实例 **${data.name}** 已创建`,
      `- 模板: ${data.templateName}`,
      `- 工作目录: \`${data.workingDir}\``,
      '',
      '会话已重置，下一条消息将在新的工作目录中执行。',
    ].join('\n'),
  };
}

function handleUse(
  pm: NonNullable<ControlHandlerContext['projectManager']>,
  chatId: string,
  positional: string[],
  context: ControlHandlerContext,
): ControlResponse {
  const [instanceName] = positional;
  if (!instanceName) {
    return {
      success: false,
      message: '⚠️ 用法: `/project use <name>`',
    };
  }

  const result = pm.use(chatId, instanceName);
  if (!result.ok) {
    return { success: false, message: `❌ 切换失败: ${result.error}` };
  }

  // Reset agent session so next message uses new cwd
  context.agentPool.reset(chatId);

  const {data} = result;
  return {
    success: true,
    message: [
      `✅ 已切换到项目 **${data.name}**`,
      `- 工作目录: \`${data.workingDir}\``,
      '',
      '会话已重置，下一条消息将在新的工作目录中执行。',
    ].join('\n'),
  };
}

function handleReset(
  pm: NonNullable<ControlHandlerContext['projectManager']>,
  chatId: string,
  context: ControlHandlerContext,
): ControlResponse {
  const result = pm.reset(chatId);
  if (!result.ok) {
    return { success: false, message: `❌ 重置失败: ${result.error}` };
  }

  // Reset agent session so next message uses default cwd
  context.agentPool.reset(chatId);

  return {
    success: true,
    message: '✅ 已重置为 **default** 项目（工作空间根目录）。\n\n会话已重置，下一条消息将在默认工作目录中执行。',
  };
}

/**
 * `/project status [name]` — Show detailed status for a project instance.
 * From Issue #3335: reads .disclaude/project-state.json for issue/PR tracking.
 */
function handleStatus(
  pm: NonNullable<ControlHandlerContext['projectManager']>,
  chatId: string,
  positional: string[],
): ControlResponse {
  const targetName = positional[0] ?? '';
  let workingDir: string;
  let displayName: string;

  if (targetName) {
    const instances = pm.listInstances();
    const target = instances.find((i) => i.name === targetName);
    if (!target) {
      return {
        success: false,
        message: `❌ 项目实例 "${targetName}" 不存在`,
      };
    }
    workingDir = target.workingDir;
    displayName = target.name;
  } else {
    const active = pm.getActive(chatId);
    if (active.name === 'default') {
      return {
        success: true,
        message: '📂 当前会话未绑定项目（使用 default 工作空间）',
      };
    }
    workingDir = active.workingDir;
    displayName = active.name;
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
