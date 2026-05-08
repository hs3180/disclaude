/**
 * /project command handler — admin commands for managing project-bound agents.
 *
 * Subcommands:
 * - `/project list` — List all project instances
 * - `/project status [projectKey]` — Show project agent status and state summary
 * - `/project stop <projectKey>` — Stop project agent (dispose from pool)
 * - `/project trigger <projectKey>` — Trigger task for project agent (requires NonUserMessage, future)
 *
 * @see Issue #3335 (Project state persistence and admin commands)
 */

import type { ControlCommand, ControlResponse } from '../../types/channel.js';
import type { ControlHandlerContext, CommandHandler } from '../types.js';

/**
 * Parse subcommand and arguments from command data.
 */
function parseProjectSubcommand(command: ControlCommand): {
  subcommand: string;
  args: string[];
} {
  const args = (command.data?.args as string[]) ?? [];
  const subcommand = (args[0] ?? '').toLowerCase();
  const subArgs = args.slice(1);
  return { subcommand, args: subArgs };
}

/**
 * Handle `/project list` — list all project instances.
 */
function handleProjectList(
  context: ControlHandlerContext,
): ControlResponse {
  const pm = context.projectManager;
  if (!pm) {
    return {
      success: false,
      error: 'ProjectManager 未初始化，/project 命令不可用',
    };
  }

  const templates = pm.listTemplates();
  const instances = pm.listInstances();

  if (templates.length === 0 && instances.length === 0) {
    return {
      success: true,
      message: '📋 **项目管理**\n\n暂无项目模板或实例。',
    };
  }

  const lines: string[] = ['📋 **项目管理**', ''];

  // Templates section
  if (templates.length > 0) {
    lines.push('**可用模板**:');
    for (const t of templates) {
      const display = t.displayName ?? t.name;
      const desc = t.description ? ` — ${t.description}` : '';
      lines.push(`  • \`${t.name}\`: ${display}${desc}`);
    }
    lines.push('');
  }

  // Instances section
  if (instances.length > 0) {
    lines.push('**活跃实例**:');
    for (const inst of instances) {
      const chatCount = inst.chatIds.length;
      lines.push(`  • \`${inst.name}\` (模板: ${inst.templateName}, 绑定 ${chatCount} 个会话)`);
      lines.push(`    工作目录: \`${inst.workingDir}\``);
      lines.push(`    创建时间: ${inst.createdAt}`);
    }
  }

  return {
    success: true,
    message: lines.join('\n'),
  };
}

/**
 * Handle `/project status [projectKey]` — show project agent status and state summary.
 */
function handleProjectStatus(
  context: ControlHandlerContext,
  _args: string[],
  chatId: string,
): ControlResponse {
  const pm = context.projectManager;
  if (!pm) {
    return {
      success: false,
      error: 'ProjectManager 未初始化，/project 命令不可用',
    };
  }

  // Show current chat's project context
  const active = pm.getActive(chatId);

  const lines: string[] = ['📊 **项目状态**', ''];
  lines.push(`**当前项目**: \`${active.name}\``);

  if (active.templateName) {
    lines.push(`**模板**: ${active.templateName}`);
  }

  lines.push(`**工作目录**: \`${active.workingDir}\``);

  // Show instances for context
  const instances = pm.listInstances();
  if (instances.length > 0) {
    lines.push('');
    lines.push('**所有实例**:');
    for (const inst of instances) {
      const isActive = inst.name === active.name;
      const marker = isActive ? ' ← 当前' : '';
      lines.push(`  • \`${inst.name}\` (${inst.templateName}, ${inst.chatIds.length} 会话)${marker}`);
    }
  }

  return {
    success: true,
    message: lines.join('\n'),
  };
}

/**
 * Handle `/project stop <projectKey>` — stop project agent by resetting its bound chat.
 */
function handleProjectStop(
  context: ControlHandlerContext,
  args: string[],
): ControlResponse {
  const pm = context.projectManager;
  if (!pm) {
    return {
      success: false,
      error: 'ProjectManager 未初始化，/project 命令不可用',
    };
  }

  const [instanceName] = args;
  if (!instanceName) {
    return {
      success: false,
      error: '用法: `/project stop <实例名>`\n\n使用 `/project list` 查看所有实例。',
    };
  }

  // Find the instance
  const instances = pm.listInstances();
  const target = instances.find((i) => i.name === instanceName);
  if (!target) {
    return {
      success: false,
      error: `实例 "${instanceName}" 不存在。\n\n使用 \`/project list\` 查看所有实例。`,
    };
  }

  // Reset agent for all bound chatIds
  let resetCount = 0;
  for (const chatId of target.chatIds) {
    context.agentPool.reset(chatId);
    resetCount++;
  }

  return {
    success: true,
    message: '⏹️ **已停止项目实例**\n\n' +
      `实例 \`${instanceName}\` 的 ${resetCount} 个会话已重置。`,
  };
}

/**
 * Handle `/project trigger <projectKey>` — trigger task for project agent.
 *
 * Note: Full implementation requires NonUserMessage routing (Issue #3331).
 * Currently provides a placeholder response.
 */
function handleProjectTrigger(
  _context: ControlHandlerContext,
  args: string[],
): ControlResponse {
  const [instanceName] = args;
  if (!instanceName) {
    return {
      success: false,
      error: '用法: `/project trigger <实例名>`\n\n使用 `/project list` 查看所有实例。',
    };
  }

  // NonUserMessage routing is not yet available (depends on Issue #3331)
  return {
    success: false,
    error: '⚠️ `/project trigger` 需要 NonUserMessage 路由能力 (Issue #3331)，' +
      '尚未实现。\n\n' +
      `实例 \`${instanceName}\` 的触发功能将在 NonUserMessage 路由就绪后可用。`,
  };
}

/**
 * /project command handler.
 *
 * Routes subcommands to appropriate handlers.
 */
export const handleProject: CommandHandler = (
  command: ControlCommand,
  context: ControlHandlerContext,
): ControlResponse => {
  const { subcommand, args } = parseProjectSubcommand(command);

  switch (subcommand) {
    case 'list':
    case 'ls':
      return handleProjectList(context);

    case 'status':
    case 'info':
      return handleProjectStatus(context, args, command.chatId);

    case 'stop':
    case 'dispose':
      return handleProjectStop(context, args);

    case 'trigger':
    case 'run':
      return handleProjectTrigger(context, args);

    default:
      return {
        success: false,
        error: [
          `未知子命令: "${subcommand}"`,
          '',
          '**可用命令**:',
          '  `/project list` — 列出所有项目实例',
          '  `/project status` — 查看当前项目状态',
          '  `/project stop <实例名>` — 停止项目实例',
          '  `/project trigger <实例名>` — 触发项目任务 (开发中)',
        ].join('\n'),
      };
  }
};
