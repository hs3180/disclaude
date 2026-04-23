/**
 * /taste command handler — manage user preference rules.
 *
 * Issue #2335: Provides a slash command interface for users to view,
 * add, and reset their auto-learned taste preferences.
 *
 * Subcommands:
 * - `/taste` or `/taste list` — List all preferences
 * - `/taste add <category> <rule>` — Add a preference manually
 * - `/taste remove <ruleId>` — Remove a preference
 * - `/taste reset` — Clear all preferences
 *
 * @module control/commands/taste
 */

import type { ControlCommand, ControlResponse } from '../../types/channel.js';
import type { ControlHandlerContext, CommandHandler } from '../types.js';
import type { TasteManager, TasteCategory } from '../../taste/index.js';

/**
 * Valid taste categories with their display labels.
 */
const CATEGORY_LABELS: Record<string, string> = {
  code_style: '代码风格',
  interaction: '交互偏好',
  tech_preference: '技术选择',
  project_norm: '项目规范',
  other: '其他',
};

/**
 * Parse the /taste command into subcommand and arguments.
 */
function parseTasteCommand(data?: Record<string, unknown>): {
  subcommand: string;
  args: string[];
} {
  const text = (data?.['text'] as string) ?? '';
  const parts = text.trim().split(/\s+/);

  if (parts.length === 0 || parts[0] === '') {
    return { subcommand: 'list', args: [] };
  }

  const subcommand = parts[0].toLowerCase();
  const args = parts.slice(1);
  return { subcommand, args };
}

/**
 * Create the /taste command handler with TasteManager dependency.
 *
 * The TasteManager is injected via the context so that the command
 * handler doesn't need to know about workspace paths.
 */
export function createTasteHandler(tasteManager: TasteManager): CommandHandler {
  const handler: CommandHandler = (
    command: ControlCommand,
    _context: ControlHandlerContext,
  ): ControlResponse => {
    const { chatId, data } = command;
    const { subcommand, args } = parseTasteCommand(data);

    switch (subcommand) {
      case 'list':
        return handleList(tasteManager, chatId);
      case 'add':
        return handleAdd(tasteManager, chatId, args);
      case 'remove':
        return handleRemove(tasteManager, chatId, args);
      case 'reset':
        return handleReset(tasteManager, chatId);
      default:
        return {
          success: false,
          error: `未知子命令: ${subcommand}。支持: list, add, remove, reset`,
        };
    }
  };
  return handler;
}

/**
 * Handle `/taste list` — list all taste rules.
 */
function handleList(tasteManager: TasteManager, chatId: string): ControlResponse {
  const result = tasteManager.listRules(chatId);

  if (!result.ok) {
    return { success: false, error: result.error };
  }

  if (result.data.length === 0) {
    return {
      success: true,
      message: '📋 当前没有已记录的偏好规则。\n\n使用 `/taste add <分类> <规则>` 手动添加偏好。\n分类: code_style, interaction, tech_preference, project_norm, other',
    };
  }

  const lines: string[] = ['📋 **已记录的用户偏好**\n'];

  for (const rule of result.data) {
    const categoryLabel = CATEGORY_LABELS[rule.category] ?? rule.category;
    const sourceLabel = rule.source === 'auto' ? '🤖 自动' : rule.source === 'claude_md' ? '📄 配置' : '✏️ 手动';
    const countInfo = rule.correctionCount > 0 ? ` (${rule.correctionCount} 次纠正)` : '';
    lines.push(`- **[${rule.id}]** ${rule.rule}`);
    lines.push(`  ${categoryLabel} · ${sourceLabel}${countInfo}`);
  }

  lines.push('');
  lines.push('---');
  lines.push('管理命令: `/taste remove <ID>` | `/taste reset`');

  return { success: true, message: lines.join('\n') };
}

/**
 * Handle `/taste add <category> <rule>` — add a taste rule.
 */
function handleAdd(tasteManager: TasteManager, chatId: string, args: string[]): ControlResponse {
  if (args.length < 2) {
    return {
      success: false,
      error: '用法: `/taste add <分类> <规则内容>`\n分类: code_style, interaction, tech_preference, project_norm, other',
    };
  }

  const category = args[0].toLowerCase();
  if (!CATEGORY_LABELS[category]) {
    return {
      success: false,
      error: `未知分类: ${category}。\n支持: ${Object.keys(CATEGORY_LABELS).join(', ')}`,
    };
  }

  const rule = args.slice(1).join(' ');
  const result = tasteManager.addRule(chatId, category as TasteCategory, rule, 'manual');

  if (!result.ok) {
    return { success: false, error: result.error };
  }

  const categoryLabel = CATEGORY_LABELS[category];
  return {
    success: true,
    message: `✅ 已添加偏好规则 [${result.data.id}]\n分类: ${categoryLabel}\n规则: ${result.data.rule}`,
  };
}

/**
 * Handle `/taste remove <ruleId>` — remove a taste rule.
 */
function handleRemove(tasteManager: TasteManager, chatId: string, args: string[]): ControlResponse {
  if (args.length < 1) {
    return {
      success: false,
      error: '用法: `/taste remove <规则ID>` (如: `/taste remove r-1`)',
    };
  }

  const [ruleId] = args;
  const result = tasteManager.removeRule(chatId, ruleId);

  if (!result.ok) {
    return { success: false, error: result.error };
  }

  return { success: true, message: `✅ 已删除偏好规则 ${ruleId}` };
}

/**
 * Handle `/taste reset` — clear all taste rules.
 */
function handleReset(tasteManager: TasteManager, chatId: string): ControlResponse {
  const result = tasteManager.resetTaste(chatId);

  if (!result.ok) {
    return { success: false, error: result.error };
  }

  return {
    success: true,
    message: `✅ 已清空所有偏好规则 (共删除 ${result.data} 条)`,
  };
}
