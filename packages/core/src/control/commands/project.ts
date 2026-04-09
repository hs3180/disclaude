/**
 * /project command handler.
 *
 * Handles project context switching commands:
 * - /project list: List available templates and instances
 * - /project create <template> <name>: Create new instance from template
 * - /project use <name>: Bind to existing instance
 * - /project info: Show current project details
 * - /project reset: Reset to default project
 *
 * @module control/commands/project
 * @see Issue #1916
 */

import type { ControlCommand, ControlResponse } from '../../types/channel.js';
import type { ControlHandlerContext, CommandHandler } from '../types.js';

/**
 * /project command handler
 */
export const handleProject: CommandHandler = (
  command: ControlCommand,
  context: ControlHandlerContext,
): ControlResponse => {
  const pm = context.projectManager;

  if (!pm) {
    return {
      success: false,
      message: '⚠️ ProjectManager 未初始化。请在配置文件中添加 projectTemplates 配置。',
    };
  }

  const args = command.data?.args;
  const sub: string | undefined = Array.isArray(args) ? args[0] : args as string | undefined;

  switch (sub) {
    case 'create': {
      const rawArgs = Array.isArray(args) ? args.slice(1) : [];
      const [templateName, name] = rawArgs;

      if (!templateName || !name) {
        return {
          success: false,
          message: '⚠️ 用法: `/project create <模板名> <实例名>`\n\n使用 `/project list` 查看可用模板。',
        };
      }

      const result = pm.create(command.chatId, templateName, name);
      if (!result.ok) {
        return { success: false, message: `❌ ${result.error}` };
      }

      // Reset session to apply new project context
      context.agentPool.reset(command.chatId);

      return {
        success: true,
        message: `✅ **项目已创建**: ${name}\n\n` +
          `📂 工作目录: \`${result.data.workingDir}\`\n` +
          `📋 模板: ${templateName}\n\n` +
          '会话已重置，下一条消息将使用新项目上下文。',
      };
    }

    case 'use': {
      const rawArgs = Array.isArray(args) ? args.slice(1) : [];
      const [name] = rawArgs;

      if (!name) {
        return {
          success: false,
          message: '⚠️ 用法: `/project use <实例名>`\n\n使用 `/project list` 查看已有实例。',
        };
      }

      const result = pm.use(command.chatId, name);
      if (!result.ok) {
        return { success: false, message: `❌ ${result.error}` };
      }

      // Reset session to apply new project context
      context.agentPool.reset(command.chatId);

      return {
        success: true,
        message: `✅ **已切换到**: ${name}\n\n` +
          `📂 工作目录: \`${result.data.workingDir}\`\n\n` +
          '会话已重置，下一条消息将使用新项目上下文。',
      };
    }

    case 'reset': {
      const result = pm.reset(command.chatId);
      if (!result.ok) {
        return { success: false, message: `❌ ${result.error}` };
      }

      // Reset session
      context.agentPool.reset(command.chatId);

      return {
        success: true,
        message: '✅ **已重置为默认项目**\n\n会话已重置，下一条消息将使用默认工作目录。',
      };
    }

    case 'list': {
      const templates = pm.listTemplates();
      const instances = pm.listInstances();

      let message = '';

      // Templates section
      message += '## 📋 可用模板\n\n';
      if (templates.length === 0) {
        message += '_暂无可用模板。请在配置文件中添加 projectTemplates。_\n\n';
      } else {
        for (const t of templates) {
          message += `- **${t.name}**`;
          if (t.displayName) { message += ` (${t.displayName})`; }
          if (t.description) { message += ` — ${t.description}`; }
          message += '\n';
        }
        message += '\n';
      }

      // Instances section
      message += '## 📁 已创建实例\n\n';
      if (instances.length === 0) {
        message += '_暂无实例。使用 `/project create <模板> <名称>` 创建。_\n';
      } else {
        for (const inst of instances) {
          message += `- **${inst.name}** (模板: ${inst.templateName})`;
          if (inst.chatIds.length > 0) {
            message += ` — 绑定: ${inst.chatIds.length} 个聊天`;
          }
          message += '\n';
        }
      }

      return { success: true, message };
    }

    case 'info': {
      const active = pm.getActive(command.chatId);
      const isDefault = active.name === 'default';

      let message = '## ℹ️ 当前项目\n\n';
      message += `- **名称**: ${active.name}\n`;
      if (!isDefault && active.templateName) {
        message += `- **模板**: ${active.templateName}\n`;
      }
      message += `- **工作目录**: \`${active.workingDir}\`\n`;

      return { success: true, message };
    }

    case undefined:
    case null:
    {
      return {
        success: false,
        message: '⚠️ 用法: `/project <子命令>`\n\n' +
          '可用子命令:\n' +
          '- `list` — 列出可用模板和已创建实例\n' +
          '- `create <模板> <名称>` — 从模板创建新实例\n' +
          '- `use <名称>` — 绑定到已有实例\n' +
          '- `info` — 查看当前项目详情\n' +
          '- `reset` — 重置为默认项目',
      };
    }

    default: {
      return {
        success: false,
        message: `⚠️ 未知子命令: ${sub}\n\n可用: list|create|use|info|reset`,
      };
    }
  }
};
