#!/usr/bin/env node
/** Optional remote Notebook CLI; no agent SDK/config initialization. */
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JupyterAuthError, resolveJupyterAuth } from './jupyter-auth.js';
import { jupyterDiagnostic, jupyterExitCode } from '../packages/core/dist/jupyter/diagnostics.js';

export async function main(args = process.argv.slice(2)) {
  let phase = 'initialize', credentials, client, namespace, options;
  const verbose = args.includes('--verbose');
  const trace = event => { if (verbose) process.stderr.write(JSON.stringify({ jupyterDiagnostic: event }) + '\n'); };
  const discovery = event => { credentials = event; trace(event); };
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  const checks = error => {
    const result = [{ layer: 'auth', phase: 'credential-discovery', state: credentials?.state || 'not_checked' }];
    if (error) {
      if (error.status !== undefined) result.push({ layer: 'tcp', phase: 'connection', state: 'available' });
      result.push({ layer: error.layer, phase: error.phase || phase, state: 'failed', code: error.code,
        ...(error.status === undefined ? {} : { status: error.status }) });
    } else result.push({ layer: 'tcp', phase: 'connection', state: 'available' }, { layer: 'http', phase: 'api-version', state: 'available' });
    return result;
  };
  try {
    const { notebookHelp, parseNotebookOptions, runNotebookCommand } = await import('../packages/service/dist/jupyter/cli.js');
    if (!args.length || args.includes('--help') || args.includes('-h')) {
      console.log(notebookHelp + '\n\nConfigured-server tests: disclaude jupyter test --help'); return;
    }
    phase = 'options'; options = parseNotebookOptions(args);
    const getConnection = async () => {
      if (!client) {
        phase = 'credentials';
        const { baseUrl, mode, secret } = await resolveJupyterAuth(options, { onDiscovery: discovery });
        const { DatalayerJupyterClient } = await import('../packages/core/dist/jupyter/datalayer-client.js');
        const endpoint = new URL(baseUrl); endpoint.pathname = endpoint.pathname.replace(/\/?$/, '/');
        namespace = createHash('sha256').update(endpoint.href).digest('hex');
        client = new DatalayerJupyterClient({ baseUrl: endpoint.href,
          ...(mode === 'token' ? { authorization: async () => 'token ' + secret } : { password: async () => secret }),
          allowInsecureHttp: endpoint.protocol === 'http:', onProgress: trace });
      }
      phase = 'operation';
      return { client, connectionId: options.connectionId, namespace };
    };
    // list is offline Project reference discovery, not remote Notebook inventory
    // or an authentication probe. Resolve only enough to label credential state.
    let listAuth;
    if (options.command === 'list') {
      try {
        await resolveJupyterAuth({ ...options, interactive: false }, { onDiscovery: discovery });
        listAuth = { state: 'configured', authentication: 'not_checked' };
      } catch (error) {
        listAuth = { state: 'unresolved', authentication: 'not_checked',
          diagnostic: error instanceof JupyterAuthError ? error.diagnostic : jupyterDiagnostic(error) };
      }
    }
    phase = 'input';
    const result = await runNotebookCommand(options, getConnection, controller.signal);
    const conflict = result && typeof result === 'object' && result.state === 'conflict' && result.diagnostic?.layer === 'cas';
    if (conflict) {
      console.log(JSON.stringify({ ok: false, command: options.command, data: result, error: result.diagnostic, ...(credentials ? { credentials } : {}) }));
      process.exitCode = jupyterExitCode('cas'); return;
    }
    console.log(JSON.stringify({ ok: true, command: options.command, data: result,
      ...(listAuth ? { scope: 'project-local-references', auth: listAuth } : {}),
      ...(credentials ? { credentials } : {}), ...(options.command === 'check' ? { checks: checks() } : {}) }));
  } catch (error) {
    const diagnostic = error instanceof JupyterAuthError ? error.diagnostic
      : jupyterDiagnostic(error, ['options', 'input'].includes(phase) ? 'schema' : 'unknown');
    console.log(JSON.stringify({ ok: false, command: options?.command || args[0], error: diagnostic,
      ...(credentials ? { credentials } : {}), ...(options?.command === 'check' ? { checks: checks(diagnostic) } : {}) }));
    process.exitCode = jupyterExitCode(diagnostic.layer);
  } finally {
    process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
