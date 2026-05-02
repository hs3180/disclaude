/**
 * /project command handler — per-chatId Agent context switching.
 *
 * Subcommands:
 * - list      — Show available templates and existing instances
 * - create    — Create a new project instance from a template
 * - use       — Bind current chat to an existing instance
 * - reset     — Reset to default workspace
 * - info      — Show current project context
 *
 * @see Issue #1916 — unified ProjectContext system
 */

import type { ControlCommand, ControlResponse } from '../../types/channel.js';
import type { ControlHandlerContext, CommandHandler } from '../types.js';

/**
 * Parse the subcommand and arguments from command data.
 *
 * Expected `data` shape:
 * ```ts
 * { subcommand: 'list' | 'create' | 'use' | 'reset' | 'info', name?: string, template?: string }
 * ```
 */
function parseArgs(command: ControlCommand): {
  subcommand: string;
  name?: string;
  template?: string;
} {
  const data = command.data || {};
  return {
    subcommand: (data.subcommand as string) || '',
    name: data.name as string | undefined,
    template: data.template as string | undefined,
  };
}

/**
 * /project command handler.
 *
 * Dispatches to sub-handlers based on `data.subcommand`.
 * Returns an error if ProjectManager is not configured.
 */
export const handleProject: CommandHandler = (
  command: ControlCommand,
  context: ControlHandlerContext,
): ControlResponse => {
  const pm = context.projectManager;
  if (!pm) {
    return {
      success: false,
      message: '⚠️ ProjectManager 未配置。请在 disclaude.config.yaml 中添加 projectTemplates。',
    };
  }

  const { subcommand, name, template } = parseArgs(command);

  switch (subcommand) {
    case 'list':
      return handleList(pm);
    case 'create':
      return handleCreate(pm, command.chatId, template, name);
    case 'use':
      return handleUse(pm, command.chatId, name);
    case 'reset':
      return handleReset(pm, command.chatId, context);
    case 'info':
      return handleInfo(pm, command.chatId);
    default:
      return {
        success: false,
        message: '❓ 未知子命令。可用: list, create, use, reset, info',
      };
  }
};

/**
 * List available templates and existing instances.
 */
function handleList(pm: import('../../project/project-manager.js').ProjectManager): ControlResponse {
  const templates = pm.listTemplates();
  const instances = pm.listInstances();

  const lines: string[] = ['📋 **项目列表**\n'];

  if (templates.length > 0) {
    lines.push('**可用模板:**');
    for (const t of templates) {
      lines.push(`- \`${t.name}\` — ${t.displayName || t.name}${t.description ? `: ${t.description}` : ''}`);
    }
  } else {
    lines.push('_未配置任何模板_');
  }

  if (instances.length > 0) {
    lines.push('\n**已有实例:**');
    for (const inst of instances) {
      lines.push(`- \`${inst.name}\` (${inst.templateName}) — 绑定 ${inst.chatIds.length} 个会话`);
    }
  }

  return {
    success: true,
    message: lines.join('\n'),
  };
}

/**
 * Create a new project instance from a template.
 */
function handleCreate(
  pm: import('../../project/project-manager.js').ProjectManager,
  chatId: string,
  template?: string,
  name?: string,
): ControlResponse {
  if (!template) {
    return { success: false, message: '❌ 缺少模板名称。用法: /project create --template <模板名> --name <实例名>' };
  }
  if (!name) {
    return { success: false, message: '❌ 缺少实例名称。用法: /project create --template <模板名> --name <实例名>' };
  }

  const result = pm.create(chatId, template, name);
  if (!result.ok) {
    return { success: false, message: `❌ 创建失败: ${result.error}` };
  }

  return {
    success: true,
    message: `✅ 项目 \`${name}\` 已创建（模板: ${template}）\n工作目录: \`${result.data.workingDir}\`\n\n当前会话已绑定到该项目。`,
  };
}

/**
 * Bind current chat to an existing project instance.
 */
function handleUse(
  pm: import('../../project/project-manager.js').ProjectManager,
  chatId: string,
  name?: string,
): ControlResponse {
  if (!name) {
    return { success: false, message: '❌ 缺少实例名称。用法: /project use <实例名>' };
  }

  const result = pm.use(chatId, name);
  if (!result.ok) {
    return { success: false, message: `❌ 切换失败: ${result.error}` };
  }

  return {
    success: true,
    message: `✅ 已切换到项目 \`${name}\`\n工作目录: \`${result.data.workingDir}\``,
  };
}

/**
 * Reset to default workspace.
 */
function handleReset(
  pm: import('../../project/project-manager.js').ProjectManager,
  chatId: string,
  context: ControlHandlerContext,
): ControlResponse {
  const result = pm.reset(chatId);
  if (!result.ok) {
    return { success: false, message: `❌ 重置失败: ${result.error}` };
  }

  // Reset agent session so it picks up the new cwd
  context.agentPool.reset(chatId);

  return {
    success: true,
    message: '✅ 已重置为默认工作空间。Agent 会话已刷新。',
  };
}

/**
 * Show current project context info.
 */
function handleInfo(
  pm: import('../../project/project-manager.js').ProjectManager,
  chatId: string,
): ControlResponse {
  const active = pm.getActive(chatId);

  if (active.name === 'default') {
    return {
      success: true,
      message: `📍 **当前项目**: default\n**工作目录**: \`${active.workingDir}\``,
    };
  }

  return {
    success: true,
    message: `📍 **当前项目**: ${active.name}\n**模板**: ${active.templateName}\n**工作目录**: \`${active.workingDir}\``,
  };
}
