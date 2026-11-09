import { getAvailableCommands } from './index.js';
const WELCOME_EXAMPLES = ['总结这份文件的重点', '把这段话改得更简洁', '帮我列一份周末旅行计划'];
/** Automatic guidance stays task-focused; explicit /help owns the advanced command view. */
export function buildWelcomeMessage(channel) {
    const help = channel === 'wechat'
        ? '发送 /help 可查看全部功能。'
        : '想进一步了解用法或查看完整命令列表，请发送 /help。';
    return [
        '👋 你好，我可以帮你回答问题、整理资料和处理文字。',
        '可以直接照抄发给我：',
        ...WELCOME_EXAMPLES.map(example => `「${example}」`),
        help,
    ].join('\n');
}
/** Help reflects registered handlers, their dependencies and the host's access policy. */
export function buildHelpMessage(command, context, brief = false) {
    const commands = getAvailableCommands(context, command);
    const available = new Set(commands.map(c => c.type));
    const scope = command.chatType === 'topic'
        ? '在当前话题中 @机器人 提问；会话按话题独立。'
        : command.chatType === 'group'
            ? (context.triggerMode?.getMode(command.chatId) === 'always'
                ? '本群已启用全响应，可直接发送任务。' : '在群聊中 @机器人，并说明希望完成的任务。')
            : '直接说明目标、相关资料和期望结果。';
    const capabilities = context.getHelpCapabilities?.();
    const tips = [scope];
    if (capabilities?.supportsFile) {
        tips.push('可发送附件并附上任务说明；读取和处理取决于当前模型及飞书权限。');
    }
    if (capabilities?.supportsThread && command.chatType === 'group') {
        tips.push('话题群请在目标话题中提问；在话题内使用 `/help`，帮助会留在该话题。');
    }
    if (available.has('agent')) {
        tips.push('用 `/agent list` 查看 backend/model 预设，`/agent use <name>` 切换并开始新会话；切换按聊天保存，服务重启后仍生效。');
    }
    if (context.guidance && available.has('help')) {
        tips.push('自动指引每个聊天至多 5 分钟一次；`/help off` 关闭，`/help on` 恢复（重启后恢复默认）。');
    }
    if (brief) {
        const quick = commands.filter(c => ['help', 'stop', 'reset'].includes(c.type)).map(c => `\`/${c.type}\` ${c.description}`);
        return ['👋 **使用指引**', ...tips, ...(quick.length ? [quick.join(' · ')] : [])].join('\n');
    }
    return [
        '📖 **命令列表**', '', ...tips, '',
        '| 命令 | 说明 | 用法 |', '|------|------|------|',
        ...commands.map(c => {
            const usage = c.type === 'help' && !context.guidance ? '/help' : (c.usage ?? `/${c.type}`);
            return `| \`/${c.type}\` | ${c.description.replaceAll('|', '\\|')} | \`${usage.replaceAll('|', '\\|')}\` |`;
        }),
    ].join('\n');
}
export const handleHelp = (command, context) => {
    const mode = command.data?.mode;
    if (mode === 'on' || mode === 'off') {
        if (!context.guidance) {
            return { success: false, message: '此渠道没有自动指引；使用 `/help` 查看已配置的命令。' };
        }
        context.guidance.setEnabled(command.chatId, mode === 'on');
        return { success: true, message: mode === 'off'
                ? '本聊天的自动欢迎与指引已关闭；显式 `/help` 仍可使用。重启服务后恢复默认，可用 `/help on` 提前恢复。'
                : '本聊天的自动欢迎与指引已开启；每个聊天至多 5 分钟一次。' };
    }
    if (mode && mode !== 'brief') {
        return { success: false, message: '用法：`/help`、`/help on` 或 `/help off`。' };
    }
    return { success: true, message: buildHelpMessage(command, context, mode === 'brief') };
};
