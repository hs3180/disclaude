import { connectBrowser } from './client.mjs';
import { resolveBrowserSocketPath } from '@disclaude/core/browser-runtime';
import { BROWSER_PYTHON_REQUIREMENTS, installBrowserPythonRuntime } from './python-runtime.mjs';
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
  return env;
}
try {
  if (!command || ['help', '--help', '-h'].includes(command)) {
    console.log('Usage: disclaude browser status [--config PATH]|doctor|runtime install\nstatus: query the browser coordinator owned by the Disclaude service\ndoctor --binary PATH: test a browser with temporary state\nruntime install: create an isolated, dependency-checked Python runtime for the browser harness\nThe coordinator lifecycle belongs to disclaude start; this command does not start an independent broker.');
  } else if (command === 'runtime') {
    const subcommand = process.argv[3];
    if (['help', '--help', '-h'].includes(subcommand) || process.argv[4] === '--help') {
      console.log('Usage: disclaude browser runtime install\nCreates an isolated Python environment under the user data directory and installs the pinned browser-use and browser-harness packages. Existing managed environments are validated and never overwritten.');
    } else if (subcommand === 'install' && process.argv.length === 4) {
      const runtime = installBrowserPythonRuntime(process.env);
      const packages = Object.entries(BROWSER_PYTHON_REQUIREMENTS)
        .map(([name, version]) => `${name}=${version}`)
        .join(', ');
      console.log(`Browser harness runtime ready: ${runtime.executable} (Python ${runtime.pythonVersion}; ${packages}; pip check passed)`);
    } else {
      throw new Error('Usage: disclaude browser runtime install');
    }
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
    const client = await connectBrowser(resolveBrowserSocketPath(env));
    let timer;
    try {
      const status = await Promise.race([client.request('status'), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Browser status timed out')), 3000); })]);
      console.log(JSON.stringify(status));
      if (status.state === 'unavailable' || status.state === 'quarantined') process.exitCode = 1;
    } finally { clearTimeout(timer); client.close(); }
  } else { throw new Error(`Unknown browser command: ${command}`); }
} catch (error) { console.error(error.message); process.exitCode = 1; }
