/**
 * /project command handler.
 *
 * Provides commands for managing chatId → working directory bindings.
 *
 * Subcommands:
 * - `use <nameOrPath>` — Bind current chat to an instance or working directory
 * - `create <template> <name>` — Create a new project instance from a template
 * - `list` — List available templates and created instances
 * - `reset` — Reset current chat to default workspace
 * - `info` — Show current chat's active project info
 *
 * @see Issue #3519 (simplify /project command)
 * @see Issue #1916 (unified ProjectContext system — template/instance model)
 * @see Issue #3529 (typed command data)
 */

import type { ControlCommand, ControlResponse } from '../../types/channel.js';
import type { ControlHandlerContext, CommandHandler } from '../types.js';
import { readProjectState } from '../../project/project-state.js';
import { basename } from 'node:path';

/** Typed command for /project handlers */
type ProjectCommand = ControlCommand<'project'>;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Subcommand Handlers
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * `/project list` — List available templates and created instances.
 */
function handleList(command: ProjectCommand, context: ControlHandlerContext): ControlResponse {
  const pm = context.projectManager;
  if (!pm) {
    return {
      success: false,
      error: 'ProjectManager 未配置',
    };
  }

  const templates = pm.listTemplates();
  const instances = pm.listInstances();

  const lines: string[] = ['📋 **项目模板与实例**', ''];

  if (templates.length > 0) {
    lines.push('**可用模板**:');
    for (const t of templates) {
      const desc = t.description ? ` — ${t.description}` : '';
      const display = t.displayName ? ` (${t.displayName})` : '';
      lines.push(`  - \`${t.name}\`${display}${desc}`);
    }
    lines.push('');
  } else {
    lines.push('**可用模板**: (无 — 未配置 projectTemplates)');
    lines.push('');
  }

  if (instances.length > 0) {
    lines.push('**已创建实例**:');
    for (const inst of instances) {
      const chatCount = inst.chatIds.length > 0 ? ` [${inst.chatIds.length} 个绑定]` : '';
      lines.push(`  - \`${inst.name}\` (模板: ${inst.templateName})${chatCount}`);
    }
  } else {
    lines.push('**已创建实例**: (无)');
  }

  return {
    success: true,
    message: lines.join('\n'),
  };
}

/**
 * `/project create <template> <name>` — Create a new instance from a template.
 */
function handleCreate(command: ProjectCommand, context: ControlHandlerContext): ControlResponse {
  const pm = context.projectManager;
  if (!pm) {
    return {
      success: false,
      error: 'ProjectManager 未配置',
    };
  }

  const templateName = command.data?.templateName;
  const instanceName = command.data?.instanceName;

  if (!templateName || !instanceName) {
    return {
      success: false,
      error: '用法: /project create <template> <name>\n请指定模板名和实例名',
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
      `✅ **已创建实例**: \`${instanceName}\` (模板: ${templateName})`,
      `**工作目录**: \`${result.data.workingDir}\``,
      '',
      'Agent 会话已重置，下次对话将使用新工作目录。',
    ].join('\n'),
  };
}

/**
 * `/project info` — Show current chat's active project.
 */
function handleInfo(command: ProjectCommand, context: ControlHandlerContext): ControlResponse {
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
      message: `📂 **当前项目**: default（工作空间根目录）\n\`${active.workingDir}\``,
    };
  }

  // Try to read project state
  const state = readProjectState(active.workingDir);
  const issueCount = state ? Object.keys(state.issues).length : 0;
  const prCount = state ? Object.keys(state.prs).length : 0;
  const lastSync = state?.sync?.issues ?? '从不';

  const templateInfo = active.templateName ? `\n**模板**: ${active.templateName}` : '';

  return {
    success: true,
    message: [
      `📂 **当前项目**: ${basename(active.workingDir)}`,
      `**工作目录**: \`${active.workingDir}\`${templateInfo}`,
      '',
      '**状态摘要**:',
      `- Issues: ${issueCount} 个已追踪`,
      `- PRs: ${prCount} 个已追踪`,
      `- 上次同步: ${lastSync}`,
    ].join('\n'),
  };
}

/**
 * `/project use <nameOrPath>` — Bind current chat to an instance or working directory.
 */
function handleUse(command: ProjectCommand, context: ControlHandlerContext): ControlResponse {
  const pm = context.projectManager;
  if (!pm) {
    return {
      success: false,
      error: 'ProjectManager 未配置',
    };
  }

  const nameOrPath = command.data?.workingDir;

  if (!nameOrPath) {
    return {
      success: false,
      error: '用法: /project use <instanceName | workingDir>\n请指定实例名或工作目录路径',
    };
  }

  const result = pm.use(command.chatId, nameOrPath);
  if (!result.ok) {
    return {
      success: false,
      error: result.error,
    };
  }

  // Reset the agent session so the next message uses the new cwd
  context.agentPool.reset(command.chatId);

  const templateInfo = result.data.templateName ? ` (模板: ${result.data.templateName})` : '';

  return {
    success: true,
    message: [
      `✅ **已切换工作目录**: \`${result.data.workingDir}\`${templateInfo}`,
      '',
      'Agent 会话已重置，下次对话将使用新工作目录。',
    ].join('\n'),
  };
}

/**
 * `/project reset` — Reset current chat to default workspace.
 */
function handleReset(command: ProjectCommand, context: ControlHandlerContext): ControlResponse {
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

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Main Handler
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * `/project` command handler.
 *
 * Dispatches to subcommands based on `command.data.subcommand`.
 * Data is normalized by `normalizeCommandData()` before reaching this handler.
 */
export const handleProject: CommandHandler<'project'> = (
  command: ControlCommand<'project'>,
  context: ControlHandlerContext,
): ControlResponse => {
  const subcommand = command.data?.subcommand ?? 'info';

  switch (subcommand) {
    case 'list':
      return handleList(command, context);
    case 'create':
      return handleCreate(command, context);
    case 'use':
      return handleUse(command, context);
    case 'reset':
      return handleReset(command, context);
    case 'info':
      return handleInfo(command, context);
    default:
      return {
        success: false,
        error: `未知子命令: ${subcommand}。可用: list, create, use, reset, info`,
      };
  }
};
