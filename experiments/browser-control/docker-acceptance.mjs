import { readdirSync, existsSync } from 'node:fs';
const directory = readdirSync('/ms-playwright').find(name => /^chromium-\d+$/.test(name));
if (!directory) throw new Error('Pinned Playwright image has no Chromium');
const binary = ['chrome-linux64', 'chrome-linux'].map(name => `/ms-playwright/${directory}/${name}/chrome`).find(existsSync);
if (!binary) throw new Error('Unsupported Chromium image layout');
process.env.DISCLAUDE_CHROMIUM_BINARY = binary;
process.env.DISCLAUDE_BROWSER_PYTHON = '/opt/browser-env/bin/python';
process.env.DISCLAUDE_BROWSER_MANAGED = '1';
// Linux image explicitly promises persistent storage; keep this regression strict.
process.env.DISCLAUDE_BROWSER_REQUIRE_PERSISTENCE ??= '1';
await import('./harness-acceptance.mjs');
