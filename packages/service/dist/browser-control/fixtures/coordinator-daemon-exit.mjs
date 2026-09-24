process.on('message', message => {
    if (message.kind === 'init') {
        process.send({ kind: 'daemon-started', pid: 4242, python: 'fixture-python', cwd: 'fixture-cwd' });
        setTimeout(() => process.send({ kind: 'daemon-exit', code: 2, signal: null }, () => process.exit(2)), 10);
    }
});
export {};
