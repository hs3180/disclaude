/**
 * CLI handler for skill commands.
 *
 * Implements CLI commands for Issue #455 - Skill Agent System:
 * - `disclaude skill run <skill-name> [options]` - Start a skill agent
 * - `disclaude skill list` - List running agents
 * - `disclaude skill stop <agent-id>` - Stop an agent
 *
 * @module cli/skill-cli
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { Config } from '../config/index.js';
import { createLogger } from '../utils/logger.js';
import {
  SkillAgentManager,
  type SkillAgentInfo,
} from '../agents/skill-agent-manager.js';
import type { BaseAgentConfig } from '../agents/types.js';

// Logger is available for future debugging
const _logger = createLogger('skill-cli');
void _logger;

/**
 * Skill CLI command type.
 */
export type SkillCommand = 'run' | 'list' | 'stop';

/**
 * Options for skill run command.
 */
export interface SkillRunOptions {
  /** Skill name or path */
  skill: string;
  /** Template variables (key=value format) */
  vars?: Record<string, string>;
  /** Chat ID for result notification */
  chatId?: string;
  /** Run in foreground (block until complete) */
  foreground?: boolean;
}

/**
 * Parse template variables from command line.
 *
 * @param args - Array of key=value strings
 * @returns Object with key-value pairs
 */
function parseVars(args: string[] | undefined): Record<string, string> | undefined {
  if (!args || args.length === 0) {
    return undefined;
  }
  const result: Record<string, string> = {};
  for (const arg of args) {
    const [key, ...valueParts] = arg.split('=');
    if (key && valueParts.length > 0) {
      result[key] = valueParts.join('=');
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Resolve skill path from skill name.
 *
 * @param skillName - Skill name or path
 * @returns Resolved skill path
 */
async function resolveSkillPath(skillName: string): Promise<string> {
  // If it's already an absolute path or looks like a file path
  if (path.isAbsolute(skillName) || skillName.includes('/')) {
    return skillName;
  }

  // Try to find skill in workspace/.claude/skills/
  const workspaceDir = Config.getWorkspaceDir();
  const skillDirs = [
    path.join(workspaceDir, '.claude/skills', skillName, 'SKILL.md'),
    path.join(workspaceDir, 'skills', skillName, 'SKILL.md'),
  ];

  for (const skillPath of skillDirs) {
    try {
      await fs.access(skillPath);
      return skillPath;
    } catch {
      // Continue to next path
    }
  }

  // Return as-is if not found (will fail later with clear error)
  return path.join(workspaceDir, '.claude/skills', skillName, 'SKILL.md');
}

/**
 * Show skill CLI help.
 */
export function showSkillHelp(): void {
  console.log('');
  console.log('Skill Agent Commands (Issue #455):');
  console.log('');
  console.log('Usage:');
  console.log('  disclaude skill run <skill-name> [options]   Run a skill agent');
  console.log('  disclaude skill list                         List all skill agents');
  console.log('  disclaude skill stop <agent-id>              Stop a running agent');
  console.log('');
  console.log('Run Options:');
  console.log('  --var <key=value>       Template variable (can be used multiple times)');
  console.log('  --chat-id <chatId>      Chat ID for result notification');
  console.log('  --foreground            Run in foreground (wait for completion)');
  console.log('');
  console.log('Examples:');
  console.log('  # Run a skill in background');
  console.log('  disclaude skill run evaluator --var taskId=task-123');
  console.log('');
  console.log('  # Run a skill in foreground');
  console.log('  disclaude skill run site-miner --foreground');
  console.log('');
  console.log('  # List all agents');
  console.log('  disclaude skill list');
  console.log('');
  console.log('  # Stop an agent');
  console.log('  disclaude skill stop abc-123-def');
  console.log('');
}

/**
 * Format agent info for display.
 */
function formatAgentInfo(info: SkillAgentInfo): string {
  const statusEmoji = {
    running: '🔄',
    completed: '✅',
    failed: '❌',
    stopped: '⏹️',
  };
  const emoji = statusEmoji[info.status] || '❓';

  let output = `${emoji} ${info.id.slice(0, 8)}... | ${info.name} | ${info.status}`;

  if (info.chatId) {
    output += ` | chat: ${info.chatId.slice(0, 12)}...`;
  }

  if (info.completedAt) {
    output += ` | completed: ${info.completedAt}`;
  } else {
    output += ` | started: ${info.startedAt}`;
  }

  return output;
}

/**
 * Handle skill run command.
 */
async function handleRun(
  manager: SkillAgentManager,
  options: SkillRunOptions
): Promise<void> {
  const skillPath = await resolveSkillPath(options.skill);

  console.log(`🚀 Starting skill agent: ${options.skill}`);
  console.log(`   Skill path: ${skillPath}`);
  if (options.vars) {
    console.log(`   Variables: ${JSON.stringify(options.vars)}`);
  }
  if (options.chatId) {
    console.log(`   Chat ID: ${options.chatId}`);
  }

  try {
    const agentId = await manager.start({
      skillPath,
      chatId: options.chatId,
      templateVars: options.vars,
      onComplete: result => {
        if (!options.foreground) {
          console.log(`\n✅ Agent ${agentId.slice(0, 8)}... completed`);
          console.log(`   Result: ${result.slice(0, 200)}${result.length > 200 ? '...' : ''}`);
        }
      },
      onError: error => {
        if (!options.foreground) {
          console.error(`\n❌ Agent ${agentId.slice(0, 8)}... failed: ${error}`);
        }
      },
    });

    console.log(`✅ Agent started with ID: ${agentId}`);

    if (options.foreground) {
      console.log('⏳ Running in foreground, waiting for completion...');

      // Wait for agent to complete
      return new Promise((resolve, reject) => {
        const checkInterval = setInterval(() => {
          const info = manager.get(agentId);
          if (!info) {
            clearInterval(checkInterval);
            reject(new Error('Agent disappeared'));
            return;
          }

          if (info.status === 'completed') {
            clearInterval(checkInterval);
            console.log(`\n✅ Agent completed`);
            if (info.result) {
              console.log(`\n--- Result ---\n${info.result}`);
            }
            resolve();
          } else if (info.status === 'failed') {
            clearInterval(checkInterval);
            console.error(`\n❌ Agent failed: ${info.error}`);
            reject(new Error(info.error || 'Agent failed'));
          } else if (info.status === 'stopped') {
            clearInterval(checkInterval);
            console.log(`\n⏹️ Agent stopped`);
            resolve();
          }
        }, 500);
      });
    } else {
      console.log('\n💡 Use `disclaude skill list` to check status');
      console.log(`💡 Use \`disclaude skill stop ${agentId}\` to stop`);
    }
  } catch (error) {
    console.error(`❌ Failed to start agent: ${error}`);
    throw error;
  }
}

/**
 * Handle skill list command.
 */
async function handleList(manager: SkillAgentManager): Promise<void> {
  const agents = manager.list();

  if (agents.length === 0) {
    console.log('No skill agents found.');
    return;
  }

  console.log(`\n📋 Skill Agents (${agents.length}):\n`);
  console.log('ID        | Name          | Status    | Details');
  console.log('-'.repeat(60));

  for (const info of agents) {
    console.log(formatAgentInfo(info));
  }

  const running = agents.filter(a => a.status === 'running').length;
  const completed = agents.filter(a => a.status === 'completed').length;
  const failed = agents.filter(a => a.status === 'failed').length;

  console.log('');
  console.log(`Summary: ${running} running, ${completed} completed, ${failed} failed`);
}

/**
 * Handle skill stop command.
 */
async function handleStop(
  manager: SkillAgentManager,
  agentId: string
): Promise<void> {
  const info = manager.get(agentId);

  if (!info) {
    // Try partial ID match
    const agents = manager.list().filter(a => a.id.startsWith(agentId));
    if (agents.length === 1) {
      agentId = agents[0].id;
    } else if (agents.length > 1) {
      console.error(`❌ Ambiguous agent ID. Matches:`);
      for (const a of agents) {
        console.error(`   ${a.id} | ${a.name}`);
      }
      return;
    } else {
      console.error(`❌ Agent not found: ${agentId}`);
      return;
    }
  }

  console.log(`⏹️ Stopping agent: ${agentId.slice(0, 8)}...`);

  try {
    await manager.stop(agentId);
    console.log('✅ Agent stopped');
  } catch (error) {
    console.error(`❌ Failed to stop agent: ${error}`);
    throw error;
  }
}

/**
 * Main entry point for skill CLI commands.
 *
 * @param args - Command line arguments (after 'skill')
 * @param agentConfig - Agent configuration
 */
export async function handleSkillCommand(
  args: string[],
  agentConfig: BaseAgentConfig
): Promise<void> {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    showSkillHelp();
    return;
  }

  const command = args[0] as SkillCommand;
  const manager = new SkillAgentManager(agentConfig);

  switch (command) {
    case 'run': {
      if (args.length < 2) {
        console.error('❌ Missing skill name. Usage: disclaude skill run <skill-name> [options]');
        showSkillHelp();
        process.exit(1);
      }

      const skillName = args[1];
      const vars: string[] = [];
      let chatId: string | undefined;
      let foreground = false;

      // Parse options
      for (let i = 2; i < args.length; i++) {
        if (args[i] === '--var' && args[i + 1]) {
          vars.push(args[++i]);
        } else if (args[i] === '--chat-id' && args[i + 1]) {
          chatId = args[++i];
        } else if (args[i] === '--foreground') {
          foreground = true;
        }
      }

      await handleRun(manager, {
        skill: skillName,
        vars: parseVars(vars),
        chatId,
        foreground,
      });
      break;
    }

    case 'list': {
      await handleList(manager);
      break;
    }

    case 'stop': {
      if (args.length < 2) {
        console.error('❌ Missing agent ID. Usage: disclaude skill stop <agent-id>');
        showSkillHelp();
        process.exit(1);
      }

      await handleStop(manager, args[1]);
      break;
    }

    default:
      console.error(`❌ Unknown skill command: ${command}`);
      showSkillHelp();
      process.exit(1);
  }
}
