process.on('message', message => {
    if (message.kind === 'init')
        process.send({ kind: 'ready' });
    else if (message.kind === 'stop')
        process.exit(0);
});
export {};
