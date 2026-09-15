import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Config, setDefaultProvider, clearProviderCache } from '@disclaude/core';
import { FeishuResearchController } from '../../packages/service/src/research/feishu-controller.js';
import { createDocumentReader, createDocumentAppender } from '../../packages/service/src/research/document-source.js';
import * as lark from '@larksuiteoapi/node-sdk';
import nock from 'nock';

// Real model/runner/project lifecycle; transport is captured, not sent to Feishu.
// This does not claim live Feishu rendering or interactive user acceptance.
describe('research project using supplied evidence and the configured model', () => {
  it.skipIf(process.env.DISCLAUDE_E2E_RESEARCH !== '1' || !process.env.DISCLAUDE_E2E_RESEARCH_DOCUMENT)('uses a real document body and tax correction comment in its retained conclusion', async () => {
    nock.enableNetConnect(host => /^(open\.feishu\.cn|localhost|127\.0\.0\.1)(:\d+)?$/u.test(host));
    setDefaultProvider(Config.AGENT_BACKEND);
    const root = await mkdtemp(join(tmpdir(), 'research-doc-e2e-'));
    const client = new lark.Client({ appId: process.env.FEISHU_APP_ID ?? '', appSecret: process.env.FEISHU_APP_SECRET ?? '',
      logger: { error() {}, warn() {}, info() {}, debug() {}, trace() {} } });
    const controller = new FeishuResearchController(join(root, 'store'), root,
      () => Promise.resolve('captured-doc-card'), () => Promise.resolve(), undefined, createDocumentReader(client),
      process.env.DISCLAUDE_E2E_RESEARCH_EXPORT === '1' ? createDocumentAppender(client) : undefined);
    try {
      await controller.handle({ operator: { open_id: 'test-owner' }, context: { open_chat_id: 'test-chat', open_message_id: 'doc-form' }, action: {
        name: `research:${JSON.stringify({ action: 'create', nonce: 'doc-project' })}`,
        form_value: { question: 'Compare the actual total cost of proposals A and B.', scope: 'Use only the linked document and its comments. Include the tax correction. Return a short English conclusion with the two actual total costs.', document_url: process.env.DISCLAUDE_E2E_RESEARCH_DOCUMENT },
      } });
      const project = controller.manager.list('test-owner', 'test-chat')[0];
      expect(project).toBeDefined();
      await controller.manager.act(project.id, 'test-owner', 'test-chat', project.revision, 'resume');
      await controller.manager.idle(project.id);
      const finished = controller.manager.get(project.id, 'test-owner', 'test-chat');
      expect(finished.status, finished.document?.error ?? finished.error).toBe('completed');
      expect(finished.document?.snapshot?.comments.some(c => c.text.includes('5'))).toBe(true);
      expect(finished.feedback.some(f => f.sourceKey?.includes(':comment:') && f.status === 'applied')).toBe(true);
      expect(finished.summary).toContain('15');
      expect(finished.summary).toContain('12');
      expect(finished.summary).toMatch(/\bB\b/u);
      console.info('DOCUMENT_RESEARCH_CONCLUSION', finished.summary);
      if (process.env.DISCLAUDE_E2E_RESEARCH_EXPORT === '1') {
        await controller.handle({ operator: { open_id: 'test-owner' }, context: { open_chat_id: 'test-chat', open_message_id: finished.cardId },
          action: { value: { research: true, action: 'export', project: finished.id, revision: finished.revision } } });
        let exported = controller.manager.get(project.id, 'test-owner', 'test-chat');
        // An ambiguous response is reconciled by reading only; never replay the append.
        if (exported.document?.export?.status === 'unknown') {
          await controller.manager.act(project.id, 'test-owner', 'test-chat', exported.revision, 'export');
          exported = controller.manager.get(project.id, 'test-owner', 'test-chat');
        }
        expect(exported.document?.export?.status, exported.document?.export?.error ?? exported.history.at(-1)?.text).toBe('saved');
        expect(exported.summary).toBe(finished.summary);
        expect(exported.document?.snapshot?.body).toBe(finished.document?.snapshot?.body);
        const fragment = exported.document?.export?.fragment ?? '';
        expect(fragment.replace(/\s/gu, '')).toContain(finished.summary.replace(/\s/gu, ''));
        expect(exported.document?.snapshot?.rawBody?.split(fragment)).toHaveLength(2);
      }
    } finally {
      nock.enableNetConnect(host => /^(localhost|127\.0\.0\.1)(:\d+)?$/u.test(host));
      controller.dispose(); clearProviderCache(); await rm(root, { recursive: true, force: true });
    }
  }, 240_000);
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
        value: { research: true, action: 'feedback', project: project.id, revision: project.revision },
        form_value: { feedback: 'Include the absolute savings in USD in the price comparison.' },
      } });
      const adjusted = controller.manager.get(project.id, 'test-owner', 'test-chat');
      await controller.handle({ operator: { open_id: 'test-owner' }, context: { open_chat_id: 'test-chat', open_message_id: project.cardId }, action: {
        value: { research: true, action: 'resume', project: project.id, revision: adjusted.revision },
      } });
      await controller.manager.idle(project.id);
      const finished = controller.manager.get(project.id, 'test-owner', 'test-chat');
      expect(finished.status, finished.error).toBe('completed');
      expect(finished.directions.some(direction => direction.findings.some(finding => finding.sources.length > 0))).toBe(true);
      expect(finished.summary).toMatch(/proposal\s*a|\bA\b/i);
      expect(finished.feedback[0]).toMatchObject({ status: 'applied', reason: expect.any(String) });
      expect(finished.feedback[0].directionIds?.some(id => finished.directions.some(d => d.id === id && d.findings.length > 0))).toBe(true);
      controller.dispose();
      const reopened = new FeishuResearchController(join(root, 'store'), root, () => Promise.resolve('reopened-card'), () => Promise.resolve());
      try { expect(reopened.manager.get(project.id, 'test-owner', 'test-chat').summary).toBe(finished.summary); }
      finally { reopened.dispose(); }
    } finally { controller.dispose(); clearProviderCache(); await rm(root, { recursive: true, force: true }); }
  }, 240_000);
});
