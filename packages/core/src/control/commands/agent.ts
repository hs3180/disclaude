import type { ControlCommand, ControlResponse } from '../../types/channel.js';
import type { AgentDimensionSwitchResult, CommandHandler, ControlHandlerContext } from '../types.js';

type AgentCommand = ControlCommand<'agent'>;

function formatPreset(preset: { name: string; agentBackend: string; model: string }): string {
  return `**${preset.name}** — ${preset.agentBackend} / ${preset.model}`;
}

/** Issue #5255: summarize which dimensions diverge from the selected preset. */
function formatOverrides(active: {
  agentBackend: string;
  model: string;
  backendOverride?: string;
  modelOverride?: string;
}): string {
  const parts: string[] = [];
  if (active.backendOverride) { parts.push(`backend=${active.backendOverride}`); }
  if (active.modelOverride) { parts.push(`model=${active.modelOverride}`); }
  return parts.length ? `\n\nOverrides on top of the preset: ${parts.join(', ')}.` : '';
}

const SESSION_BOUNDARY_NOTE =
  'A new native session will be used; context is not migrated across selections. The selection lasts until this service restarts.';

export const handleAgent: CommandHandler<'agent'> = (
  command: AgentCommand,
  context: ControlHandlerContext
): ControlResponse => {
  const api = context.agentPool;
  if (!api.listAgentPresets || !api.getActiveAgentPreset || !api.switchAgentPreset) {
    return { success: false, message: 'Agent presets are not available on this node.' };
  }

  const subcommand = command.data?.subcommand ?? 'current';
  if (subcommand === 'list') {
    const presets = api.listAgentPresets();
    if (presets.length === 0) {
      return { success: false, message: 'No named agent presets are configured (add an `agents:` map).' };
    }
    const active = api.getActiveAgentPreset(command.chatId, command.threadRootId);
    return {
      success: true,
      message: ['🤖 **Agent presets**', '', ...presets.map((preset) =>
        `${preset.name === active?.name ? '→ ' : '- '}${formatPreset(preset)}`
      )].join('\n'),
    };
  }

  if (subcommand === 'use') {
    const name = command.data?.preset?.trim();
    if (!name) {
      return { success: false, message: 'Usage: `/agent use <preset>`' };
    }
    const result = api.switchAgentPreset(command.chatId, name, command.threadRootId);
    if (!result.ok) {
      const canList = !context.isCommandAllowed || context.isCommandAllowed({
        ...command, data: { subcommand: 'list' },
      });
      const recovery = canList
        ? 'Use `/agent list` to find a configured preset, then `/agent use <name>` to switch.'
        : 'Contact the service maintainer to confirm which presets are available.';
      return { success: false, message: `${result.error}\n\nThe current selection is unchanged. ${recovery}` };
    }
    return {
      success: true,
      message: `✅ Active agent: ${formatPreset(result.active)}\n\n${SESSION_BOUNDARY_NOTE}`,
    };
  }

  // Issue #5255: orthogonal dimension switches. Each changes one axis of the
  // session's agent and keeps the other at its current value; incompatible
  // targets answer with that dimension's selectable options, not a dead end.
  if (subcommand === 'backend' || subcommand === 'model') {
    const value = (command.data?.value ?? command.data?.preset ?? '').trim();
    if (!value) {
      return {
        success: false,
        message: subcommand === 'backend'
          ? 'Usage: `/agent backend <claude|pi|codex|dsh>`'
          : 'Usage: `/agent model <model-id>`',
      };
    }
    if (subcommand === 'backend' && !api.switchAgentBackend) {
      return { success: false, message: 'Switching the backend dimension is not available on this node.' };
    }
    if (subcommand === 'model' && !api.switchAgentModel) {
      return { success: false, message: 'Switching the model dimension is not available on this node.' };
    }
    const switcher = subcommand === 'backend' ? api.switchAgentBackend : api.switchAgentModel;
    if (!switcher) {
      return { success: false, message: `Switching the ${subcommand} dimension is not available on this node.` };
    }
    const result: AgentDimensionSwitchResult = switcher(command.chatId, value, command.threadRootId);
    if (!result.ok) {
      const options = result.options?.length
        ? `\n\nAvailable ${subcommand}s: ${result.options.join(', ')}.`
        : '';
      return { success: false, message: `${result.error}${options}\n\nThe current selection is unchanged.` };
    }
    return {
      success: true,
      message: `✅ Active agent: ${formatPreset(result.active)}${formatOverrides(result.active)}\n\n${SESSION_BOUNDARY_NOTE}`,
    };
  }

  if (subcommand !== 'current') {
    return { success: false, message: 'Usage: `/agent [current|list|use <preset>|backend <name>|model <id>]`' };
  }

  const active = api.getActiveAgentPreset(command.chatId, command.threadRootId);
  return active
    ? {
        success: true,
        message: `🤖 Active agent: ${formatPreset(active)}${formatOverrides(active)}\n\nBackend and model can be switched independently with \`/agent backend <name>\` and \`/agent model <id>\`.\n\nSelection scope: this chat/session; persistence: until service restart.`,
      }
    : { success: false, message: 'No agent selection is available on this node (no `agents:` map and no resolvable default agent).' };
};
