/**
 * Tests for the delivery-position echo contract shared by the send_* tools.
 *
 * Issue #5722: a send without --parent in a Feishu topic group starts a NEW
 * topic while the old success message was byte-identical to an in-topic reply.
 * Every send_* success message now echoes the position in one channel-agnostic
 * form: "— thread reply to <parent>" / "— chat root", plus a warning when no
 * --parent was passed.
 */

import { describe, it, expect } from 'vitest';
import { resolveDeliveryPosition, PARENT_OMITTED_TOPIC_WARNING } from './delivery-position.js';

describe('resolveDeliveryPosition (#5722)', () => {
  it('derives thread-reply from the --parent request when the server reports no position', () => {
    const echo = resolveDeliveryPosition({ parentMessageId: 'om_parent' });
    expect(echo.deliveryPosition).toBe('thread-reply');
    expect(echo.threadId).toBe('om_parent');
    expect(echo.suffix).toBe('— thread reply to om_parent');
    expect(echo.parentOmitted).toBe(false);
  });

  it('prefers the server-confirmed position and threadId over the local derivation', () => {
    const echo = resolveDeliveryPosition({
      parentMessageId: 'om_parent',
      deliveryPosition: 'thread-reply',
      threadId: 'om_confirmed_parent',
      messageId: 'om_new',
    });
    expect(echo.deliveryPosition).toBe('thread-reply');
    expect(echo.threadId).toBe('om_confirmed_parent');
    expect(echo.suffix).toBe('— thread reply to om_confirmed_parent (messageId om_new)');
  });

  it('appends the topic-group warning when no --parent was passed (chat root)', () => {
    const echo = resolveDeliveryPosition({
      deliveryPosition: 'chat-root',
      messageId: 'om_new_topic_root',
    });
    expect(echo.deliveryPosition).toBe('chat-root');
    expect(echo.parentOmitted).toBe(true);
    expect(echo.suffix).toBe(
      `— chat root (messageId om_new_topic_root) ${PARENT_OMITTED_TOPIC_WARNING}`
    );
  });

  it('omits the messageId fragment when it equals the replied-under parent', () => {
    const echo = resolveDeliveryPosition({ parentMessageId: 'om_parent', messageId: 'om_parent' });
    expect(echo.suffix).toBe('— thread reply to om_parent');
  });

  it('omits ids entirely when none are known', () => {
    const echo = resolveDeliveryPosition({});
    expect(echo.deliveryPosition).toBe('chat-root');
    expect(echo.suffix).toBe(`— chat root ${PARENT_OMITTED_TOPIC_WARNING}`);
  });
});
