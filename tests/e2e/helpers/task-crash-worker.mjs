import {
  Config,
  setDefaultProvider,
  clearProviderCache,
} from '../../../packages/core/dist/index.js';
import { ResearchManager } from '../../../packages/service/dist/research/manager.js';
import { ProjectStore } from '../../../packages/service/dist/research/project.js';
import { createResearchRunner } from '../../../packages/service/dist/research/runner.js';
const [root, phase] = process.argv.slice(2);
setDefaultProvider(Config.AGENT_BACKEND);
const manager = new ResearchManager(
  new ProjectStore(root + '/store'),
  createResearchRunner(root),
  async () => 'captured-card'
);
try {
  let task;
  if (phase === 'first')
    task = await manager.create({
      workingDir: root,
      owner: 'acceptance',
      chat: 'test-chat',
      source: 'crash-request',
      title: 'Wait then inspect the project inventory',
      scope:
        'Execute exactly sleep 30 in the shell, then read only inventory.txt and report its exact identifier and count. Do not modify files, send messages or access the network. If later user feedback says the wait was interrupted and should be skipped, follow that feedback without repeating the wait.',
      materials: 'inventory.txt is the authoritative local inventory.',
    });
  else {
    task = manager.list('acceptance', 'test-chat')[0];
    process.send({ kind: 'reopened', task });
    await manager.act(
      task.id,
      task.owner,
      task.chat,
      task.revision,
      'feedback',
      'The previous wait was interrupted. Skip the wait: do not run sleep again. inventory.txt has changed while the service was stopped. Read its current content and report its exact identifier and count. Do not edit anything.'
    );
    task = manager.get(task.id, task.owner, task.chat);
  }
  process.send({ kind: 'task', task });
  await manager.act(task.id, task.owner, task.chat, task.revision, 'resume');
  await manager.idle(task.id);
  process.send({ kind: 'finished', task: manager.get(task.id, task.owner, task.chat) });
} finally {
  manager.dispose();
  clearProviderCache();
  process.disconnect();
}
