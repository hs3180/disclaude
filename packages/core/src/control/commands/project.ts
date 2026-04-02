/**
 * /project command handlers for knowledge base and instructions management.
 *
 * Issue #1916: Claude Projects-like functionality.
 *
 * Commands:
 * - /project list — List all configured projects
 * - /project switch <name> — Switch active project for current chat
 * - /project info — Show current project info and knowledge stats
 *
 * @module control/commands/project
 */

import type { ControlCommand, ControlResponse } from '../../types/channel.js';
import type { ControlHandlerContext, CommandHandler } from '../types.js';
import type { ProjectManager } from '../../project/project-manager.js';

/**
 * Extend ControlHandlerContext to include ProjectManager.
 * This is used at runtime when the ProjectManager is available.
 */
export interface ProjectCommandContext extends ControlHandlerContext {
  projectManager?: ProjectManager;
}

/**
 * Get ProjectManager from context, returning undefined if not available.
 */
function getPM(context: ControlHandlerContext): ProjectManager | undefined {
  return (context as ProjectCommandContext).projectManager;
}

/**
 * No project manager available response.
 */
const noPMResponse: ControlResponse = {
  success: false,
  message: '⚠️ Project management is not configured. Add a `projects` section to `disclaude.config.yaml` to enable.',
};

/**
 * /project list — List all configured projects.
 */
export const handleProjectList: CommandHandler = (
  _command: ControlCommand,
  context: ControlHandlerContext,
): ControlResponse => {
  const pm = getPM(context);
  if (!pm) return noPMResponse;

  const projects = pm.listProjects();

  if (projects.length === 0) {
    return {
      success: true,
      message: '📋 No projects configured.\n\nAdd a `projects` section to `disclaude.config.yaml`:\n```yaml\nprojects:\n  default:\n    instructions_path: ./CLAUDE.md\n    knowledge:\n      - ./docs/\n```',
    };
  }

  const currentProject = pm.getProjectForChat(_command.chatId);

  const projectList = projects.map(name => {
    const config = pm.getProjectConfig(name);
    const isActive = name === currentProject ? ' 👈 **active**' : '';
    const hasInstructions = config?.instructionsPath ? '📝' : '';
    const knowledgeCount = config?.knowledge?.length || 0;
    const knowledgeLabel = knowledgeCount > 0 ? ` 📚×${knowledgeCount}` : '';

    return `- **${name}**${isActive} ${hasInstructions}${knowledgeLabel}`;
  }).join('\n');

  return {
    success: true,
    message: `📋 **Projects** (${projects.length})\n\n${projectList}\n\n📌 Current: **${currentProject}**\nUse \`/project switch <name>\` to switch.`,
  };
};

/**
 * /project switch <name> — Switch active project for current chat.
 */
export const handleProjectSwitch: CommandHandler = (
  command: ControlCommand,
  context: ControlHandlerContext,
): ControlResponse => {
  const pm = getPM(context);
  if (!pm) return noPMResponse;

  const projectName = command.data?.name as string | undefined;
  if (!projectName) {
    return {
      success: false,
      message: '❌ Usage: `/project switch <name>`\n\nRun `/project list` to see available projects.',
    };
  }

  if (!pm.hasProject(projectName)) {
    const available = pm.listProjects().join(', ') || '(none)';
    return {
      success: false,
      message: `❌ Project "${projectName}" not found.\n\nAvailable projects: ${available}`,
    };
  }

  pm.setProjectForChat(command.chatId, projectName);
  const ctx = pm.loadProject(projectName);

  const parts: string[] = [
    `✅ Switched to project **${projectName}**`,
  ];

  if (ctx.instructions) {
    parts.push(`📝 Instructions loaded (${ctx.instructions.length} chars)`);
  }

  if (ctx.knowledgeFiles.length > 0) {
    parts.push(`📚 Knowledge base: ${ctx.knowledgeFiles.length} files (${ctx.totalChars} chars total)`);
  }

  return {
    success: true,
    message: parts.join('\n'),
  };
};

/**
 * /project info — Show current project details.
 */
export const handleProjectInfo: CommandHandler = (
  command: ControlCommand,
  context: ControlHandlerContext,
): ControlResponse => {
  const pm = getPM(context);
  if (!pm) return noPMResponse;

  const projectName = pm.getProjectForChat(command.chatId);
  const ctx = pm.loadProject(projectName);
  const config = pm.getProjectConfig(projectName);

  const parts: string[] = [
    `📋 **Project:** ${projectName}`,
  ];

  // Instructions
  if (config?.instructionsPath) {
    parts.push(`📝 Instructions: \`${config.instructionsPath}\``);
    if (ctx.instructions) {
      parts.push(`   Loaded: ${ctx.instructions.length} chars`);
    } else {
      parts.push(`   ⚠️ File not found or empty`);
    }
  } else {
    parts.push('📝 Instructions: (none configured)');
  }

  // Knowledge base
  if (config?.knowledge && config.knowledge.length > 0) {
    parts.push(`📚 Knowledge directories:`);
    for (const dir of config.knowledge) {
      parts.push(`   - \`${dir}\``);
    }
    parts.push(`   Files loaded: ${ctx.knowledgeFiles.length}`);
    parts.push(`   Total size: ${ctx.totalChars} chars`);
  } else {
    parts.push('📚 Knowledge base: (none configured)');
  }

  return {
    success: true,
    message: parts.join('\n'),
  };
};
