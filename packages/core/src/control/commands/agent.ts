import type { ControlCommand, ControlResponse } from '../../types/channel.js';
import type { CommandHandler, ControlHandlerContext } from '../types.js';

type AgentCommand = ControlCommand<'agent'>;

function formatPreset(preset: { name: string; agentBackend: string; model: string }): string {
  return `**${preset.name}** — ${preset.agentBackend} / ${preset.model}`;
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

  const audit = (action: string, outcome: 'denied' | 'applied' | 'rejected', fields: Record<string, unknown>): void => {
    context.logger?.info({ audit: 'agent-binding', action, allowed: outcome !== 'denied', outcome, actorId: command.actorId, sourceChatId: command.chatId, ...fields },
      'Agent binding administration (#5476)');
  };
  const adminOnly = (action: string, target?: { chatId?: string; preset?: string }): ControlResponse | undefined => {
    if (context.agentBindingAdmin?.isAdminActor(command.actorId) === true) { return undefined; }
    audit(action, 'denied', { targetChatId: target?.chatId, presetName: target?.preset });
    return { success: false, message: 'Durable agent bindings require an administrator actor configured in messaging.admin.actorIds.' };
  };

  if (subcommand === 'bind') {
    const targetChatId = command.data?.targetChatId?.trim(), preset = command.data?.preset?.trim();
    if (!api.setAgentBinding || !api.getAgentBinding || !api.clearAgentBinding) {
      return { success: false, message: 'Agent bindings are not available on this node.' };
    }
    if (!targetChatId || !preset) {
      return { success: false, message: 'Usage: `/agent bind <chatId> <preset>`' };
    }
    const denied = adminOnly('bind', { chatId: targetChatId, preset });
    if (denied) { return denied; }
    const result = api.setAgentBinding(targetChatId, preset, command.actorId ?? 'unknown');
    if (!result.ok) {
      audit('bind', 'rejected', { targetChatId, presetName: preset, reason: result.error });
      return { success: false, message: result.error };
    }
    audit('bind', 'applied', { targetChatId, presetName: result.binding.presetName, updatedBy: result.binding.updatedBy });
    return {
      success: true,
      message: `✅ Bound chat \`${targetChatId}\` to agent **${result.binding.presetName}**.\n\nThe binding is durable across restarts and affects the next message (unless \`/agent use\` selected another preset for that session). Busy chats keep their current turn.`,
    };
  }

  if (subcommand === 'binding') {
    const targetChatId = command.data?.targetChatId?.trim();
    if (!api.getAgentBinding) { return { success: false, message: 'Agent bindings are not available on this node.' }; }
    if (!targetChatId) { return { success: false, message: 'Usage: `/agent binding <chatId>`' }; }
    const denied = adminOnly('binding', { chatId: targetChatId });
    if (denied) { return denied; }
    const binding = api.getAgentBinding(targetChatId);
    const active = api.getActiveAgentPreset?.(targetChatId);
    audit('binding', 'applied', { targetChatId, found: !!binding });
    return binding
      ? { success: true, message: `🔗 Chat \`${targetChatId}\` is persistently bound to **${binding.presetName}** (updated ${binding.updatedAt}). Effective for the chat-scoped session: ${active ? formatPreset(active) : 'unavailable'}.` }
      : { success: true, message: `No persistent agent binding for \`${targetChatId}\`. Effective: ${active ? formatPreset(active) : 'the configured default'}.` };
  }

  if (subcommand === 'unbind') {
    const targetChatId = command.data?.targetChatId?.trim();
    if (!api.clearAgentBinding) { return { success: false, message: 'Agent bindings are not available on this node.' }; }
    if (!targetChatId) { return { success: false, message: 'Usage: `/agent unbind <chatId>`' }; }
    const denied = adminOnly('unbind', { chatId: targetChatId });
    if (denied) { return denied; }
    const result = api.clearAgentBinding(targetChatId);
    if (!result.ok) {
      audit('unbind', 'rejected', { targetChatId, reason: result.error });
      return { success: false, message: result.error };
    }
    audit('unbind', 'applied', { targetChatId, previousPresetName: result.binding?.presetName });
    return { success: true, message: `✅ Removed the persistent agent binding for \`${targetChatId}\`${result.binding ? ` (**${result.binding.presetName}**)` : ''}. The next message falls back to the per-app or global default.` };
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
      message: `✅ Active agent: ${formatPreset(result.active)}\n\nA new native session will be used; context is not migrated across presets. The selection lasts until this service restarts.`,
    };
  }

  if (subcommand !== 'current') {
    return { success: false, message: 'Usage: `/agent [current|list|use <preset>|binding <chatId>|bind <chatId> <preset>|unbind <chatId>]`' };
  }

  const active = api.getActiveAgentPreset(command.chatId, command.threadRootId);
  return active
    ? { success: true, message: `🤖 Active agent: ${formatPreset(active)}\n\nSelection precedence: /agent use (this session) > durable /agent bind (chat) > per-app default > global default.` }
    : { success: false, message: 'No named agent presets are configured (legacy `agent:` configuration remains active).' };
};
