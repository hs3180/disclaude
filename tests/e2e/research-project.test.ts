import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { randomInt } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Config, setDefaultProvider, clearProviderCache } from '@disclaude/core';
import { FeishuResearchController } from '../../packages/service/src/research/feishu-controller.js';
import { createDocumentReader, createDocumentAppender } from '../../packages/service/src/research/document-source.js';
import * as lark from '@larksuiteoapi/node-sdk';
import nock from 'nock';

// dispose() requests cancellation synchronously; it does not join the harness.
// Only delete after a completed model run, or before any run was started.
async function cleanupResearchTest(root: string, controller: FeishuResearchController | undefined, mayBeRunning: boolean): Promise<void> {
  try { controller?.dispose(); clearProviderCache(); }
  catch (error) {
    console.error(`Research test files retained at ${root}: teardown failed; confirm all owned processes have stopped before removing.`);
    throw error;
  }
  if (mayBeRunning) {
    console.error(`Research test files retained at ${root}: model termination unconfirmed; confirm all owned processes have stopped before removing.`);
    return;
  }
  try { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
  catch (error) {
    throw new Error(`Research test cleanup failed; inspect residual files at ${root}`, { cause: error });
  }
}

// Real model/runner/project lifecycle; transport is captured, not sent to Feishu.
// This does not claim live Feishu rendering or interactive user acceptance.
describe('research project using supplied evidence and the configured model', () => {
  it.skipIf(process.env.DISCLAUDE_E2E_RESEARCH !== '1' || !process.env.DISCLAUDE_E2E_RESEARCH_DOCUMENT)('uses a real document body and tax correction comment in its retained conclusion', async () => {
    nock.enableNetConnect(host => /^(open\.feishu\.cn|localhost|127\.0\.0\.1)(:\d+)?$/u.test(host));
    setDefaultProvider(Config.AGENT_BACKEND);
    const root = await mkdtemp(join(tmpdir(), 'research-doc-e2e-'));
    let controller: FeishuResearchController | undefined;
    let mayBeRunning = false;
    try {
      const client = new lark.Client({ appId: process.env.FEISHU_APP_ID ?? '', appSecret: process.env.FEISHU_APP_SECRET ?? '',
        logger: { error() {}, warn() {}, info() {}, debug() {}, trace() {} } });
      controller = new FeishuResearchController(join(root, 'store'), root,
        () => Promise.resolve('captured-doc-card'), () => Promise.resolve(), undefined, createDocumentReader(client),
        process.env.DISCLAUDE_E2E_RESEARCH_EXPORT === '1' ? createDocumentAppender(client) : undefined);
      await controller.handle({ operator: { open_id: 'test-owner' }, context: { open_chat_id: 'test-chat', open_message_id: 'doc-form' }, action: {
        name: `research:${JSON.stringify({ action: 'create', nonce: 'doc-project' })}`,
        form_value: { question: 'Compare the actual total cost of proposals A and B.', scope: 'Use only the linked document and its comments. Include the tax correction. Return a short English conclusion with the two actual total costs.', document_url: process.env.DISCLAUDE_E2E_RESEARCH_DOCUMENT },
      } });
      const project = controller.manager.list('test-owner', 'test-chat')[0];
      expect(project).toBeDefined();
      mayBeRunning = true;
      await controller.manager.act(project.id, 'test-owner', 'test-chat', project.revision, 'resume');
      await controller.manager.idle(project.id);
      const finished = controller.manager.get(project.id, 'test-owner', 'test-chat');
      mayBeRunning = finished.status !== 'completed';
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
      await cleanupResearchTest(root, controller, mayBeRunning);
    }
  }, 240_000);
  it.skipIf(process.env.DISCLAUDE_E2E_RESEARCH !== '1')('reads the original project files after a directory switch and retains findings after restart', async () => {
    // Match the backend initialization performed by DisclaudeService.start().
    setDefaultProvider(Config.AGENT_BACKEND);
    const root = await mkdtemp(join(tmpdir(), 'research-e2e-'));
    const originalDir = join(root, 'original-project'), otherDir = join(root, 'other-project');
    const priceA = randomInt(100, 800), priceB = priceA + 7;
    let currentDir = originalDir;
    let cards = 0;
    let mayBeRunning = false;
    let controller: FeishuResearchController | undefined;
    try {
      controller = new FeishuResearchController(join(root, 'store'), root,
        () => Promise.resolve(`captured-card-${++cards}`), () => Promise.resolve(), undefined, undefined, undefined, () => Promise.resolve(currentDir));
      await mkdir(originalDir); await mkdir(otherDir);
      await writeFile(join(originalDir, 'proposals.txt'), `Fictional acceptance evidence. Proposal A: total price USD ${priceA}. Proposal B: total price USD ${priceB}. Both cover exactly the same deliverables.\n`);
      await writeFile(join(otherDir, 'proposals.txt'), 'Unrelated project. Proposal A: USD 9000. Proposal B: USD 1000.\n');
      await controller.handle({ operator: { open_id: 'test-owner' }, context: { open_chat_id: 'test-chat', open_message_id: 'test-form' }, action: {
        value: { research: true, action: 'create', nonce: 'one-project' },
        form_value: { question: 'Which supplied proposal costs less?', scope: 'Read only proposals.txt in the current working directory during investigation. Investigate one direction: price comparison. No external sources or other files. Return a short English conclusion stating both exact USD totals and the absolute difference.', materials: 'The authoritative proposal prices are in proposals.txt in this project. Read the file; do not infer prices.' },
      } });
      const project = controller.manager.list('test-owner', 'test-chat')[0];
      expect(project).toBeDefined();
      expect(project.workingDir).toBe(originalDir);
      currentDir = otherDir; // Subsequent chat binding changes must not relocate this research.
      await controller.handle({ operator: { open_id: 'test-owner' }, context: { open_chat_id: 'test-chat', open_message_id: project.cardId }, action: {
        value: { research: true, action: 'feedback', project: project.id, revision: project.revision },
        form_value: { feedback: 'Include the absolute savings in USD in the price comparison.' },
      } });
      const adjusted = controller.manager.get(project.id, 'test-owner', 'test-chat');
      mayBeRunning = true;
      await controller.handle({ operator: { open_id: 'test-owner' }, context: { open_chat_id: 'test-chat', open_message_id: project.cardId }, action: {
        value: { research: true, action: 'resume', project: project.id, revision: adjusted.revision },
      } });
      await controller.manager.idle(project.id);
      const finished = controller.manager.get(project.id, 'test-owner', 'test-chat');
      mayBeRunning = finished.status !== 'completed';
      expect(finished.status, finished.error).toBe('completed');
      expect(finished.directions.some(direction => direction.findings.some(finding => finding.sources.length > 0))).toBe(true);
      expect(finished.summary).toMatch(/proposal\s*a|\bA\b/i);
      expect(finished.summary).toContain(String(priceA));
      expect(finished.summary).toContain(String(priceB));
      expect(finished.summary).toMatch(/\b7\b/u);
      expect(finished.summary).not.toMatch(/9000|1000/u);
      expect(finished.workingDir).toBe(originalDir);
      console.info('PROJECT_DIRECTORY_RESEARCH_CONCLUSION', finished.summary);
      expect(finished.feedback[0]).toMatchObject({ status: 'applied', reason: expect.any(String) });
      expect(finished.feedback[0].directionIds?.some(id => finished.directions.some(d => d.id === id && d.findings.length > 0))).toBe(true);
      controller.dispose();
      const reopened = new FeishuResearchController(join(root, 'store'), otherDir, () => Promise.resolve('reopened-card'), () => Promise.resolve(), undefined, undefined, undefined, () => Promise.resolve(currentDir));
      try {
        const retained = reopened.manager.get(project.id, 'test-owner', 'test-chat');
        expect(retained.summary).toBe(finished.summary);
        expect(retained.workingDir).toBe(originalDir);
        expect(retained.directions).toEqual(finished.directions);
      }
      finally { reopened.dispose(); }
    } finally {
      await cleanupResearchTest(root, controller, mayBeRunning);
    }
  }, 240_000);
});
