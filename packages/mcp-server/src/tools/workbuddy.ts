/**
 * workbuddy_execute tool implementation.
 *
 * Sends a command to a WorkBuddy instance for local execution.
 * WorkBuddy is a lightweight Agent running on the user's local machine.
 *
 * @see Issue #3442
 * @module mcp-server/tools/workbuddy
 */

import { createLogger, Config, WorkBuddyManager } from '@disclaude/core';

const logger = createLogger('WorkBuddyTool');

/** Lazy-initialized singleton manager */
let manager: WorkBuddyManager | null = null;

/**
 * Get or create the WorkBuddyManager singleton.
 */
function getManager(): WorkBuddyManager | null {
  if (manager) {
    return manager;
  }

  const config = Config.getWorkBuddyConfig();
  if (!config || !config.projects || Object.keys(config.projects).length === 0) {
    return null;
  }

  manager = new WorkBuddyManager({ config });
  return manager;
}

/**
 * Reset the manager (for testing).
 */
export function resetManager(): void {
  manager = null;
}

/**
 * Execute a command on a WorkBuddy instance.
 *
 * @param params.project - Project name (as configured in disclaude.config.yaml)
 * @param params.command - Command to execute (e.g., 'preview', 'upload')
 * @param params.args - Optional command arguments
 */
export async function workbuddy_execute(params: {
  project: string;
  command: string;
  args?: Record<string, unknown>;
}): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: true }> {
  const { project, command, args } = params;

  logger.info({ project, command }, 'workbuddy_execute called');

  try {
    const mgr = getManager();
    if (!mgr) {
      return {
        content: [{ type: 'text', text: '❌ WorkBuddy 未配置。请在 disclaude.config.yaml 中添加 workbuddy 配置。' }],
        isError: true,
      };
    }

    if (!project) {
      return {
        content: [{ type: 'text', text: `❌ project 参数不能为空。可用的项目: ${mgr.getProjectNames().join(', ')}` }],
        isError: true,
      };
    }

    if (!command) {
      return {
        content: [{ type: 'text', text: '❌ command 参数不能为空。' }],
        isError: true,
      };
    }

    const result = await mgr.executeCommand(project, command, args);

    if (!result.ok) {
      return {
        content: [{ type: 'text', text: `❌ ${result.error}` }],
        isError: true,
      };
    }

    const { data } = result;
    if (data.success) {
      const dataStr = data.data ? JSON.stringify(data.data, null, 2) : '';
      const duration = data.durationMs ? ` (${data.durationMs}ms)` : '';
      return {
        content: [{ type: 'text', text: `✅ WorkBuddy 命令执行成功${duration}${dataStr ? `\n${dataStr}` : ''}` }],
      };
    } else {
      return {
        content: [{ type: 'text', text: `❌ WorkBuddy 命令执行失败: ${data.error || '未知错误'}` }],
        isError: true,
      };
    }
  } catch (error) {
    logger.error({ err: error, project, command }, 'workbuddy_execute FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return {
      content: [{ type: 'text', text: `❌ WorkBuddy 工具异常: ${errorMessage}` }],
      isError: true,
    };
  }
}

/**
 * List all configured WorkBuddy instances and their status.
 */
export function workbuddy_list(): { content: Array<{ type: 'text'; text: string }> } {
  const mgr = getManager();
  if (!mgr) {
    return {
      content: [{ type: 'text', text: 'WorkBuddy 未配置。请在 disclaude.config.yaml 中添加 workbuddy 配置。' }],
    };
  }

  const instances = mgr.listInstances();
  if (instances.length === 0) {
    return {
      content: [{ type: 'text', text: '没有已注册的 WorkBuddy 实例。' }],
    };
  }

  const lines = instances.map((inst) => {
    const chatIdStr = inst.config.chatId ? ` → ${inst.config.chatId}` : '';
    const toolsStr = inst.config.tools?.length ? ` [${inst.config.tools.join(', ')}]` : '';
    return `- **${inst.name}**: ${inst.status} | ${inst.config.endpoint}${chatIdStr}${toolsStr}`;
  });

  return {
    content: [{ type: 'text', text: `**WorkBuddy 实例 (${instances.length})**:\n${lines.join('\n')}` }],
  };
}

/**
 * Check health of all WorkBuddy instances.
 */
export async function workbuddy_health(): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const mgr = getManager();
  if (!mgr) {
    return {
      content: [{ type: 'text', text: 'WorkBuddy 未配置。' }],
    };
  }

  const results = await mgr.checkAllHealth();
  const lines = Object.entries(results).map(([name, status]) => {
    const icon = status === 'connected' ? '🟢' : status === 'disconnected' ? '🔴' : '⚪';
    return `- ${icon} **${name}**: ${status}`;
  });

  return {
    content: [{ type: 'text', text: `**WorkBuddy 健康检查**:\n${lines.join('\n')}` }],
  };
}
