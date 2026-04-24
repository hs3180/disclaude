/**
 * /project command handler — per-chatId Agent context switching.
 *
 * Issue #1916 Phase 2: Connects user commands to ProjectManager API.
 *
 * Sub-commands:
 *   /project list              — List available templates and instances
 *   /project create <t> <n>    — Create instance from template
 *   /project use <n>           — Switch to an existing instance
 *   /project info              — Show current project details
 *   /project reset             — Reset to default project
 *
 * @module control/commands/project
 */

import type { ControlCommand, ControlResponse } from '../../types/channel.js';
import type { ControlHandlerContext, CommandHandler } from '../types.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Sub-command parsing
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

type SubCommand = 'list' | 'create' | 'use' | 'info' | 'reset';

/** Type for the projectManager field (narrowed from ControlHandlerContext) */
type ProjectManagerLike = NonNullable<ControlHandlerContext['projectManager']>;

/**
 * Parse sub-command and arguments from command.data.
 *
 * Args may be passed as:
 * - string[] from Feishu message handler: { data: { args: ['create', 'research', 'my-proj'] } }
 * - string from REST API: { data: { args: 'create research my-proj' } }
 */
function parseSubCommand(command: ControlCommand): { sub: SubCommand; args: string[] } | { error: string } {
  const raw = command.data?.args;
  let parts: string[];

  if (Array.isArray(raw)) {
    parts = raw as string[];
  } else if (typeof raw === 'string' && raw.length > 0) {
    parts = raw.trim().split(/\s+/);
  } else {
    // No args → default to "info"
    return { sub: 'info', args: [] };
  }

  const sub = parts[0]?.toLowerCase();
  const validSubs: SubCommand[] = ['list', 'create', 'use', 'info', 'reset'];

  if (!sub || !validSubs.includes(sub as SubCommand)) {
    return { error: `未知子命令 "${sub ?? ''}"。可用: ${validSubs.join(', ')}` };
  }

  return { sub: sub as SubCommand, args: parts.slice(1) };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Sub-command handlers
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function handleList(pm: ProjectManagerLike): ControlResponse {
  const templates = pm.listTemplates();
  const instances = pm.listInstances();

  const lines: string[] = ['📋 **项目列表**', ''];

  if (templates.length > 0) {
    lines.push('**可用模板**:');
    for (const t of templates) {
      const desc = t.description ? ` — ${t.description}` : '';
      const name = t.displayName ? `${t.displayName} (${t.name})` : t.name;
      lines.push(`  - ${name}${desc}`);
    }
  } else {
    lines.push('**可用模板**: (无 — 未配置 projectTemplates)');
  }

  if (instances.length > 0) {
    lines.push('');
    lines.push('**已创建实例**:');
    for (const inst of instances) {
      const binding = inst.chatIds.length > 0
        ? ` [${inst.chatIds.length} 个绑定]`
        : '';
      lines.push(`  - ${inst.name} (模板: ${inst.templateName})${binding}`);
    }
  }

  return { success: true, message: lines.join('\n') };
}

function handleCreate(chatId: string, args: string[], pm: ProjectManagerLike, context: ControlHandlerContext): ControlResponse {
  if (args.length < 2) {
    return {
      success: false,
      message: '⚠️ 用法: `/project create <模板名> <实例名>`\n使用 `/project list` 查看可用模板。',
    };
  }

  const [templateName, instanceName] = args;
  const result = pm.create(chatId, templateName, instanceName);

  if (!result.ok) {
    return { success: false, message: `❌ 创建失败: ${result.error}` };
  }

  // Reset session so Agent picks up the new cwd on next message
  context.agentPool.reset(chatId);

  return {
    success: true,
    message: [
      `✅ **项目 "${result.data.name}" 已创建**`,
      '',
      `模板: ${result.data.templateName}`,
      `工作目录: ${result.data.workingDir}`,
      '',
      '会话已重置，下一条消息将在新项目上下文中处理。',
    ].join('\n'),
  };
}

function handleUse(chatId: string, args: string[], pm: ProjectManagerLike, context: ControlHandlerContext): ControlResponse {
  if (args.length < 1) {
    return {
      success: false,
      message: '⚠️ 用法: `/project use <实例名>`\n使用 `/project list` 查看已创建实例。',
    };
  }

  const [instanceName] = args;
  const result = pm.use(chatId, instanceName);

  if (!result.ok) {
    return { success: false, message: `❌ 切换失败: ${result.error}` };
  }

  // Reset session so Agent picks up the new cwd on next message
  context.agentPool.reset(chatId);

  return {
    success: true,
    message: [
      `✅ **已切换到项目 "${result.data.name}"**`,
      '',
      `工作目录: ${result.data.workingDir}`,
      '',
      '会话已重置，下一条消息将在新项目上下文中处理。',
    ].join('\n'),
  };
}

function handleInfo(chatId: string, pm: ProjectManagerLike): ControlResponse {
  const active = pm.getActive(chatId);

  if (active.name === 'default') {
    return {
      success: true,
      message: [
        '📍 **当前项目**: default (默认)',
        '',
        `工作目录: ${active.workingDir}`,
      ].join('\n'),
    };
  }

  return {
    success: true,
    message: [
      `📍 **当前项目**: ${active.name}`,
      '',
      `模板: ${active.templateName ?? 'N/A'}`,
      `工作目录: ${active.workingDir}`,
    ].join('\n'),
  };
}

function handleReset(chatId: string, pm: ProjectManagerLike, context: ControlHandlerContext): ControlResponse {
  const result = pm.reset(chatId);

  if (!result.ok) {
    return { success: false, message: `❌ 重置失败: ${result.error}` };
  }

  // Reset session so Agent picks up the default cwd on next message
  context.agentPool.reset(chatId);

  return {
    success: true,
    message: [
      '✅ **已重置为默认项目**',
      '',
      `工作目录: ${result.data.workingDir}`,
      '',
      '会话已重置，下一条消息将在默认上下文中处理。',
    ].join('\n'),
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Main handler
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * /project command handler (Issue #1916 Phase 2).
 *
 * Routes to sub-commands based on command.data.args.
 * Returns unavailable message if projectManager is not configured.
 */
export const handleProject: CommandHandler = (
  command: ControlCommand,
  context: ControlHandlerContext,
): ControlResponse => {
  // Check if projectManager is available
  const pm = context.projectManager;
  if (!pm) {
    context.logger?.warn(
      { chatId: command.chatId },
      '/project command received but projectManager is not configured',
    );
    return {
      success: false,
      message: '⚠️ 项目管理功能当前不可用。请在配置文件中设置 projectTemplates。',
    };
  }

  const parsed = parseSubCommand(command);
  if ('error' in parsed) {
    return {
      success: false,
      message: `⚠️ ${parsed.error}\n\n用法:\n- \`/project list\` — 列出模板和实例\n- \`/project create <模板> <名称>\` — 创建实例\n- \`/project use <名称>\` — 切换实例\n- \`/project info\` — 查看当前项目\n- \`/project reset\` — 重置为默认`,
    };
  }

  const { sub, args } = parsed;
  const { chatId } = command;

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
  }
};
