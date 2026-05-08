/**
 * /project command handler — Project context switching.
 *
 * Manages per-chatId Agent context by switching working directories.
 * When a project is switched, the agent session is reset so the next
 * message starts a new session in the project's working directory.
 *
 * Sub-commands:
 * - list:   Show available templates and existing instances
 * - create: Create a new instance from a template
 * - use:    Bind to an existing instance
 * - info:   Show current project details
 * - reset:  Reset to default project
 *
 * @see Issue #1916 Phase 2 (integration layer)
 * @see docs/proposals/unified-project-context.md §4.3 Command Design
 */

import type { ControlCommand, ControlResponse } from '../../types/channel.js';
import type { ControlHandlerContext, CommandHandler } from '../types.js';

/**
 * /project command handler.
 *
 * Dispatches to sub-command handlers based on args[0].
 * Resets agent session on create/use/reset to ensure the next message
 * picks up the new working directory via CwdProvider.
 */
export const handleProject: CommandHandler = (
  command: ControlCommand,
  context: ControlHandlerContext,
): ControlResponse => {
  const { chatId } = command;
  const pm = context.projectManager;

  if (!pm) {
    return {
      success: false,
      message: '⚠️ ProjectManager 未初始化。请在配置中启用 projectTemplates。',
    };
  }

  const args = (command.data?.args as string[]) || [];
  const [sub] = args;

  switch (sub) {
    case 'list':
      return handleList(pm);
    case 'create':
      return handleCreate(chatId, args, pm, context);
    case 'use':
      return handleUse(chatId, args, pm, context);
    case 'info':
      return handleInfo(chatId, pm);
    case 'reset':
      return handleReset(chatId, pm, context);
    default:
      return {
        success: false,
        message: [
          `❌ 未知子命令: "${sub || ''}"`,
          '',
          '可用命令:',
          '/project list                          — 列出可用模板和实例',
          '/project create <template> <name>       — 从模板创建新实例',
          '/project use <name>                    — 切换到已有实例',
          '/project info                          — 查看当前项目',
          '/project reset                          — 重置为默认',
        ].join('\n'),
      };
  }
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Sub-command Handlers
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function handleList(pm: NonNullable<ControlHandlerContext['projectManager']>): ControlResponse {
  const templates = pm.listTemplates();
  const instances = pm.listInstances();

  const lines: string[] = ['📋 **Project 列表**', ''];

  // Templates section
  if (templates.length > 0) {
    lines.push('**可用模板:**');
    for (const t of templates) {
      const desc = t.description ? ` — ${t.description}` : '';
      const display = t.displayName ? ` (${t.displayName})` : '';
      lines.push(`  - \`${t.name}\`${display}${desc}`);
    }
  } else {
    lines.push('**可用模板:** 无（未配置 projectTemplates）');
  }

  lines.push('');

  // Instances section
  if (instances.length > 0) {
    lines.push('**已创建实例:**');
    for (const inst of instances) {
      const binding = inst.chatIds.length > 0
        ? ` [${inst.chatIds.length} 个绑定]`
        : '';
      lines.push(`  - \`${inst.name}\` (模板: ${inst.templateName})${binding}`);
    }
  } else {
    lines.push('**已创建实例:** 无');
  }

  return { success: true, message: lines.join('\n') };
}

function handleCreate(
  chatId: string,
  args: string[],
  pm: NonNullable<ControlHandlerContext['projectManager']>,
  context: ControlHandlerContext,
): ControlResponse {
  if (!args[1] || !args[2]) {
    return {
      success: false,
      message: '❌ 用法: /project create <template> <name>\n\n示例: /project create research my-research',
    };
  }

  const result = pm.create(chatId, args[1], args[2]);
  if (!result.ok) {
    return { success: false, message: `❌ ${result.error}` };
  }

  // Reset agent session so next message uses the new working directory
  context.agentPool.reset(chatId);

  return {
    success: true,
    message: `✅ 已创建并切换到项目 **${args[2]}** (模板: ${args[1]})`,
  };
}

function handleUse(
  chatId: string,
  args: string[],
  pm: NonNullable<ControlHandlerContext['projectManager']>,
  context: ControlHandlerContext,
): ControlResponse {
  if (!args[1]) {
    return {
      success: false,
      message: '❌ 用法: /project use <name>\n\n示例: /project use my-research',
    };
  }

  const result = pm.use(chatId, args[1]);
  if (!result.ok) {
    return { success: false, message: `❌ ${result.error}` };
  }

  // Reset agent session so next message uses the new working directory
  context.agentPool.reset(chatId);

  return {
    success: true,
    message: `✅ 已切换到项目 **${args[1]}**`,
  };
}

function handleInfo(
  chatId: string,
  pm: NonNullable<ControlHandlerContext['projectManager']>,
): ControlResponse {
  const active = pm.getActive(chatId);

  const lines: string[] = ['📊 **当前项目信息**', ''];
  lines.push(`- **名称**: ${active.name}`);
  if (active.templateName) {
    lines.push(`- **模板**: ${active.templateName}`);
  }
  lines.push(`- **工作目录**: \`${active.workingDir}\``);

  if (active.name === 'default') {
    lines.push('', '_当前使用默认项目（workspace 根目录）_');
  }

  return { success: true, message: lines.join('\n') };
}

function handleReset(
  chatId: string,
  pm: NonNullable<ControlHandlerContext['projectManager']>,
  context: ControlHandlerContext,
): ControlResponse {
  const result = pm.reset(chatId);
  if (!result.ok) {
    return { success: false, message: `❌ ${result.error}` };
  }

  // Reset agent session to pick up default working directory
  context.agentPool.reset(chatId);

  return {
    success: true,
    message: '✅ 已重置为默认项目',
  };
}
