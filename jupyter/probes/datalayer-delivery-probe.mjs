import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { parseArgs, promisify } from 'node:util';
import { DatalayerJupyterClient } from '../../packages/core/dist/jupyter/datalayer-client.js';
import { createCLIProbe, probeSource, probeAuth, probeConnection } from './cli-probe-client.mjs';
import { createChannelCallbacksFactory } from '../../packages/service/dist/utils/channel-handlers.js';

// Explicitly opted-in real outbound component check. No model, incoming-event
// subscription or competing bot WebSocket. This cannot pass the product gate.
const { values } = parseArgs({
  options: Object.fromEntries(
    ['env-file', 'project', 'chat-id', 'root-message-id', 'output'].map((name) => [
      name,
      { type: 'string' },
    ])
  ),
});
for (const name of ['project', 'chat-id', 'root-message-id', 'output']) {
  if (!values[name]) {
    throw new Error(`Explicit --${name} required`);
  }
}
if (
  !/^oc_[a-z0-9]+$/.test(values['chat-id']) ||
  !/^om_[a-z0-9]+$/.test(values['root-message-id'])
) {
  throw new Error('Use an authorized chat and the actual root message returned by Feishu');
}
const output = path.resolve(values.output);
const project = fs.realpathSync(values.project);
fs.mkdirSync(output, { mode: 0o700 });
const files = path.join(output, 'sent-files');
fs.mkdirSync(files, { mode: 0o700 });
const auth = await probeAuth(values['env-file']);
const client = new DatalayerJupyterClient({
  ...probeConnection(auth),
  allowInsecureHttp: true,
});
const resources = async () => ({
  kernels: await client.json('api/kernels'),
  sessions: await client.json('api/sessions'),
});
const before = await resources();
const report = {
  source: probeSource(),
  startedAt: new Date().toISOString(),
  scope:
    'Configured remote public CLI snapshot -> generic file callback -> real lark-cli bot thread replies; no Agent/user Lab/device acceptance',
  chatId: values['chat-id'],
  rootMessageId: values['root-message-id'],
  before,
  attempts: [],
};
const save = () =>
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600,
  });
const command = promisify(execFile);
const cli = async (args, cwd, evidence) => {
  const result = await command('lark-cli', args, {
    cwd,
    timeout: 90000,
    maxBuffer: 2000000,
    env: {
      ...process.env,
      LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
      LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1',
    },
  });
  const data = JSON.parse(result.stdout);
  if (data.ok !== true) {
    throw new Error('Feishu did not confirm the component request');
  }
  const raw = JSON.stringify(data, null, 2) + '\n';
  if (raw.includes(auth.secret)) {
    throw new Error('Credential reached evidence');
  }
  fs.writeFileSync(path.join(output, evidence), raw, { mode: 0o600 });
  return data.data;
};
const threadArgs = [
  'im',
  '+threads-messages-list',
  '--as',
  'user',
  '--thread',
  values['root-message-id'],
  '--order',
  'asc',
  '--page-size',
  '20',
  '--no-reactions',
];
const threadBefore = await cli(threadArgs, output, 'thread-before.json');
report.threadId = threadBefore.thread_id;
if (!report.threadId || threadBefore.messages.length) {
  throw new Error('Use a fresh, confirmed owned thread');
}
const nonce = randomUUID().slice(0, 8);
const callbacks = createChannelCallbacksFactory(
  {
    getCapabilities: () => ({ supportsFile: true }),
    sendMessage: async (message) => {
      if (
        message.type !== 'file' ||
        message.chatId !== report.chatId ||
        message.threadId !== report.rootMessageId
      ) {
        throw new Error('Delivery escaped the owned thread');
      }
      const bytes = fs.readFileSync(message.filePath);
      const name = path.basename(message.filePath);
      fs.writeFileSync(path.join(files, name), bytes, { mode: 0o600, flag: 'wx' });
      const index = report.attempts.length;
      const attempt = {
        fileName: name,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        bytes: bytes.length,
        state: 'submitting',
      };
      report.attempts.push(attempt);
      save();
      // Never retry this write after an ambiguous result or confirmation gate.
      const mediaFlag = /\.(png|jpe?g)$/.test(name) ? '--image' : '--file';
      const sent = await cli(
        [
          'im',
          '+messages-reply',
          '--as',
          'bot',
          '--message-id',
          message.threadId,
          '--reply-in-thread',
          mediaFlag,
          './' + name,
          '--idempotency-key',
          `dl063-${nonce}-${index}`,
        ],
        path.dirname(message.filePath),
        `send-${index}.json`
      );
      if (sent.chat_id !== report.chatId || !/^om_[a-z0-9]+$/.test(sent.message_id ?? '')) {
        throw new Error('Actual delivery identity cannot be verified');
      }
      Object.assign(attempt, { state: 'confirmed', messageId: sent.message_id });
      save();
      return sent.message_id;
    },
  },
  { warn() {}, info() {} }
)(report.chatId);
const probe = await createCLIProbe({ envFile: values['env-file'], project, directory: output });
try {
  const list = await probe.call('notebook_list', {});
  if (list.notebooks.length !== 1) throw new Error('Use exactly one owned Notebook');
  const downloaded = await probe.call('notebook_download_report', {
    notebookId: list.notebooks[0].notebookId,
  });
  if (downloaded.state !== 'downloaded')
    throw new Error('CLI did not download a verified snapshot');
  const messageIds = [];
  for (const artifact of downloaded.artifacts) {
    if (
      createHash('sha256').update(fs.readFileSync(artifact.filePath)).digest('hex') !==
      artifact.sha256
    )
      throw new Error('Artifact changed before delivery');
    messageIds.push(
      await callbacks.sendFile(report.chatId, artifact.filePath, report.rootMessageId)
    );
  }
  report.delivery = { ...downloaded, state: 'delivered', messageIds };
  report.threadAfter = await cli(threadArgs, output, 'thread-after.json');
  const actualIds = new Set(report.threadAfter.messages.map((m) => m.message_id));
  report.allFilesInOriginalThread = report.attempts.every((a) => actualIds.has(a.messageId));
  report.completed = report.delivery.state === 'delivered' && report.allFilesInOriginalThread;
} catch (error) {
  report.error = error.message;
  report.completed = false;
} finally {
  await probe.close();
  report.commands = probe.commands;
  await new Promise((resolve) => setTimeout(resolve, 250));
  report.after = await resources();
  report.noKernelOrSessionChanges = ['kernels', 'sessions'].every(
    (kind) =>
      JSON.stringify(before[kind].map((x) => x.id).sort()) ===
      JSON.stringify(report.after[kind].map((x) => x.id).sort())
  );
  report.completed = report.completed === true && report.noKernelOrSessionChanges;
  report.finishedAt = new Date().toISOString();
  save();
}
console.log(
  JSON.stringify({
    completed: report.completed,
    revision: report.delivery?.revision,
    artifacts: report.attempts.length,
    allFilesInOriginalThread: report.allFilesInOriginalThread,
    noKernelOrSessionChanges: report.noKernelOrSessionChanges,
    error: report.error,
  })
);
if (!report.completed) {
  process.exitCode = 1;
}
