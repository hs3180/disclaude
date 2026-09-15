import { connectBrowser } from './client.mjs';
import { parseArgs } from 'node:util';
const command = process.argv[2];
try {
  if (!command || ['help', '--help', '-h'].includes(command)) {
    console.log('Usage: disclaude browser start|status|doctor\nstart: run the configured browser coordinator in the foreground\nstatus: query the configured coordinator\ndoctor --binary PATH: test a browser with temporary state\nFor service-managed lifecycle, configure DISCLAUDE_BROWSER_MODE=coordinated and use disclaude start.');
  } else if (command === 'doctor') {
    const { values } = parseArgs({ args: process.argv.slice(3), options: {
      binary: { type: 'string' }, headless: { type: 'boolean', default: false },
      'require-persistence': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    }, strict: true, allowPositionals: false });
    if (values.help) {
      console.log('Usage: disclaude browser doctor --binary /absolute/browser/path [--headless] [--require-persistence]\nRuns two browser cycles with temporary state. Default is headed. JSON output separates browser usability from cookie persistence.');
    } else {
      const { diagnoseBrowser } = await import('./doctor.mjs');
      const controller = new AbortController();
      const cancel = () => controller.abort();
      process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
      try {
        const report = await diagnoseBrowser({ binary: values.binary, headless: values.headless, signal: controller.signal });
        console.log(JSON.stringify(report));
        if (values['require-persistence'] && report.cookiePersistence !== 'retained') process.exitCode = 1;
      } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
    }
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
