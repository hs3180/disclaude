// Offline child-process fixture, never a replacement for real WeChat acceptance.
import nock from 'nock';
nock.disableNetConnect();
const bot = process.env.WECHAT_FIXTURE_BOT ?? 'fixture-bot';
const user = process.env.WECHAT_FIXTURE_USER ?? 'fixture-user@im.wechat';
nock('https://ilinkai.weixin.qq.com').post('/ilink/bot/get_bot_qrcode').query(true)
  .reply(200, { qrcode: 'offline-qr-id', qrcode_img_content: 'https://example.test/offline-qr' });
nock('https://ilinkai.weixin.qq.com').get('/ilink/bot/get_qrcode_status').query(true)
  // WECHAT_FIXTURE_HOLD_QR keeps the QR unscanned so a test can act while the
  // login (and its rollback window) is still open (#5479).
  .reply(200, process.env.WECHAT_FIXTURE_HOLD_QR ? { status: 'wait' } : process.env.WECHAT_FIXTURE_FAILURE ? { status: 'verify_code_blocked' } : {
    status: 'confirmed', ilink_bot_id: bot, ilink_user_id: user, bot_token: 'fixture-private-token', baseurl: 'https://ilinkai.weixin.qq.com',
  });
// Read-only session probe (#5479): healthy by default, or -14 login-expired.
nock('https://ilinkai.weixin.qq.com').post('/ilink/bot/getconfig').query(true)
  .reply(200, process.env.WECHAT_FIXTURE_SESSION_EXPIRED ? { ret: -14, errmsg: 'session expired' } : { ret: 0 });
