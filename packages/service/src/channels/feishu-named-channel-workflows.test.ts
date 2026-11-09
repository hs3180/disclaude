/**
 * Named-channel workflow integration regression (T-083 rework round 5, #5254).
 *
 * Maintenance review https://github.com/hs3180/disclaude/pull/5700#issuecomment-6704189434
 * asked for more than plain-text reply coverage on named channels. These tests
 * drive the full channel stack (FeishuChannel + FeishuMessageHandler + the
 * real core command/control modules) for:
 *
 * - R1: private workflows — the host routes `feishu:<name>:oc_…` ids, the
 *   Feishu form callback round-trips the bare `open_chat_id`; the adapter
 *   unifies the boundary WITHOUT loosening the actor/card/nonce binding
 *   (the consumed command proves the real ActionBoundInput chain ran).
 * - R2: native agent-input cards — targets are converted at the platform
 *   adapter, direct-create never receives a prefixed id, and the host
 *   conversation context is preserved for answer continuation.
 * - R4: /trigger group modes — the control path and the inbound filter agree
 *   on one mode-map key space across always/mention/auto and restart.
 * - R5: private-input completion wakes the waiting session of the OWNING
 *   named channel (notifier installed per instance, routed back with the
 *   channel's own prefix).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from '@larksuiteoapi/node-sdk';
import {
  createControlHandler,
  type AgentInputRequest,
  type OutgoingMessage,
} from '@disclaude/core';
import { FeishuChannel, type FeishuChannelConfig } from './feishu-channel.js';
import { createTriggerModeAdapter } from './wired-descriptors.js';
import { installPrivateWorkflowNotifiers } from '../cli-main.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

type MessageHandlerSurface = {
  handleMessageReceive(data: unknown): Promise<void>;
  handleCardAction(data: unknown): Promise<unknown>;
  setControlHandler(hasHandler: boolean): void;
  initialize(client: import('@larksuiteoapi/node-sdk').Client): void;
};

/** Fresh ids per event: messageLogger dedup is process-wide, so a restarted
 * channel re-emitting the same synthetic message id would be dropped. */
let incomingSequence = 0;

/** Records both the persisted (routed) and API-boundary (bare) views. */
class RecordingFeishuChannel extends FeishuChannel {
  readonly sent: Array<{ id: string; message: OutgoingMessage }> = [];
  private sequence = 0;
  protected async doStart(): Promise<void> {
    /* test transport */
  }
  protected doSendMessage(message: OutgoingMessage): Promise<string> {
    const id = `om_${++this.sequence}`;
    this.sent.push({ id, message });
    return Promise.resolve(id);
  }
  protected checkHealth(): boolean {
    return true;
  }
  /** The API boundary sees the bare id (what Feishu would receive). */
  apiChatIds(): string[] {
    return this.sent.map(({ message }) => this.toApiChatId(message.chatId));
  }
  async emitIncoming(
    chatId: string,
    text: string,
    chatType: 'p2p' | 'group' | 'topic' = 'p2p'
  ): Promise<void> {
    await this.handler().handleMessageReceive({
      event: {
        message: {
          message_id: `om_incoming_${++incomingSequence}`,
          chat_id: chatId,
          chat_type: chatType,
          content: JSON.stringify({ text }),
          message_type: 'text',
          create_time: Date.now(),
          mentions: undefined,
          parent_id: undefined,
        },
        sender: { sender_type: 'user', sender_id: { open_id: 'ou_user' } },
      },
    });
  }
  handleCardAction(data: unknown): Promise<unknown> {
    return this.handler().handleCardAction(data);
  }
  /** Flip the message-handler's control flag after channel construction. */
  setControlAvailable(): void {
    this.handler().setControlHandler(true);
  }
  /** Inject a mock lark client (production wires a real one in doStart). */
  initializeClient(client: import('@larksuiteoapi/node-sdk').Client): void {
    this.handler().initialize(client);
  }
  private handler(): MessageHandlerSurface {
    return (
      this as unknown as { feishuMessageHandler: MessageHandlerSurface }
    ).feishuMessageHandler;
  }
}

function makeChannel(channelName: string): RecordingFeishuChannel {
  return new RecordingFeishuChannel({
    id: `feishu:${channelName}`,
    channelName,
    appId: `cli_${channelName}`,
    appSecret: `secret-${channelName}`,
  } satisfies FeishuChannelConfig);
}

/** Same consume-style workflow as private-workflows.test.ts: a real child
 * process writes the received value + audit context to a temp file. */
function workflowWritingTo(output: string) {
  return {
    title: 'Task chosen workflow',
    description: 'An agent-defined use',
    command: process.execPath,
    args: [
      '-e',
      "let v='';process.stdin.on('data',c=>v+=c);process.stdin.on('end',()=>require('fs').writeFileSync(process.argv[1],JSON.stringify({v,context:JSON.parse(process.env.DISCLAUDE_PRIVATE_CONTEXT)})))",
      output,
    ],
    env: {},
  };
}

function newOutputFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'named-channel-workflow-'));
  dirs.push(dir);
  return join(dir, 'consumed.json');
}

describe('named channel workflows (T-083 R1/R2/R4/R5)', () => {
  it('runs a private workflow on a named channel with unified ID boundaries and wakes its own session (R1+R5)', async () => {
    const work = makeChannel('work');
    const personal = makeChannel('personal');
    const woken: string[] = [];
    // R5 install point: every channel exposing the hook gets the router
    // signal callback; each instance re-prefixes with its own route.
    installPrivateWorkflowNotifiers([{}, work, personal], (chatId, message) => {
      woken.push(`${chatId}|${message}`);
      return Promise.resolve();
    });
    const output = newOutputFile();
    try {
      await Promise.all([work.start(), personal.start()]);
      const routedRequest = {
        chatId: 'feishu:work:oc_review',
        actorId: 'ou_actor',
        sourceMessageId: 'feishu:work:om_source',
        workflow: workflowWritingTo(output),
      };
      await work.requestPrivateWorkflow(routedRequest);

      // The card crossed the Feishu API boundary addressed to the BARE chat.
      const card = work.sent.find(({ message }) => message.type === 'card');
      expect(card).toBeDefined();
      expect(work.toApiChatId(card!.message.chatId)).toBe('oc_review');
      const cardBody = (card!.message as { card: Record<string, any> }).card;
      const issued = cardBody.body.elements[1].elements[1].behaviors[0]
        .value as Record<string, string>;
      expect(issued?.private_action).toBeTruthy();

      // The form callback arrives from Feishu with bare open ids and MUST be
      // accepted (R1) — the strict binding survived the boundary adaptation.
      await work.handleCardAction({
        operator: { open_id: 'ou_actor' },
        context: { open_chat_id: 'oc_review', open_message_id: card!.id },
        action: { value: issued, form_value: { credential: 'synthetic-private-value' } },
      });
      await vi.waitFor(() => expect(existsSync(output)).toBe(true));
      expect(JSON.parse(readFileSync(output, 'utf8'))).toMatchObject({
        v: 'synthetic-private-value',
        context: { actor: 'ou_actor', chat: 'oc_review', source: 'feishu:work:om_source' },
      });

      // R5: only the OWNING channel's session is woken, under its routed id.
      await vi.waitFor(() =>
        expect(woken).toEqual([
          expect.stringMatching(/^feishu:work:oc_review\|private input [0-9a-f-]+ succeeded$/),
        ])
      );
      // The caller's request object keeps the host-routed identity.
      expect(routedRequest.chatId).toBe('feishu:work:oc_review');
      // Nothing leaked into the sibling channel.
      expect(personal.sent).toEqual([]);
    } finally {
      await Promise.allSettled([work.stop(), personal.stop()]);
    }
  });

  it('rejects private-workflow and agent-input targets belonging to another channel (R1/R2 boundary)', async () => {
    const work = makeChannel('work');
    const create = vi.fn().mockResolvedValue({ code: 0, data: { message_id: 'om_c', chat_id: 'oc_x' } });
    try {
      await work.start();
      work.initializeClient({
        im: { message: { create, patch: vi.fn().mockResolvedValue({ code: 0 }) } },
      } as unknown as Client);
      await expect(
        work.requestPrivateWorkflow({
          chatId: 'feishu:personal:oc_x',
          actorId: 'ou_actor',
          sourceMessageId: 'om_source',
          workflow: workflowWritingTo(newOutputFile()),
        })
      ).rejects.toThrow('not a Feishu chat of channel feishu:work');
      await expect(
        work.requestAgentInput(
          {
            requestId: 'rpc-1',
            threadId: 't',
            turnId: 'turn',
            itemId: 'item',
            isBlocking: true,
            signal: new AbortController().signal,
            respond: vi.fn(),
            questions: [
              { id: 'q', header: '', question: 'pick', isOther: false, isSecret: false, options: [{ label: 'A', description: '' }] },
            ],
          },
          { chatId: 'feishu:personal:oc_x', actorId: 'ou_user', sourceMessageId: 'om_src' }
        )
      ).rejects.toThrow('not a Feishu chat of channel feishu:work');
      expect(work.sent).toEqual([]);
      expect(create).not.toHaveBeenCalled();
    } finally {
      await work.stop();
    }
  });

  it('delivers native agent-input cards to bare ids, direct-create included, keeping the host context (R2)', async () => {
    const work = makeChannel('work');
    const create = vi.fn().mockResolvedValue({ code: 0, data: { message_id: 'om_card', chat_id: 'oc_group' } });
    const respond = vi.fn().mockResolvedValue(undefined);
    try {
      await work.start();
      work.initializeClient({
        im: { message: { create, patch: vi.fn().mockResolvedValue({ code: 0 }) } },
      } as unknown as Client);
      const request: AgentInputRequest = {
        requestId: 'rpc-42',
        threadId: 't',
        turnId: 'turn-1',
        itemId: 'item-1',
        isBlocking: true,
        signal: new AbortController().signal,
        respond,
        questions: [
          {
            id: 'browser',
            header: 'Browser',
            question: 'Choose a browser',
            isOther: false,
            isSecret: false,
            options: [{ label: 'Chromium', description: '' }, { label: 'Chrome', description: '' }],
          },
        ],
      };
      // replyRootId null → the direct-create path the review flagged: the
      // receive_id sent to the Feishu API must be the bare chat id.
      const hostContext = {
        chatId: 'feishu:work:oc_group',
        actorId: 'ou_user',
        sourceMessageId: 'feishu:work:om_src',
        replyRootId: null,
      };
      await work.requestAgentInput(request, hostContext);

      expect(create).toHaveBeenCalledTimes(1);
      expect(create.mock.calls[0][0]).toMatchObject({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: 'oc_group' },
      });
      // The host context object is untouched — answer continuation keeps the
      // originating conversation identity.
      expect(hostContext.chatId).toBe('feishu:work:oc_group');

      const card = JSON.parse(create.mock.calls[0][0].data.content);
      const form = card.body.elements.find((element: { tag: string }) => element.tag === 'form');
      const token = form.elements.at(-1).name.slice('agent-input:'.length);
      await work.handleCardAction({
        operator: { open_id: 'ou_user' },
        context: { open_chat_id: 'oc_group', open_message_id: 'om_card' },
        action: { name: `agent-input:${token}`, form_value: { choice_0: '0' } },
      });
      await vi.waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
      expect(respond.mock.calls[0][0]).toEqual({
        browser: { answers: ['Chromium'] },
      });
    } finally {
      await work.stop();
    }
  });

  it('keeps /trigger receipts and group filtering consistent across always/mention/auto and restart (R4)', async () => {
    const work = makeChannel('work');
    const routed: string[] = [];
    work.onMessage((message) => {
      routed.push(message.chatId);
      return Promise.resolve();
    });
    // Real core control handler + the wired-descriptors adapter: the slash
    // command's emitControl path arrives with the channel's routed id, the
    // inbound filter reads bare event ids — the adapter normalizes both.
    work.onControl(
      createControlHandler({
        agentPool: { reset: () => undefined, stop: () => false },
        debugGroups: {
          getDebugGroup: () => null,
          setDebugGroup: () => undefined,
          clearDebugGroup: () => null,
        },
        triggerMode: createTriggerModeAdapter(work, work.getTriggerModeManager()),
      })
    );
    work.setControlAvailable();
    try {
      await work.start();

      // 'always': receipt claims all-message mode and the filter must agree.
      await work.emitIncoming('oc_g', '/trigger always', 'group');
      await work.emitIncoming('oc_g', 'hello without mention', 'group');
      expect(routed).toEqual(['feishu:work:oc_g']);

      // 'mention': un-mentioned group messages are filtered again.
      await work.emitIncoming('oc_g', '/trigger mention', 'group');
      await work.emitIncoming('oc_g', 'still no mention', 'group');
      expect(routed).toEqual(['feishu:work:oc_g']);

      // 'auto': a non-small group stays mention-only.
      await work.emitIncoming('oc_g', '/trigger auto', 'group');
      await work.emitIncoming('oc_g', 'auto still filters', 'group');
      expect(routed).toEqual(['feishu:work:oc_g']);

      // Restart recovery: records keyed with the bare platform chat id (what
      // initFromRecords loads) still drive the same filter decision.
      await work.stop();
      const restarted = makeChannel('work');
      restarted.onMessage((message) => {
        routed.push(message.chatId);
        return Promise.resolve();
      });
      await restarted.start();
      restarted
        .getTriggerModeManager()
        .initFromRecords([{ chatId: 'oc_g', triggerMode: 'always' }]);
      await restarted.emitIncoming('oc_g', 'after restart', 'group');
      expect(routed).toEqual(['feishu:work:oc_g', 'feishu:work:oc_g']);
      await restarted.stop();
    } finally {
      await work.stop();
    }
  });
});
