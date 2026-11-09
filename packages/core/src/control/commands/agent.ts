import type { ControlCommand, ControlResponse } from '../../types/channel.js';
import type { CommandHandler, ControlHandlerContext } from '../types.js';

type AgentCommand = ControlCommand<'agent'>;

function formatPreset(preset: {
  name: string;
  agentBackend: string;
  model: string;
  thinking?: string;
  origin?: 'creation' | 'command';
}): string {
  // Thinking (#4913) and origin are optional; show them only when they apply so
  // legacy responses without the fields render identically.
  const extras = [
    preset.thinking ? `thinking: ${preset.thinking}` : '',
    preset.origin ? `source: ${preset.origin === 'creation' ? 'group creation binding' : '/agent use'}` : '',
  ].filter(Boolean).join(', ');
  return `**${preset.name}** — ${preset.agentBackend} / ${preset.model}${extras ? ` (${extras})` : ''}`;
}

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
    // The switch also saves the choice for the chat, so the same preset is
    // reused by this chat's next messages and after service restarts (#5476).
    const result = api.switchAgentPreset(command.chatId, name, command.threadRootId, command.actorId);
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
      message: `✅ Active agent: ${formatPreset(result.active)}\n\nA new native session will be used; context is not migrated across presets. The choice is saved for this chat and survives service restarts.`,
    };
  }

  if (subcommand !== 'current') {
    return { success: false, message: 'Usage: `/agent [current|list|use <preset>]`' };
  }

  const active = api.getActiveAgentPreset(command.chatId, command.threadRootId);
  return active
    ? { success: true, message: `🤖 Active agent: ${formatPreset(active)}\n\nSelection precedence: /agent use (this session) > the chat's saved /agent use choice > per-app default > global default.` }
    : { success: false, message: 'No named agent presets are configured (legacy `agent:` configuration remains active).' };
};
