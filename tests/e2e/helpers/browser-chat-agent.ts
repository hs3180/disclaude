import { expect } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Config, clearProviderCache } from '../../../packages/core/src/index.js';
import { AgentFactory } from '../../../packages/service/src/agents/factory.js';
import { ModelContentionCleanupError } from './browser-model-contention.js';

/** Actual ordinary-agent launch, not a caller-prepared provider environment. */
export async function verifyChatAgentBrowser(root: string, env: NodeJS.ProcessEnv,
  model: string, run: (script: string) => Promise<string>): Promise<void> {
  const backend = process.env.DISCLAUDE_E2E_BROWSER_CHAT_AGENT_BACKEND ?? 'deepseek';
  if (backend !== 'deepseek' && backend !== 'claude') {
    throw new Error(`Unsupported browser ChatAgent acceptance backend: ${backend}`);
  }
  expect(Config.getGlobalEnv().BU_CDP_WS).toBe('ws://configured-browser-marker.invalid');
  const injected: NodeJS.ProcessEnv = {
    BU_CDP_URL: 'http://inherited-browser-marker.invalid:9223',
    CHROMIUM_CDP_PORT: '9223',
    // Supply the same service-owned IPC discovery that normal agents inherit.
    DISCLAUDE_BROWSER_SOCKET: env.DISCLAUDE_BROWSER_SOCKET,
    DISCLAUDE_BROWSER_BIN: join(root, 'bin'),
    DISCLAUDE_BROWSER_MODE: 'coordinated',
  };
  const previous = Object.fromEntries(Object.keys(injected).map(key => [key, process.env[key]]));
  const reportFile = join(root, 'agent-browser-env.json');
  const probeFile = join(root, 'agent-browser-env.cjs');
  const keys = ['BU_CDP_URL', 'BU_CDP_WS', 'CHROMIUM_CDP_PORT', 'DISCLAUDE_BROWSER_SOCKET', 'DISCLAUDE_BROWSER_BIN'];
  const collect = `JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.map(k=>[k,process.env[k]??null])))`;
  // Collect only named non-secret browser fields. The child is an ordinary tool
  // subprocess, not a model-created agent; preserve that distinction in evidence.
  await writeFile(probeFile, `const fs=require('node:fs'),cp=require('node:child_process'); const main=${collect}; const child=cp.execFileSync(process.execPath,['-e',${JSON.stringify(`process.stdout.write(${collect})`)}],{encoding:'utf8'}); fs.writeFileSync(${JSON.stringify(reportFile)},JSON.stringify({main:JSON.parse(main),child:JSON.parse(child)}));`);
  for (const [key, value] of Object.entries(injected)) { if (value === undefined) { delete process.env[key]; } else { process.env[key] = value; } }
  const id = `browser-entry-${randomUUID()}`;
  const messages: string[] = [];
  let agent: ReturnType<typeof AgentFactory.createAgent> | undefined;
  const marker = `ordinary-agent-${randomUUID()}`;
  const script = `fill_input('#value', ${JSON.stringify(marker)})\nprint(js("document.querySelector('#value').value"))\n`;
  const quote = (s: string): string => `'${s.replaceAll("'", "'\\''")}'`;
  const command = `${quote(process.execPath)} ${quote(probeFile)} && printf '%s' ${quote(script)} | browser-use`;
  let completed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    agent = AgentFactory.createAgent(id, {
    sendMessage: (_chat, text) => { messages.push(text); return Promise.resolve(); },
    sendCard: () => Promise.reject(new Error('No external card delivery in browser entry acceptance')),
    sendFile: () => Promise.reject(new Error('No external file delivery in browser entry acceptance')),
  }, { agentBackend: backend, model, skipHistory: true, cwdProvider: () => root, sdkSessionKey: id });
    await Promise.race([
      agent.runOnce(id, `Use your shell tool to run exactly this command:\n${command}\nThen reply with ${marker}. This is an isolated browser acceptance task. Do not delegate, use direct CDP, launch a browser, inspect credentials, contact other services or modify unrelated files.`, id, 'acceptance-user'),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('ChatAgent browser deadline')), 120_000); }),
    ]);
    completed = true;
    const report = JSON.parse(await readFile(reportFile, 'utf8')) as Record<string, Record<string, string | null>>;
    for (const observed of [report.main, report.child]) {
      expect(observed).toMatchObject({ BU_CDP_URL: null, BU_CDP_WS: null, CHROMIUM_CDP_PORT: null,
        DISCLAUDE_BROWSER_SOCKET: env.DISCLAUDE_BROWSER_SOCKET, DISCLAUDE_BROWSER_BIN: join(root, 'bin') });
    }
    expect(messages.some(text => text.includes(marker))).toBe(true);
    expect(await run("print(js(\"document.querySelector('#value').value\"))\n")).toContain(marker);
    console.info('BROWSER_CHAT_AGENT_ENTRY', JSON.stringify({ backend, actualChatAgent: true,
      inheritedAndConfiguredCdpRemoved: true, toolChildInheritanceVerified: true, independentReadback: true }));
  } finally {
    clearTimeout(timer);
    let cleanupFailed = false;
    try { agent?.dispose(); } catch { cleanupFailed = true; }
    try { clearProviderCache(); } catch { cleanupFailed = true; }
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) { delete process.env[key]; } else { process.env[key] = value; } }
    if (!completed || cleanupFailed) { throw new ModelContentionCleanupError(`ChatAgent termination unconfirmed; inspect owned processes for ${root}`); }
  }
}
