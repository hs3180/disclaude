import { connectBrowser } from './client.mjs';
import { parseArgs } from 'node:util';
const command = process.argv[2];
function explicitConfigPath(args) {
  let path;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config' || args[i] === '-c') {
      if (args[i + 1] && !args[i + 1].startsWith('-')) path = args[++i];
    }
  }
  return path;
}
async function resolveBrowserEnvironment() {
  const configPath = explicitConfigPath(process.argv.slice(3));
  if (configPath) process.env.DISCLAUDE_CONFIG_PATH = configPath;
  const config = await import('@disclaude/core/config-discovery');
  const env = { ...config.loadConfigEnvironment(configPath), ...process.env };
  const { loadMigratedBrowserEnv } = await import('./legacy-migration.js');
  loadMigratedBrowserEnv(env);
  return env;
}
try {
  if (!command || ['help', '--help', '-h'].includes(command)) {
    console.log('Usage: disclaude browser status [--config PATH]|doctor\nstatus: query the browser coordinator owned by the Disclaude service\ndoctor --binary PATH: test a browser with temporary state\nThe coordinator lifecycle belongs to disclaude start; this command does not start an independent broker.');
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
    throw new Error('Independent browser IPC startup is no longer supported; use disclaude start to own the coordinator lifecycle');
  } else if (command === 'status') {
    const env = await resolveBrowserEnvironment();
    if (!env.DISCLAUDE_BROWSER_SOCKET) throw new Error('Browser IPC is not configured; set it in the Disclaude config or pass --config');
    const client = await connectBrowser(env.DISCLAUDE_BROWSER_SOCKET);
    let timer;
    try {
      const status = await Promise.race([client.request('status'), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Browser status timed out')), 3000); })]);
      console.log(JSON.stringify(status));
      if (status.state === 'unavailable' || status.state === 'quarantined') process.exitCode = 1;
    } finally { clearTimeout(timer); client.close(); }
  } else { throw new Error(`Unknown browser command: ${command}`); }
} catch (error) { console.error(error.message); process.exitCode = 1; }
