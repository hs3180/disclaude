import { describe, expect, it } from 'vitest';
import { channelError } from './channel-error.js';
import { WeChatApiError } from './channels/wechat/api-client.js';

/**
 * #5616: a WeChat delivery failure must expose safe structured diagnostics
 * (endpoint, Tencent HTTP status, ret/errmsg, both diagnostic IDs, session
 * state, errorKind) in the REST failure body instead of burying them in the
 * message string. Unknown rejection causes are never guessed.
 */
describe('channelError WeChat delivery diagnostics (#5616)', () => {
  // The exact framing WeChatChannel.describeDeliveryFailure produces.
  const wrap = (cause: WeChatApiError, message: string) => new Error(message, { cause });

  it('classifies an explicit server rejection (prepare failed) with both diagnostic IDs', () => {
    const error = wrap(
      new WeChatApiError(-2, { endpoint: '/ilink/bot/sendmessage', httpStatus: 200, ret: -2, errmsg: 'prepare failed', diagnosticId: 'ab12cd34' }),
      'WeChat message NOT sent: the server rejected delivery (code -2, server said: prepare failed). The account check may still pass — this is a delivery rejection, not a confirmed login or configuration failure. [diag ab12cd34]',
    );
    const { body } = channelError(error);
    expect(body.diagnostics).toEqual({
      channel: 'wechat',
      errorKind: 'delivery-rejected',
      sessionState: 'unverified',
      endpoint: '/ilink/bot/sendmessage',
      httpStatus: 200,
      ret: -2,
      errmsg: 'prepare failed',
      channelDiagnosticId: 'ab12cd34',
    });
    // Host-layer ID stays alongside; the string contract is unchanged.
    expect(body.diagnosticId).toBeTruthy();
    expect(body.message).toContain('(diagnostic ID ');
    expect(body.message).toContain('prepare failed');
  });

  it('classifies a credential rejection as login-expired, not a delivery rejection', () => {
    const error = wrap(
      new WeChatApiError(-14, { endpoint: '/ilink/bot/sendmessage', httpStatus: 401, ret: -14, diagnosticId: 'ff001122' }),
      "WeChat message NOT sent: this account's login expired.",
    );
    const { body } = channelError(error);
    expect(body.diagnostics).toMatchObject({
      channel: 'wechat', errorKind: 'login-expired', sessionState: 'login-expired',
      httpStatus: 401, ret: -14, channelDiagnosticId: 'ff001122',
    });
    expect(body.diagnostics?.errmsg).toBeUndefined();
  });

  it('classifies timeout/network failures as delivery-outcome-unknown without inventing a rejection', () => {
    // api-client.postMessage's fixed literal when no WeChatApiError came back.
    const { body } = channelError(new Error('WeChat delivery outcome unknown after timeout, network or response failure; verify in WeChat before retrying'));
    expect(body.diagnostics).toEqual({ channel: 'wechat', errorKind: 'delivery-outcome-unknown', sessionState: 'unverified' });
  });

  it('drops unsafe errmsg values and leaves non-WeChat failures untouched', () => {
    const unsafe = wrap(
      new WeChatApiError(-2, { endpoint: '/ilink/bot/sendmessage', ret: -2, errmsg: 'token https://evil.example/x', diagnosticId: 'ab12cd34' }),
      'WeChat message NOT sent: the server rejected delivery (code -2)',
    );
    expect(channelError(unsafe).body.diagnostics?.errmsg).toBeUndefined();
    // A Feishu-shaped failure keeps the previous body shape exactly.
    const feishu = new Error('feishu send failed');
    expect(channelError(feishu).body.diagnostics).toBeUndefined();
    expect(channelError(feishu).body.message).toContain('feishu send failed');
  });
});
