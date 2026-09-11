/**
 * /status reports the running service without exposing execution-node roles.
 */
export const handleStatus = (_command, _context) => {
    return {
        success: true,
        message: [
            '📊 **服务状态**',
            '',
            '**状态**: 🟢 运行中',
        ].join('\n'),
    };
};
