import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Config, setDefaultProvider, clearProviderCache } from '@disclaude/core';
import { FeishuResearchController } from '../../packages/service/src/research/feishu-controller.js';

// Real model/runner/project lifecycle; transport is captured, not sent to Feishu.
// This does not claim live Feishu rendering or interactive user acceptance.
describe('research project using supplied evidence and the configured model', () => {
  it.skipIf(process.env.DISCLAUDE_E2E_RESEARCH !== '1')('continues from a project form to retained findings without more chat turns', async () => {
    // Match the backend initialization performed by DisclaudeService.start().
    setDefaultProvider(Config.AGENT_BACKEND);
    const root = await mkdtemp(join(tmpdir(), 'research-e2e-'));
    let cards = 0;
    const controller = new FeishuResearchController(join(root, 'store'), root,
      () => Promise.resolve(`captured-card-${++cards}`), () => Promise.resolve());
    try {
      await controller.handle({ operator: { open_id: 'test-owner' }, context: { open_chat_id: 'test-chat', open_message_id: 'test-form' }, action: {
        value: { research: true, action: 'create', nonce: 'one-project' },
        form_value: { question: 'Which supplied proposal costs less?', scope: 'Use only the supplied material. Investigate one direction: price comparison. Do not use external sources or tools. Return a short English conclusion.', materials: 'Proposal A: total price USD 10. Proposal B: total price USD 12. Both cover exactly the same deliverables.' },
      } });
      const project = controller.manager.list('test-owner', 'test-chat')[0];
      expect(project).toBeDefined();
      await controller.handle({ operator: { open_id: 'test-owner' }, context: { open_chat_id: 'test-chat', open_message_id: project.cardId }, action: {
        value: { research: true, action: 'resume', project: project.id, revision: project.revision },
      } });
      await controller.manager.idle(project.id);
      const finished = controller.manager.get(project.id, 'test-owner', 'test-chat');
      expect(finished.status, finished.error).toBe('completed');
      expect(finished.directions.some(direction => direction.findings.some(finding => finding.sources.length > 0))).toBe(true);
      expect(finished.summary).toMatch(/proposal\s*a|\bA\b/i);
      controller.dispose();
      const reopened = new FeishuResearchController(join(root, 'store'), root, () => Promise.resolve('reopened-card'), () => Promise.resolve());
      try { expect(reopened.manager.get(project.id, 'test-owner', 'test-chat').summary).toBe(finished.summary); }
      finally { reopened.dispose(); }
    } finally { controller.dispose(); clearProviderCache(); await rm(root, { recursive: true, force: true }); }
  }, 240_000);
});
