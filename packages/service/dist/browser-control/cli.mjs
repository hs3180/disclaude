import { browserStatus } from './service.mjs';
import { resolveBrowserRuntimePath } from "../../../core/dist/utils/browser-env.js";
import { parseArgs } from 'node:util';
const command = process.argv[2];
function explicitConfigPath(args) {
    let path;
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--config' || args[i] === '-c') {
            if (args[i + 1] && !args[i + 1].startsWith('-'))
                path = args[++i];
        }
    }
    return path;
}
async function resolveBrowserEnvironment() {
    const configPath = explicitConfigPath(process.argv.slice(3));
    if (configPath)
        process.env.DISCLAUDE_CONFIG_PATH = configPath;
    const config = await import("../../../core/dist/config/discovery.js");
    const env = { ...config.loadConfigEnvironment(configPath), ...process.env };
    return env;
}
try {
    if (!command || ['help', '--help', '-h'].includes(command)) {
        console.log('Usage: disclaude browser status [--config PATH]|doctor\nstatus: report CLI coordination as idle, busy, or interrupted\ndoctor --binary PATH: test a browser with temporary state\nDisclaude automatically serializes calls to the installed browser-use CLI. No separate coordinator or Python runtime is installed.');
    }
    else if (command === 'doctor') {
        const { values } = parseArgs({ args: process.argv.slice(3), options: {
                binary: { type: 'string' }, headless: { type: 'boolean', default: false },
                'require-persistence': { type: 'boolean', default: false },
                help: { type: 'boolean', short: 'h', default: false },
            }, strict: true, allowPositionals: false });
        if (values.help) {
            console.log('Usage: disclaude browser doctor --binary /absolute/browser/path [--headless] [--require-persistence]\nRuns two browser cycles with temporary state. Default is headed. JSON output separates browser usability from cookie persistence.');
        }
        else {
            const { diagnoseBrowser } = await import('./doctor.mjs');
            const controller = new AbortController();
            const cancel = () => controller.abort();
            process.once('SIGINT', cancel);
            process.once('SIGTERM', cancel);
            try {
                const report = await diagnoseBrowser({ binary: values.binary, headless: values.headless, signal: controller.signal });
                console.log(JSON.stringify(report));
                if (values['require-persistence'] && report.cookiePersistence !== 'retained')
                    process.exitCode = 1;
            }
            finally {
                process.removeListener('SIGINT', cancel);
                process.removeListener('SIGTERM', cancel);
            }
        }
    }
    else if (command === 'start') {
        throw new Error('No separate browser coordinator is needed; use disclaude start');
    }
    else if (command === 'status') {
        const env = await resolveBrowserEnvironment();
        const status = browserStatus(resolveBrowserRuntimePath(env));
        console.log(JSON.stringify(status));
        if (status.state === 'interrupted')
            process.exitCode = 1;
    }
    else {
        throw new Error(`Unknown browser command: ${command}`);
    }
}
catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}
