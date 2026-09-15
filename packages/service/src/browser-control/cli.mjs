import { connectBrowser } from './client.mjs';
const command = process.argv[2];
try {
  if (!command || ['help', '--help', '-h'].includes(command)) {
    console.log('Usage: disclaude browser start|status\nstart: run the configured browser coordinator in the foreground\nstatus: query the configured coordinator\nFor service-managed lifecycle, configure DISCLAUDE_BROWSER_MODE=coordinated and use disclaude start.');
  } else if (command === 'start') {
    await import('./service.mjs');
  } else if (command === 'status') {
    if (!process.env.DISCLAUDE_BROWSER_SOCKET) throw new Error('DISCLAUDE_BROWSER_SOCKET is required');
    const client = await connectBrowser(process.env.DISCLAUDE_BROWSER_SOCKET);
    let timer;
    try {
      const status = await Promise.race([client.request('status'), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Browser status timed out')), 3000); })]);
      console.log(JSON.stringify(status));
      if (status.state === 'unavailable' || status.state === 'quarantined') process.exitCode = 1;
    } finally { clearTimeout(timer); client.close(); }
  } else { throw new Error(`Unknown browser command: ${command}`); }
} catch (error) { console.error(error.message); process.exitCode = 1; }
