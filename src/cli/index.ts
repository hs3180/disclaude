/**
 * CLI module - Command line interface handlers.
 *
 * Provides CLI command handlers for disclaude:
 * - skill: Manage skill agents (Issue #455)
 *
 * @module cli
 */

export {
  handleSkillCommand,
  showSkillHelp,
  type SkillCommand,
  type SkillRunOptions,
} from './skill-cli.js';
