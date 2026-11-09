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

export const handleAgent: CommandHandler<'agent'> = async (
  command: AgentCommand,
  context: ControlHandlerContext
): Promise<ControlResponse> => {
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
      // Contextual discovery (#4914): at the moment the typed name fails, the
      // restricted picker is the easier path — it lists valid names for you.
      const recovery = canList
        ? (context.agentConfigUi
          ? 'Send `/agent config` to pick from the configured options in a card (no preset names to remember), or `/agent list` + `/agent use <name>`.'
          : 'Use `/agent list` to find a configured preset, then `/agent use <name>` to switch.')
        : 'Contact the service maintainer to confirm which presets are available.';
      return { success: false, message: `${result.error}\n\nThe current selection is unchanged. ${recovery}` };
    }
    return {
      success: true,
      message: `✅ Active agent: ${formatPreset(result.active)}\n\nA new native session will be used; context is not migrated across presets. The choice is saved for this chat and survives service restarts.`,
    };
  }

  if (subcommand === 'config') {
    // Issue #4914: delegate to the channel's native configuration card; the
    // card consumes the same catalog and selection service as `use` below.
    if (!command.actorId) {
      return { success: false, message: '无法识别操作者，未打开配置卡片。请从聊天消息发起 `/agent config`。' };
    }
    if (!context.agentConfigUi) {
      return { success: false, message: '此渠道没有原生配置卡片。用 `/agent list` 查看预设，`/agent use <name>` 切换。' };
    }
    try {
      const sent = await context.agentConfigUi.openConfigCard({
        chatId: command.chatId,
        ...(command.threadRootId ? { threadRootId: command.threadRootId } : {}),
        actorId: command.actorId,
      });
      return sent.ok
        ? {
            success: true,
            message: '🧩 配置卡片已发送：在卡片上依次选择 harness / model / thinking 后确认。确认生效前当前选择不变。',
          }
        : {
            success: false,
            message: `配置卡片发送失败：${sent.error}\n\n仍可用 \`/agent list\` 与 \`/agent use <name>\` 完成切换。`,
          };
    } catch (error) {
      return {
        success: false,
        message: '配置卡片发送失败。仍可用 `/agent list` 与 `/agent use <name>` 完成切换。',
        error: error instanceof Error ? error.message : String(error),
      };
    }
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
    return { success: false, message: 'Usage: `/agent [current|list|use <preset>|backend <name>|model <id>|config]`' };
  }

  const active = api.getActiveAgentPreset(command.chatId, command.threadRootId);
  // Asking `/agent` at all is the strongest config-intent signal; when a
  // native card exists, point at it right here (#4914 contextual discovery).
  const cardHint = context.agentConfigUi
    ? '\n\nSwitch or review it with `/agent config` — a card with restricted options, no model IDs to type.'
    : '';
  return active
    ? {
        success: true,
        message: `🤖 Active agent: ${formatPreset(active)}${formatOverrides(active)}\n\nBackend and model can be switched independently with \`/agent backend <name>\` and \`/agent model <id>\`.\n\nSelection precedence: this session's switches (/agent use, backend, model) > the chat's saved /agent use choice > per-app default > global default. Dimension switches last until the next /agent use or service restart.${cardHint}`,
      }
    : { success: false, message: 'No agent selection is available on this node (no `agents:` map and no resolvable default agent).' };
};
