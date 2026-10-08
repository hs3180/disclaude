#!/usr/bin/env node
/** Optional Notebook CLI. Loaded only by `disclaude jupyter`. */
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveJupyterAuth } from './jupyter-auth.js';

export async function main(args = process.argv.slice(2)) {
  const { notebookHelp, parseNotebookOptions, runNotebookCommand } =
    await import('../packages/service/dist/jupyter/cli.js');
  if (!args.length || args.includes('--help') || args.includes('-h')) {
    console.log(notebookHelp);
    return;
  }
  const options = parseNotebookOptions(args);
  let client, namespace;
  const getConnection = async () => {
    if (!client) {
      const { baseUrl, mode, secret } = await resolveJupyterAuth(options);
      const { DatalayerJupyterClient } =
        await import('../packages/core/dist/jupyter/datalayer-client.js');
      const endpoint = new URL(baseUrl);
      endpoint.pathname = endpoint.pathname.replace(/\/?$/, '/');
      namespace = createHash('sha256').update(endpoint.href).digest('hex');
      client = new DatalayerJupyterClient({
        baseUrl: endpoint.href,
        ...(mode === 'token'
          ? { authorization: async () => 'token ' + secret }
          : { password: async () => secret }),
        allowInsecureHttp: endpoint.protocol === 'http:',
      });
    }
    return { client, connectionId: options.connectionId, namespace };
  };
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try {
    const result = await runNotebookCommand(options, getConnection, controller.signal);
    console.log(JSON.stringify({ ok: true, command: options.command, data: result }));
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    // Upstream errors and credential prompts can contain private data. Raw
    // exceptions never become model-facing output or persistent CLI logs.
    console.log(
      JSON.stringify({
        ok: false,
        error:
          'Jupyter command failed; check the input schema, Project reference, connection/authentication and original run status. Do not replay an unknown execution.',
      })
    );
    process.exitCode = 1;
  });
}
