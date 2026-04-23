/**
 * /project command handler — manage ProjectContext instances.
 *
 * Sub-commands:
 *   /project list                          → list templates + instances
 *   /project create <template> <name>       → create instance from template
 *   /project use <name>                    → bind to existing instance
 *   /project info                          → show current project details
 *   /project reset                          → reset to default project
 *   /project delete <name>                  → delete an instance
 *
 * @see Issue #1916 (unified ProjectContext system)
 * @see docs/proposals/unified-project-context.md §4.3
 */

import type { ControlCommand, ControlResponse } from '../../types/channel.js';
import type { ControlHandlerContext } from '../types.js';

/**
 * Handle /project commands.
 */
export function handleProject(
  command: ControlCommand,
  context: ControlHandlerContext,
): ControlResponse {
  const { chatId, data } = command;
  const pm = context.projectManager;

  if (!pm) {
    return { success: false, message: 'ProjectManager 未初始化，project 功能不可用' };
  }

  const args = (data?.args as string[]) || [];
  const [sub] = args;

  switch (sub) {
    case 'create': {
      if (!args[1] || !args[2]) {
        return { success: false, message: '用法: /project create <模板名> <实例名>' };
      }
      const result = pm.create(chatId, args[1], args[2]);
      if (result.ok) {
        context.agentPool.reset(chatId);
        return {
          success: true,
          message: `✅ 已创建项目「${args[2]}」（模板: ${args[1]}）并切换到该上下文`,
        };
      }
      return { success: false, message: result.error };
    }

    case 'use': {
      if (!args[1]) {
        return { success: false, message: '用法: /project use <实例名>' };
      }
      const result = pm.use(chatId, args[1]);
      if (result.ok) {
        context.agentPool.reset(chatId);
        return {
          success: true,
          message: `✅ 已切换到项目「${args[1]}」`,
        };
      }
      return { success: false, message: result.error };
    }

    case 'reset': {
      const result = pm.reset(chatId);
      if (result.ok) {
        context.agentPool.reset(chatId);
        return {
          success: true,
          message: '✅ 已重置为默认项目',
        };
      }
      return { success: false, message: result.error };
    }

    case 'list': {
      const templates = pm.listTemplates();
      const instances = pm.listInstances();

      if (templates.length === 0 && instances.length === 0) {
        return {
          success: true,
          message: '📦 当前没有可用的模板和项目实例',
        };
      }

      const lines: string[] = [];

      if (templates.length > 0) {
        lines.push('📋 **可用模板:**');
        for (const t of templates) {
          const desc = t.description ? ` — ${t.description}` : '';
          const display = t.displayName ? `${t.displayName}` : t.name;
          lines.push(`  • ${display}（${t.name}）${desc}`);
        }
      }

      if (instances.length > 0) {
        lines.push('');
        lines.push('📂 **项目实例:**');
        const active = pm.getActive(chatId);
        for (const inst of instances) {
          const isActive = inst.name === active.name ? ' 🔵' : '';
          const chatCount = inst.chatIds.length > 0 ? `（${inst.chatIds.length} 个会话）` : '（无绑定会话）';
          lines.push(`  • ${inst.name}（模板: ${inst.templateName}）${chatCount}${isActive}`);
        }
      }

      return { success: true, message: lines.join('\n') };
    }

    case 'info': {
      const active = pm.getActive(chatId);
      if (active.name === 'default') {
        return {
          success: true,
          message: '🏠 当前项目: default（默认模式）',
        };
      }
      return {
        success: true,
        message: [
          `📂 当前项目: ${active.name}`,
          `   模板: ${active.templateName ?? '未知'}`,
          `   工作目录: ${active.workingDir}`,
        ].join('\n'),
      };
    }

    case 'delete': {
      if (!args[1]) {
        return { success: false, message: '用法: /project delete <实例名>' };
      }
      const result = pm.delete(args[1], { removeWorkingDir: true });
      if (result.ok) {
        return {
          success: true,
          message: `✅ 已删除项目「${args[1]}」`,
        };
      }
      return { success: false, message: result.error };
    }

    default: {
      const knownSubs = ['list', 'create', 'use', 'info', 'reset', 'delete'];
      if (sub && !knownSubs.includes(sub)) {
        return { success: false, message: `未知子命令: ${sub}。可用: ${knownSubs.join('|')}` };
      }
      return {
        success: true,
        message: [
          '📋 **/project 命令帮助**',
          '',
          '  /project list                — 列出可用模板和项目实例',
          '  /project create <模板> <名称> — 从模板创建新项目',
          '  /project use <名称>          — 切换到已有项目',
          '  /project info                — 查看当前项目详情',
          '  /project reset               — 重置为默认项目',
          '  /project delete <名称>       — 删除项目实例',
        ].join('\n'),
      };
    }
  }
}
