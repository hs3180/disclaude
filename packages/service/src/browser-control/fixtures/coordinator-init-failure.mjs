process.on('message', message => {
  if (message.kind === 'init') {
    process.stderr.write('fixture init stderr\n');
    process.send({ kind: 'init-error', error: 'fixture startup failed' });
  }
});
