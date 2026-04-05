/**
 * /research command handler.
 *
 * Provides system-level commands for managing Research mode:
 * - `/research enter <project>` — Enter research mode for a specific project
 * - `/research exit` — Exit research mode, return to normal workspace
 * - `/research list` — List all existing research projects
 * - `/research` — Show current research mode status
 *
 * @see Issue #1709
 */

import type { ControlCommand, ControlResponse } from '../../types/channel.js';
import type { ControlHandlerContext, CommandHandler } from '../types.js';

/**
 * Handle /research command.
 *
 * Parses the subcommand (enter/exit/list) and delegates to the
 * researchMode manager in the handler context.
 */
export const handleResearch: CommandHandler = (
  command: ControlCommand,
  context: ControlHandlerContext
): ControlResponse => {
  const { researchMode } = context;

  if (!researchMode) {
    context.logger?.warn(
      { chatId: command.chatId },
      '/research command received but researchMode is not configured'
    );
    return {
      success: false,
      message: '⚠️ Research 模式功能当前不可用。请确认 research 配置已启用。',
    };
  }

  const { chatId } = command;
  // Args may be passed as string[] (from Feishu message handler) or string (from REST API)
  // For array format, join all elements to preserve multi-word project names
  const rawArgs = command.data?.args;
  const args: string | undefined = Array.isArray(rawArgs) ? rawArgs.join(' ') : rawArgs as string | undefined;

  // No args — show current status
  if (args === undefined || args === '') {
    if (researchMode.isActive()) {
      const project = researchMode.getCurrentProject();
      return {
        success: true,
        message: `🔍 Research 模式已激活\n项目: ${project}\n工作目录: ${researchMode.getEffectiveCwd()}`,
      };
    }
    return {
      success: true,
      message: '🔍 Research 模式未激活\n用法: `/research enter <project>` 进入研究模式',
    };
  }

  // Parse subcommand and optional argument
  const parts = args.split(/\s+/);
  const subcommand = parts[0].toLowerCase();

  switch (subcommand) {
    case 'enter': {
      const projectName = parts.slice(1).join(' ');
      if (!projectName) {
        return {
          success: false,
          message: '⚠️ 请指定项目名称。用法: `/research enter <project>`',
        };
      }
      try {
        const result = researchMode.activateResearch(projectName);
        const statusParts = [];
        if (result.created) {
          statusParts.push('📁 项目目录已创建');
        }
        if (result.claudeMdWritten) {
          statusParts.push('📄 默认 CLAUDE.md 已写入');
        }
        return {
          success: true,
          message: `🔍 已进入 Research 模式\n项目: ${projectName.trim()}\n工作目录: ${result.cwd}${statusParts.length > 0 ? '\n' + statusParts.join('\n') : ''}`,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        return { success: false, message: `⚠️ ${message}` };
      }
    }

    case 'exit': {
      const deactivatedProject = researchMode.deactivateResearch();
      if (deactivatedProject === null) {
        return {
          success: true,
          message: '🔍 Research 模式当前未激活',
        };
      }
      return {
        success: true,
        message: `🔍 已退出 Research 模式\n项目: ${deactivatedProject}`,
      };
    }

    case 'list': {
      const projects = researchMode.listResearchProjects();
      if (projects.length === 0) {
        return {
          success: true,
          message: '🔍 暂无研究项目\n使用 `/research enter <project>` 创建新项目',
        };
      }
      const projectList = projects.map((p) => `  📁 ${p}`).join('\n');
      return {
        success: true,
        message: `🔍 研究项目列表 (${projects.length}):\n${projectList}`,
      };
    }

    default:
      return {
        success: false,
        message: '⚠️ 未知子命令。用法: `/research [enter <project>|exit|list]`',
      };
  }
};
