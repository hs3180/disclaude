/**
 * /project command handler for project management.
 *
 * Issue #1916: Provides commands for listing, switching, and
 * managing project knowledge bases.
 *
 * Usage:
 *   /project list           — List all configured projects
 *   /project switch <name>  — Switch to a project for this chat
 *   /project status         — Show current project info
 *   /project reload         — Reload knowledge cache
 *
 * @module control/commands/project
 */

import type { ControlCommand, ControlResponse } from '../../types/channel.js';
import type { ControlHandlerContext, CommandHandler } from '../types.js';

/**
 * Handle /project command.
 *
 * Sub-commands:
 * - `list`: Show all configured projects
 * - `switch <name>`: Switch current project
 * - `status`: Show current project status
 * - `reload`: Clear knowledge cache
 */
export const handleProject: CommandHandler = (
  command: ControlCommand,
  context: ControlHandlerContext
): ControlResponse => {
  const args = (command.data?.args as string[]) || [];

  if (args.length === 0) {
    return {
      success: false,
      message: '用法: `/project list|switch|status|reload`\n\n' +
        '| 命令 | 说明 |\n' +
        '|------|------|\n' +
        '| `/project list` | 列出所有项目 |\n' +
        '| `/project switch <name>` | 切换当前项目 |\n' +
        '| `/project status` | 查看当前项目 |\n' +
        '| `/project reload` | 重新加载知识库 |',
    };
  }

  const subCommand = args[0].toLowerCase();

  switch (subCommand) {
    case 'list':
      return handleProjectList(context);
    case 'switch':
      return handleProjectSwitch(command, args, context);
    case 'status':
      return handleProjectStatus(command, context);
    case 'reload':
      return handleProjectReload(command, context);
    default:
      return {
        success: false,
        message: `未知子命令: ${subCommand}\n可用命令: list, switch, status, reload`,
      };
  }
};

/**
 * List all configured projects.
 */
function handleProjectList(context: ControlHandlerContext): ControlResponse {
  const projectManager = (context as Record<string, unknown>).projectManager as {
    listProjects: () => Array<{
      name: string;
      isDefault: boolean;
      knowledgeDirCount: number;
      hasInstructions: boolean;
    }>;
  } | undefined;

  if (!projectManager) {
    return {
      success: false,
      message: '❌ 项目管理功能未启用。请在 disclaude.config.yaml 中配置 `projects` 段。',
    };
  }

  const projects = projectManager.listProjects();

  if (projects.length === 0) {
    return {
      success: true,
      message: '📭 没有配置任何项目。\n\n在 disclaude.config.yaml 中添加 `projects` 配置：\n```yaml\nprojects:\n  default:\n    knowledge:\n      - ./docs/\n```',
    };
  }

  const header = '📂 **已配置的项目**\n';
  const table = '| 项目 | 默认 | 知识库目录 | 指令文件 |\n' +
    '|------|------|-----------|----------|\n' +
    projects.map(p => {
      const defaultTag = p.isDefault ? '⭐' : '';
      const knowledge = p.knowledgeDirCount > 0 ? `${p.knowledgeDirCount} 个` : '无';
      const instructions = p.hasInstructions ? '✅' : '—';
      return `| ${defaultTag} \`${p.name}\` | ${defaultTag || '—'} | ${knowledge} | ${instructions} |`;
    }).join('\n');

  return {
    success: true,
    message: header + '\n' + table,
  };
}

/**
 * Switch to a different project.
 */
function handleProjectSwitch(
  command: ControlCommand,
  args: string[],
  context: ControlHandlerContext
): ControlResponse {
  const projectName = args[1];

  if (!projectName) {
    return {
      success: false,
      message: '❌ 请指定项目名称。用法: `/project switch <name>`',
    };
  }

  const projectManager = (context as Record<string, unknown>).projectManager as {
    switchProject: (chatId: string, name: string) => boolean;
    getCurrentProject: (chatId: string) => string | undefined;
  } | undefined;

  if (!projectManager) {
    return {
      success: false,
      message: '❌ 项目管理功能未启用。',
    };
  }

  const success = projectManager.switchProject(command.chatId, projectName);

  if (!success) {
    const current = projectManager.getCurrentProject(command.chatId);
    return {
      success: false,
      message: `❌ 项目 "${projectName}" 不存在。当前项目: ${current ?? '无'}`,
    };
  }

  return {
    success: true,
    message: `✅ 已切换到项目 \`${projectName}\``,
  };
}

/**
 * Show current project status.
 */
function handleProjectStatus(
  command: ControlCommand,
  context: ControlHandlerContext
): ControlResponse {
  const projectManager = (context as Record<string, unknown>).projectManager as {
    getCurrentProject: (chatId: string) => string | undefined;
    getProjectConfig: (name: string) => {
      instructionsPath?: string;
      knowledge?: string[];
    } | undefined;
    hasProjects: () => boolean;
  } | undefined;

  if (!projectManager) {
    return {
      success: false,
      message: '❌ 项目管理功能未启用。',
    };
  }

  if (!projectManager.hasProjects()) {
    return {
      success: true,
      message: '📭 没有配置任何项目。',
    };
  }

  const current = projectManager.getCurrentProject(command.chatId);
  const config = current ? projectManager.getProjectConfig(current) : undefined;

  const statusLines = [
    '📊 **当前项目状态**',
    '',
    `**当前项目**: ${current ? `\`${current}\`` : '无（使用默认）'}`,
    `**指令文件**: ${config?.instructionsPath ? `\`${config.instructionsPath}\`` : '未配置'}`,
    `**知识库目录**: ${config?.knowledge?.length ? config.knowledge.map(d => `\`${d}\``).join(', ') : '未配置'}`,
  ];

  return {
    success: true,
    message: statusLines.join('\n'),
  };
}

/**
 * Reload knowledge cache.
 */
function handleProjectReload(
  command: ControlCommand,
  context: ControlHandlerContext
): ControlResponse {
  const projectManager = (context as Record<string, unknown>).projectManager as {
    clearCache: (name?: string) => boolean;
    getCurrentProject: (chatId: string) => string | undefined;
  } | undefined;

  if (!projectManager) {
    return {
      success: false,
      message: '❌ 项目管理功能未启用。',
    };
  }

  const projectName = command.data?.args?.[1] as string | undefined;
  const currentProject = projectManager.getCurrentProject(command.chatId);

  if (projectName) {
    projectManager.clearCache(projectName);
    return {
      success: true,
      message: `✅ 已清除项目 \`${projectName}\` 的知识库缓存。下次消息将重新加载。`,
    };
  }

  projectManager.clearCache();
  return {
    success: true,
    message: `✅ 已清除所有知识库缓存。${currentProject ? `当前项目: \`${currentProject}\`` : ''}`,
  };
}
