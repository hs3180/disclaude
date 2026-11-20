/**
 * r2 S5 — end-to-end send/receive for externally registered channel types
 * (#5745): register a mock channel type through the real ChannelTypeStore +
 * dynamic-import apply path, feed the resulting descriptors through the same
 * ChannelLifecycleManager wiring `disclaude start` uses, then push one inbound
 * message through the descriptor callback chain (handler → callbacks factory
 * → channel.send) and assert the reply. The isolation case pins the core
 * containment seam: a descriptor whose message handler throws at runtime is
 * caught by ChannelManager.setupHandlers per channel — the healthy external
 * channel keeps processing and both channels stay registered.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExtensionSection } from '@disclaude/core';
import { ChannelManager } from '../channel-manager.js';
import {
  ChannelLifecycleManager,
  type ChannelSetupContext,
  type WiredChannelDescriptor,
} from '../channel-lifecycle-manager.js';
import { applyChannelTypes } from './channel-type-apply.js';
import { ChannelTypeStore } from './channel-type-store.js';

interface FixtureModule {
  events: string[];
  inbound: { current: ((message: unknown) => Promise<void>) | null };
}

let configDir: string;
let extensionDir: string;

/**
 * Fixture descriptor source. The channel stub records everything it does into
 * module-level `events`; `inbound.current` captures the wrapper
 * ChannelManager.setupHandlers installs via onMessage, so the test can drive
 * the real wiring path exactly like a live channel would.
 */
function fixtureSource(type: string, throwing: boolean): string {
  const handlerBody = throwing
    ? `events.push('handler:' + message.text);
      throw new Error('boom from ${type}');`
    : `events.push('handler:' + message.text);
      wiredContext.callbacks(message.chatId);
      await channel.send('reply:' + message.text);`;
  return `
export const events = [];
export const inbound = { current: null };
export default {
  type: ${JSON.stringify(type)},
  name: 'Fixture ${type}',
  factory(config) {
    return {
      id: ${JSON.stringify(`${type}:main`)},
      name: 'Fixture ${type}',
      config,
      onMessage(fn) { inbound.current = fn; },
      onControl() {},
      async send(text) { events.push('send:' + text); },
      async start() {},
      async stop() {},
    };
  },
  createCallbacks() {
    return (chatId) => {
      events.push('callbacks:' + chatId);
      return {};
    };
  },
  createMessageHandler(channel, wiredContext) {
    return async (message) => {
      ${handlerBody}
    };
  },
};
`;
}

function registerFixture(type: string, source: string): string {
  const modulePath = join(extensionDir, `${type}.fixture.mjs`);
  writeFileSync(modulePath, source, 'utf8');
  ChannelTypeStore.forConfigDir(configDir).upsert({ type, modulePath });
  return modulePath;
}

async function loadFixture(modulePath: string): Promise<FixtureModule> {
  // Same specifier as applyChannelTypes uses → same module instance/state.
  return (await import(pathToFileURL(modulePath).href)) as FixtureModule;
}

function testContext(): ChannelSetupContext {
  return {
    agentPool: {
      getOrCreateChatAgent: () => ({}) as never,
      getPoolStats: () => ({}) as never,
    },
    controlHandler: (() => {}) as never,
    controlHandlerContext: {},
    logger: { info() {}, warn() {}, error() {}, debug() {} } as never,
    service: {} as never,
  } as ChannelSetupContext;
}

/** Applies the store and wires every resulting descriptor like cli-main does. */
async function wireStore(
  channelManager: ChannelManager
): Promise<ChannelLifecycleManager> {
  const registry = new ExtensionSection<WiredChannelDescriptor>('channelTypeE2E');
  const result = await applyChannelTypes(ChannelTypeStore.forConfigDir(configDir), {
    registry,
  });
  expect(result.failed).toEqual([]);
  const lifecycle = new ChannelLifecycleManager(channelManager, testContext());
  for (const descriptor of registry.descriptors()) {
    lifecycle.registerWiredDescriptor(descriptor);
  }
  return lifecycle;
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'channel-type-e2e-'));
  extensionDir = join(configDir, 'extensions');
  mkdirSync(extensionDir, { recursive: true });
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

describe('external channel type end-to-end (r2 S5)', () => {
  it('delivers one message through the descriptor callback chain', async () => {
    const modulePath = registerFixture('mock-e2e', fixtureSource('mock-e2e', false));
    const fixture = await loadFixture(modulePath);
    const channelManager = new ChannelManager();
    const lifecycle = await wireStore(channelManager);

    const channel = await lifecycle.createAndWireByType('mock-e2e', {
      type: 'mock-e2e',
    } as never);
    expect(channel.id).toBe('mock-e2e:main');
    expect(channelManager.has('mock-e2e:main')).toBe(true);
    expect(fixture.inbound.current).toBeTypeOf('function');

    // Inbound message: setupHandlers wrapper → descriptor message handler →
    // callbacks factory (agent-facing) → channel.send (outbound reply).
    await fixture.inbound.current!({ chatId: 'chat-1', messageId: 'm1', text: 'hello' });
    expect(fixture.events).toEqual([
      'handler:hello',
      'callbacks:chat-1',
      'send:reply:hello',
    ]);
  });

  it('contains a runtime-throwing handler without affecting the healthy channel', async () => {
    const healthyPath = registerFixture(
      'mock-healthy',
      fixtureSource('mock-healthy', false)
    );
    const throwingPath = registerFixture(
      'mock-throwing',
      fixtureSource('mock-throwing', true)
    );
    const healthy = await loadFixture(healthyPath);
    const throwing = await loadFixture(throwingPath);
    const channelManager = new ChannelManager();
    const lifecycle = await wireStore(channelManager);

    await lifecycle.createAndWireByType('mock-healthy', {
      type: 'mock-healthy',
    } as never);
    await lifecycle.createAndWireByType('mock-throwing', {
      type: 'mock-throwing',
    } as never);

    // The throwing descriptor's handler runs and fails mid-message; the
    // ChannelManager wrapper contains the error (logged, not propagated).
    await expect(
      throwing.inbound.current!({ chatId: 'chat-bad', messageId: 'm2', text: 'trigger' })
    ).resolves.toBeUndefined();
    expect(throwing.events).toEqual(['handler:trigger']);

    // The healthy external channel is untouched and still processes fully;
    // both channels remain registered with the core manager.
    await healthy.inbound.current!({ chatId: 'chat-good', messageId: 'm3', text: 'ok' });
    expect(healthy.events).toEqual(['handler:ok', 'callbacks:chat-good', 'send:reply:ok']);
    expect(channelManager.getIds().sort()).toEqual([
      'mock-healthy:main',
      'mock-throwing:main',
    ]);
  });
});
