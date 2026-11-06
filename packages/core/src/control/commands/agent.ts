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

  // Durable chat bindings ride on /agent use (#5476, PR review: no separate
  // admin commands) — `--bind`/`--unbind` qualify the same verb instead.
  const BINDING_USAGE = 'Usage: `/agent use <preset> --bind <chatId>` sets a durable chat binding, `/agent use --bind <chatId>` queries it and `/agent use --unbind <chatId>` clears it (administrator actors only).';
  const audit = (action: string, outcome: 'denied' | 'applied' | 'rejected', fields: Record<string, unknown>): void => {
    context.logger?.info({ audit: 'agent-binding', action, allowed: outcome !== 'denied', outcome, actorId: command.actorId, sourceChatId: command.chatId, ...fields },
      'Agent binding administration via /agent use (#5476)');
  };
  const adminOnly = (action: string, target?: { chatId?: string; preset?: string }): ControlResponse | undefined => {
    if (context.agentBindingAdmin?.isAdminActor(command.actorId) === true) { return undefined; }
    audit(action, 'denied', { targetChatId: target?.chatId, presetName: target?.preset });
    return { success: false, message: 'Durable agent bindings require an administrator actor configured in messaging.admin.actorIds.' };
  };

  if (subcommand === 'use') {
    const bindChatId = command.data?.bindChatId?.trim();
    const unbindChatId = command.data?.unbindChatId?.trim();

    if (command.data?.bindChatId !== undefined && command.data?.unbindChatId !== undefined) {
      return { success: false, message: `Combine at most one binding qualifier. ${BINDING_USAGE}` };
    }

    if (command.data?.unbindChatId !== undefined) {
      if (!api.clearAgentBinding) { return { success: false, message: 'Agent bindings are not available on this node.' }; }
      if (!unbindChatId) { return { success: false, message: BINDING_USAGE }; }
      const denied = adminOnly('unbind', { chatId: unbindChatId });
      if (denied) { return denied; }
      const result = api.clearAgentBinding(unbindChatId);
      if (!result.ok) {
        audit('unbind', 'rejected', { targetChatId: unbindChatId, reason: result.error });
        return { success: false, message: result.error };
      }
      audit('unbind', 'applied', { targetChatId: unbindChatId, previousPresetName: result.binding?.presetName });
      return { success: true, message: `✅ Removed the persistent agent binding for \`${unbindChatId}\`${result.binding ? ` (**${result.binding.presetName}**)` : ''}. The next message falls back to the per-app or global default.` };
    }

    if (command.data?.bindChatId !== undefined) {
      if (!api.getAgentBinding || !api.setAgentBinding) {
        return { success: false, message: 'Agent bindings are not available on this node.' };
      }
      if (!bindChatId) { return { success: false, message: BINDING_USAGE }; }
      const preset = command.data?.preset?.trim();
      // Audit action mirrors intent: 'bind' sets, 'binding' queries (#5476).
      const denied = adminOnly(preset ? 'bind' : 'binding', { chatId: bindChatId, preset });
      if (denied) { return denied; }
      if (preset) {
        const result = api.setAgentBinding(bindChatId, preset, command.actorId ?? 'unknown');
        if (!result.ok) {
          audit('bind', 'rejected', { targetChatId: bindChatId, presetName: preset, reason: result.error });
          return { success: false, message: result.error };
        }
        audit('bind', 'applied', { targetChatId: bindChatId, presetName: result.binding.presetName, updatedBy: result.binding.updatedBy });
        return {
          success: true,
          message: `✅ Bound chat \`${bindChatId}\` to agent **${result.binding.presetName}**.\n\nThe binding is durable across restarts and affects that chat's next message (an explicit \`/agent use\` in the chat still wins for its session). Busy chats keep their current turn.`,
        };
      }
      const binding = api.getAgentBinding(bindChatId);
      const active = api.getActiveAgentPreset?.(bindChatId);
      audit('binding', 'applied', { targetChatId: bindChatId, found: !!binding });
      return binding
        ? { success: true, message: `🔗 Chat \`${bindChatId}\` is persistently bound to **${binding.presetName}** (updated ${binding.updatedAt}). Effective for the chat-scoped session: ${active ? formatPreset(active) : 'unavailable'}.` }
        : { success: true, message: `No persistent agent binding for \`${bindChatId}\`. Effective: ${active ? formatPreset(active) : 'the configured default'}.` };
    }

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
    return { success: false, message: 'Usage: `/agent [current|list|use <preset> [--bind <chatId>]|use --unbind <chatId>]`' };
  }

  const active = api.getActiveAgentPreset(command.chatId, command.threadRootId);
  return active
    ? { success: true, message: `🤖 Active agent: ${formatPreset(active)}\n\nSelection precedence: /agent use (this session) > durable /agent use --bind (chat) > per-app default > global default.` }
    : { success: false, message: 'No named agent presets are configured (legacy `agent:` configuration remains active).' };
};
