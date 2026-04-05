/**
 * Project control commands.
 *
 * Issue #1916: Commands for managing project-scoped instructions
 * and knowledge base.
 *
 * Commands:
 * - list-project: List all available projects
 * - switch-project: Switch active project for current chat
 * - project-info: Show current project configuration
 *
 * @module control/commands/project
 */

import type { CommandHandler, CommandDefinition, ControlHandlerContext } from '../types.js';

/** Minimal ProjectManager interface for command handlers. */
interface ProjectManagerLike {
  listProjects(): string[];
  hasProject(name: string): boolean;
  getActiveProjectName(chatId: string): string | null;
  switchProject(chatId: string, projectName: string): boolean;
  getProjectConfig(name: string): {
    name?: string;
    instructions_path?: string;
    knowledge?: string[];
    max_knowledge_length?: number;
  } | undefined;
}

/**
 * Extract ProjectManager from command context.
 */
function getProjectManager(context: ControlHandlerContext): ProjectManagerLike | undefined {
  return (context as unknown as Record<string, unknown>).projectManager as ProjectManagerLike | undefined;
}

/**
 * Handle /list-project command.
 * Lists all available projects and indicates which one is active.
 */
const handleListProject: CommandHandler = async (command, context) => {
  const projectManager = getProjectManager(context);

  if (!projectManager) {
    return {
      success: false,
      error: 'Project management is not configured. Add a "projects" section to disclaude.config.yaml.',
    };
  }

  const projects = projectManager.listProjects();
  if (projects.length === 0) {
    return {
      success: true,
      message: '📚 No projects configured.\n\nAdd a "projects" section to disclaude.config.yaml:\n```yaml\nprojects:\n  default:\n    instructions_path: ./CLAUDE.md\n    knowledge:\n      - ./docs/\n```',
    };
  }

  const activeProject = projectManager.getActiveProjectName(command.chatId);
  const projectList = projects
    .map(name => {
      const isActive = name === activeProject ? ' ← active' : '';
      return `- **${name}**${isActive}`;
    })
    .join('\n');

  return {
    success: true,
    message: `📚 **Available Projects**\n\n${projectList}\n\nUse \`/switch-project <name>\` to switch.`,
  };
};

/**
 * Handle /switch-project command.
 * Switches the active project for the current chat.
 */
const handleSwitchProject: CommandHandler = async (command, context) => {
  const projectManager = getProjectManager(context);

  if (!projectManager) {
    return {
      success: false,
      error: 'Project management is not configured.',
    };
  }

  const projectName = command.data?.projectName as string | undefined;
  if (!projectName) {
    return {
      success: false,
      error: 'Usage: /switch-project <name>\n\nUse /list-project to see available projects.',
    };
  }

  if (!projectManager.hasProject(projectName)) {
    const available = projectManager.listProjects();
    return {
      success: false,
      error: `Project "${projectName}" not found.\n\nAvailable projects: ${available.join(', ') || 'none'}`,
    };
  }

  const switched = projectManager.switchProject(command.chatId, projectName);
  if (!switched) {
    return {
      success: false,
      error: `Failed to switch to project "${projectName}".`,
    };
  }

  const config = projectManager.getProjectConfig(projectName);
  const details: string[] = [];
  if (config?.instructions_path) {
    details.push(`- 📝 Instructions: \`${config.instructions_path}\``);
  }
  if (config?.knowledge?.length) {
    details.push(`- 📚 Knowledge: ${config.knowledge.length} source(s)`);
  }

  return {
    success: true,
    message: `✅ Switched to project **${projectName}**\n\n${details.join('\n')}`,
  };
};

/**
 * Handle /project-info command.
 * Shows detailed info about the current active project.
 */
const handleProjectInfo: CommandHandler = async (command, context) => {
  const projectManager = getProjectManager(context);

  if (!projectManager) {
    return {
      success: false,
      error: 'Project management is not configured.',
    };
  }

  const activeProject = projectManager.getActiveProjectName(command.chatId);
  if (!activeProject) {
    return {
      success: true,
      message: '📚 No active project.\n\nUse /list-project to see available projects.',
    };
  }

  const config = projectManager.getProjectConfig(activeProject);
  const info: string[] = [
    `## 📚 Project: ${activeProject}`,
  ];

  if (config?.name) {
    info.push(`- **Display Name**: ${config.name}`);
  }
  if (config?.instructions_path) {
    info.push(`- **Instructions**: \`${config.instructions_path}\``);
  } else {
    info.push('- **Instructions**: (default CLAUDE.md)');
  }
  if (config?.knowledge?.length) {
    info.push(`- **Knowledge Sources**: ${config.knowledge.length}`);
    for (const source of config.knowledge) {
      info.push(`  - \`${source}\``);
    }
  } else {
    info.push('- **Knowledge Sources**: none');
  }
  if (config?.max_knowledge_length) {
    info.push(`- **Max Knowledge Length**: ${config.max_knowledge_length.toLocaleString()} chars`);
  }

  return {
    success: true,
    message: info.join('\n'),
  };
};

export const handleListProjectDef: CommandDefinition = {
  type: 'list-project',
  handler: handleListProject,
  description: '列出所有可用项目',
};

export const handleSwitchProjectDef: CommandDefinition = {
  type: 'switch-project',
  handler: handleSwitchProject,
  description: '切换当前聊天的活跃项目',
  usage: '/switch-project <name>',
};

export const handleProjectInfoDef: CommandDefinition = {
  type: 'project-info',
  handler: handleProjectInfo,
  description: '显示当前活跃项目信息',
};
