export function createScheduleDiagnosticReporter(options) {
    const reported = new Map();
    return (diagnostic) => {
        if (diagnostic.action === 'clear') {
            reported.delete(diagnostic.filePath);
            return;
        }
        const fingerprint = JSON.stringify([
            diagnostic.severity,
            diagnostic.code ?? '',
            diagnostic.message ?? '',
            diagnostic.chatId ?? '',
        ]);
        if (reported.get(diagnostic.filePath) === fingerprint) {
            return;
        }
        reported.set(diagnostic.filePath, fingerprint);
        if (reported.size > 512) {
            const oldestPath = reported.keys().next().value;
            if (oldestPath) {
                reported.delete(oldestPath);
            }
        }
        if (!diagnostic.chatId || !diagnostic.message) {
            return;
        }
        const state = diagnostic.severity === 'error' ? '未能加载' : '配置警告';
        const message = `⚠️ 定时任务 ${diagnostic.taskId} ${state}：${diagnostic.message} 请检查该任务的 SCHEDULE.md。`;
        const reportFailure = () => options.onDeliveryFailure?.(diagnostic.taskId, diagnostic.code);
        try {
            void options.sendMessage(diagnostic.chatId, message).catch(reportFailure);
        }
        catch {
            reportFailure();
        }
    };
}
