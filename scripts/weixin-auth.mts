/** @deprecated Use `disclaude wechat login`; preserve the source-checkout alias. */
process.argv.splice(2, 0, 'login');
await import('../packages/service/src/channels/wechat/cli.js');
