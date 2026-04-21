/**
 * /project command handler — unified ProjectContext system.
 *
 * Supports sub-commands: list, create, use, info, reset.
 *
 * @see Issue #1916 — unified ProjectContext system
 * @see docs/proposals/unified-project-context.md
 */

import type { ControlCommand, ControlResponse } from '../../types/channel.js';
import type { ControlHandlerContext, CommandHandler } from '../types.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Sub-command types
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

type ProjectSubCommand = 'list' | 'create' | 'use' | 'info' | 'reset';

/**
 * Parse the /project command into sub-command and arguments.
 *
 * Supported formats:
 * - `/project` → { sub: 'list', args: [] }
 * - `/project list` → { sub: 'list', args: [] }
 * - `/project create research my-project` → { sub: 'create', args: ['research', 'my-project'] }
 * - `/project use my-project` → { sub: 'use', args: ['my-project'] }
 * - `/project info` → { sub: 'info', args: [] }
 * - `/project reset` → { sub: 'reset', args: [] }
 */
function parseProjectCommand(command: ControlCommand): {
  sub: ProjectSubCommand;
  args: string[];
} {
  const raw = (command.data?.args as string[] | undefined) ?? [];
  const text = (command.data?.text as string | undefined) ?? '';

  // If args array is provided, use it
  if (raw.length > 0) {
    const sub = parseSubCommand(raw[0]);
    return { sub, args: raw.slice(1) };
  }

  // Fallback: parse from text (e.g. "create research my-project")
  const parts = text.trim().split(/\s+/).filter(Boolean);
  if (parts.length > 0) {
    const sub = parseSubCommand(parts[0]);
    return { sub, args: parts.slice(1) };
  }

  // No args → default to list
  return { sub: 'list', args: [] };
}

function parseSubCommand(raw: string): ProjectSubCommand {
  const lower = raw.toLowerCase();
  if (lower === 'create' || lower === 'new') {return 'create';}
  if (lower === 'use' || lower === 'switch') {return 'use';}
  if (lower === 'info' || lower === 'show') {return 'info';}
  if (lower === 'reset' || lower === 'default') {return 'reset';}
  return 'list'; // 'list' or any unrecognized → show list
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Sub-command handlers
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function handleProjectList(context: ControlHandlerContext): ControlResponse {
  const pm = context.projectManager;
  if (!pm) {
    return { success: false, error: 'ProjectContext 系统未启用' };
  }

  const templates = pm.listTemplates();
  const instances = pm.listInstances();

  const lines: string[] = [
    '📁 **Project 列表**',
    '',
  ];

  // Templates section
  if (templates.length > 0) {
    lines.push('**可用模板：**');
    for (const t of templates) {
      const desc = t.description ? ` — ${t.description}` : '';
      const display = t.displayName ? ` (${t.displayName})` : '';
      lines.push(`- \`${t.name}\`${display}${desc}`);
    }
    lines.push('');
  } else {
    lines.push('*暂无可用模板*');
    lines.push('');
  }

  // Instances section
  if (instances.length > 0) {
    lines.push('**已创建实例：**');
    for (const inst of instances) {
      const chatCount = inst.chatIds.length;
      const chatInfo = chatCount > 0 ? ` (${chatCount} 个会话绑定)` : ' (无绑定)';
      lines.push(`- \`${inst.name}\` ← \`${inst.templateName}\`${chatInfo}`);
    }
  } else {
    lines.push('*暂无已创建实例*');
  }

  lines.push('');
  lines.push('使用 `/project create <模板> <名称>` 创建新实例');

  return { success: true, message: lines.join('\n') };
}

function handleProjectCreate(
  args: string[],
  chatId: string,
  context: ControlHandlerContext,
): ControlResponse {
  const pm = context.projectManager;
  if (!pm) {
    return { success: false, error: 'ProjectContext 系统未启用' };
  }

  if (args.length < 2) {
    return {
      success: false,
      error: '用法：`/project create <模板名> <实例名>`\n\n使用 `/project list` 查看可用模板',
    };
  }

  const [templateName, name] = args;
  const result = pm.create(chatId, templateName, name);

  if (!result.ok) {
    return { success: false, error: `❌ 创建失败：${result.error}` };
  }

  context.agentPool.reset(chatId);
  context.logger?.info({ chatId, project: name, template: templateName }, 'Project created and session reset');

  return {
    success: true,
    message: [
      `✅ **实例已创建：\`${name}\`**`,
      '',
      `- 模板：\`${templateName}\``,
      `- 工作目录：\`${result.data.workingDir}\``,
      '',
      'Agent 会话已重置，将在新的项目上下文中启动。',
    ].join('\n'),
  };
}

function handleProjectUse(
  args: string[],
  chatId: string,
  context: ControlHandlerContext,
): ControlResponse {
  const pm = context.projectManager;
  if (!pm) {
    return { success: false, error: 'ProjectContext 系统未启用' };
  }

  if (args.length < 1) {
    return {
      success: false,
      error: '用法：`/project use <实例名>`\n\n使用 `/project list` 查看已创建实例',
    };
  }

  const [name] = args;
  const result = pm.use(chatId, name);

  if (!result.ok) {
    return { success: false, error: `❌ 切换失败：${result.error}` };
  }

  context.agentPool.reset(chatId);
  context.logger?.info({ chatId, project: name }, 'Project switched and session reset');

  return {
    success: true,
    message: [
      `🔄 **已切换到：\`${name}\`**`,
      '',
      `- 模板：\`${result.data.templateName}\``,
      `- 工作目录：\`${result.data.workingDir}\``,
      '',
      'Agent 会话已重置，将在新的项目上下文中启动。',
    ].join('\n'),
  };
}

function handleProjectInfo(
  chatId: string,
  context: ControlHandlerContext,
): ControlResponse {
  const pm = context.projectManager;
  if (!pm) {
    return { success: false, error: 'ProjectContext 系统未启用' };
  }

  const active = pm.getActive(chatId);
  const lines: string[] = ['📋 **当前 Project**', ''];

  if (active.name === 'default') {
    lines.push('- 模式：**默认**（workspace 根目录）');
    lines.push(`- 工作目录：\`${  active.workingDir  }\``);
  } else {
    lines.push(`- 实例：**\`${  active.name  }\`**`);
    lines.push(`- 模板：\`${  active.templateName ?? '未知'  }\``);
    lines.push(`- 工作目录：\`${  active.workingDir  }\``);
  }

  return { success: true, message: lines.join('\n') };
}

function handleProjectReset(
  chatId: string,
  context: ControlHandlerContext,
): ControlResponse {
  const pm = context.projectManager;
  if (!pm) {
    return { success: false, error: 'ProjectContext 系统未启用' };
  }

  const result = pm.reset(chatId);

  if (!result.ok) {
    return { success: false, error: `❌ 重置失败：${result.error}` };
  }

  context.agentPool.reset(chatId);
  context.logger?.info({ chatId }, 'Project reset to default and session reset');

  return {
    success: true,
    message: [
      '🏠 **已重置为默认 Project**',
      '',
      'Agent 会话已重置，将在默认工作目录中启动。',
    ].join('\n'),
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Main handler
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * /project command handler — ProjectContext management.
 *
 * Sub-commands:
 * - `/project list` — list templates and instances
 * - `/project create <template> <name>` — create instance from template
 * - `/project use <name>` — bind to existing instance
 * - `/project info` — show current project details
 * - `/project reset` — reset to default project
 *
 * @see Issue #1916
 */
export const handleProject: CommandHandler = (
  command: ControlCommand,
  context: ControlHandlerContext,
): ControlResponse => {
  const { sub, args } = parseProjectCommand(command);

  switch (sub) {
    case 'list':
      return handleProjectList(context);
    case 'create':
      return handleProjectCreate(args, command.chatId, context);
    case 'use':
      return handleProjectUse(args, command.chatId, context);
    case 'info':
      return handleProjectInfo(command.chatId, context);
    case 'reset':
      return handleProjectReset(command.chatId, context);
  }
};
