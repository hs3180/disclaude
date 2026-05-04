/**
 * /project 命令处理 — 管理 per-chatId 的 Agent 上下文切换。
 *
 * Sub-commands:
 *   /project list                    → 列出所有可用模板 + 已创建实例
 *   /project create <template> <name> → 从模板创建新实例
 *   /project use <name>              → 绑定到已有实例
 *   /project info                    → 查看当前 project 详情
 *   /project reset                   → 重置为 default
 *
 * @see Issue #1916 Phase 2 — unified ProjectContext system
 */

import type { ControlCommand, ControlResponse } from '../../types/channel.js';
import type { ControlHandlerContext, CommandHandler } from '../types.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Sub-command types
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

type SubCommand = 'list' | 'create' | 'use' | 'info' | 'reset';

interface ParsedArgs {
  subCommand: SubCommand | null;
  args: string[];
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Argument parsing
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const VALID_SUB_COMMANDS = new Set<string>(['list', 'create', 'use', 'info', 'reset']);

/**
 * Parse command data into sub-command and positional arguments.
 *
 * Accepts args from command.data.args (string or string[]).
 */
function parseArgs(command: ControlCommand): ParsedArgs {
  const rawArgs = command.data?.args;

  // Normalize to string[]
  let parts: string[];
  if (Array.isArray(rawArgs)) {
    parts = rawArgs.filter((a): a is string => typeof a === 'string');
  } else if (typeof rawArgs === 'string' && rawArgs.length > 0) {
    parts = rawArgs.split(/\s+/).filter(Boolean);
  } else {
    return { subCommand: null, args: [] };
  }

  if (parts.length === 0) {
    return { subCommand: null, args: [] };
  }

  const first = parts[0].toLowerCase();
  if (VALID_SUB_COMMANDS.has(first)) {
    return { subCommand: first as SubCommand, args: parts.slice(1) };
  }

  // No recognized sub-command
  return { subCommand: null, args: parts };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Sub-command handlers
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * /project list — 列出所有可用模板和已创建实例
 */
function handleList(context: ControlHandlerContext): ControlResponse {
  const pm = context.projectManager;
  if (!pm) {
    return {
      success: false,
      message: '⚠️ Project 功能未启用。请在配置中设置 `projectTemplates`。',
    };
  }

  const templates = pm.listTemplates();
  const instances = pm.listInstances();

  const lines: string[] = ['📁 **Project 列表**', ''];

  // Templates section
  if (templates.length > 0) {
    lines.push('**可用模板:**');
    for (const t of templates) {
      const display = t.displayName ? ` (${t.displayName})` : '';
      const desc = t.description ? ` — ${t.description}` : '';
      lines.push(`  • \`${t.name}\`${display}${desc}`);
    }
  } else {
    lines.push('**可用模板:** 无');
  }

  lines.push('');

  // Instances section
  if (instances.length > 0) {
    lines.push('**已创建实例:**');
    for (const inst of instances) {
      const chatCount = inst.chatIds.length > 0
        ? ` (${inst.chatIds.length} 个绑定)`
        : ' (无绑定)';
      lines.push(`  • \`${inst.name}\` ← \`${inst.templateName}\`${chatCount}`);
    }
  } else {
    lines.push('**已创建实例:** 无');
  }

  return { success: true, message: lines.join('\n') };
}

/**
 * /project create <template> <name> — 从模板创建新实例
 */
function handleCreate(
  command: ControlCommand,
  context: ControlHandlerContext,
  args: string[],
): ControlResponse {
  const pm = context.projectManager;
  if (!pm) {
    return {
      success: false,
      message: '⚠️ Project 功能未启用。请在配置中设置 `projectTemplates`。',
    };
  }

  if (args.length < 2) {
    return {
      success: false,
      message: '⚠️ 用法: `/project create <template> <name>`\n\n示例: `/project create research my-project`',
    };
  }

  const [templateName, name] = args;
  const result = pm.create(command.chatId, templateName, name);

  if (!result.ok) {
    return { success: false, message: `❌ 创建失败: ${result.error}` };
  }

  // Reset agent session to pick up new cwd
  context.agentPool.reset(command.chatId);

  return {
    success: true,
    message: [
      '✅ **Project 实例已创建**',
      '',
      `  • 名称: \`${result.data.name}\``,
      `  • 模板: \`${result.data.templateName ?? 'default'}\``,
      `  • 工作目录: \`${result.data.workingDir}\``,
      '',
      '💡 Agent 会话已重置，新消息将使用新的工作目录。',
    ].join('\n'),
  };
}

/**
 * /project use <name> — 绑定到已有实例
 */
function handleUse(
  command: ControlCommand,
  context: ControlHandlerContext,
  args: string[],
): ControlResponse {
  const pm = context.projectManager;
  if (!pm) {
    return {
      success: false,
      message: '⚠️ Project 功能未启用。请在配置中设置 `projectTemplates`。',
    };
  }

  if (args.length < 1) {
    return {
      success: false,
      message: '⚠️ 用法: `/project use <name>`\n\n示例: `/project use my-project`',
    };
  }

  const [name] = args;
  const result = pm.use(command.chatId, name);

  if (!result.ok) {
    return { success: false, message: `❌ 切换失败: ${result.error}` };
  }

  // Reset agent session to pick up new cwd
  context.agentPool.reset(command.chatId);

  return {
    success: true,
    message: [
      '✅ **已切换到 Project 实例**',
      '',
      `  • 名称: \`${result.data.name}\``,
      `  • 模板: \`${result.data.templateName ?? 'default'}\``,
      `  • 工作目录: \`${result.data.workingDir}\``,
      '',
      '💡 Agent 会话已重置，新消息将使用新的工作目录。',
    ].join('\n'),
  };
}

/**
 * /project info — 查看当前 project 详情
 */
function handleInfo(
  command: ControlCommand,
  context: ControlHandlerContext,
): ControlResponse {
  const pm = context.projectManager;
  if (!pm) {
    return {
      success: false,
      message: '⚠️ Project 功能未启用。请在配置中设置 `projectTemplates`。',
    };
  }

  const active = pm.getActive(command.chatId);

  if (active.name === 'default') {
    return {
      success: true,
      message: [
        '📋 **当前 Project**',
        '',
        '  • 名称: `default`（默认）',
        `  • 工作目录: \`${active.workingDir}\``,
        '',
        '💡 使用 `/project list` 查看可用模板和实例。',
      ].join('\n'),
    };
  }

  return {
    success: true,
    message: [
      '📋 **当前 Project**',
      '',
      `  • 名称: \`${active.name}\``,
      `  • 模板: \`${active.templateName ?? 'unknown'}\``,
      `  • 工作目录: \`${active.workingDir}\``,
    ].join('\n'),
  };
}

/**
 * /project reset — 重置为 default
 */
function handleReset(
  command: ControlCommand,
  context: ControlHandlerContext,
): ControlResponse {
  const pm = context.projectManager;
  if (!pm) {
    return {
      success: false,
      message: '⚠️ Project 功能未启用。请在配置中设置 `projectTemplates`。',
    };
  }

  const result = pm.reset(command.chatId);

  if (!result.ok) {
    return { success: false, message: `❌ 重置失败: ${result.error}` };
  }

  // Reset agent session to pick up default cwd
  context.agentPool.reset(command.chatId);

  return {
    success: true,
    message: [
      '✅ **已重置为默认 Project**',
      '',
      `  • 工作目录: \`${result.data.workingDir}\``,
      '',
      '💡 Agent 会话已重置，新消息将使用默认工作目录。',
    ].join('\n'),
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Main handler
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * /project 命令处理
 *
 * Dispatches to sub-command handlers based on parsed arguments.
 * Falls back to usage help if no valid sub-command is provided.
 */
export const handleProject: CommandHandler = (
  command: ControlCommand,
  context: ControlHandlerContext,
): ControlResponse => {
  const { subCommand, args } = parseArgs(command);

  switch (subCommand) {
    case 'list':
      return handleList(context);
    case 'create':
      return handleCreate(command, context, args);
    case 'use':
      return handleUse(command, context, args);
    case 'info':
      return handleInfo(command, context);
    case 'reset':
      return handleReset(command, context);
    default:
      return {
        success: false,
        message: [
          '⚠️ 无效的 /project 子命令',
          '',
          '**用法:**',
          '| 命令 | 说明 |',
          '|------|------|',
          '| `/project list` | 列出所有可用模板 + 已创建实例 |',
          '| `/project create <template> <name>` | 从模板创建新实例 |',
          '| `/project use <name>` | 绑定到已有实例 |',
          '| `/project info` | 查看当前 project 详情 |',
          '| `/project reset` | 重置为 default |',
        ].join('\n'),
      };
  }
};
