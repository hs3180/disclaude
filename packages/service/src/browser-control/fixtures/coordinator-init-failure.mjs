process.on('message', message => {
  if (message.kind === 'init') process.send({ kind: 'init-error', error: 'fixture startup failed' });
});
