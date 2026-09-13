function formatPreset(preset) {
    return `**${preset.name}** — ${preset.agentBackend} / ${preset.model}`;
}
export const handleAgent = (command, context) => {
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
            message: ['🤖 **Agent presets**', '', ...presets.map((preset) => `${preset.name === active?.name ? '→ ' : '- '}${formatPreset(preset)}`)].join('\n'),
        };
    }
    if (subcommand === 'use') {
        const name = command.data?.preset?.trim();
        if (!name) {
            return { success: false, message: 'Usage: `/agent use <preset>`' };
        }
        const result = api.switchAgentPreset(command.chatId, name, command.threadRootId);
        if (!result.ok) {
            return { success: false, message: result.error };
        }
        return {
            success: true,
            message: `✅ Active agent: ${formatPreset(result.active)}\n\nA new native session will be used; context is not migrated across presets. The selection lasts until this service restarts.`,
        };
    }
    if (subcommand !== 'current') {
        return { success: false, message: 'Usage: `/agent [current|list|use <preset>]`' };
    }
    const active = api.getActiveAgentPreset(command.chatId, command.threadRootId);
    return active
        ? { success: true, message: `🤖 Active agent: ${formatPreset(active)}\n\nSelection scope: this chat/session; persistence: until service restart.` }
        : { success: false, message: 'No named agent presets are configured (legacy `agent:` configuration remains active).' };
};
