process.on('message', message => {
    if (message.kind === 'init') {
        process.stderr.write('fixture startup stderr\n');
        process.send({ kind: 'daemon-started', pid: process.pid, python: 'fixture-python', cwd: 'fixture-cwd' });
    }
    else if (message.kind === 'stop') {
        process.exit(0);
    }
});
export {};
