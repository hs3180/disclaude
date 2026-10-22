// Offline child-process fixture, never a replacement for real WeChat acceptance.
import nock from 'nock';
nock.disableNetConnect();
const bot = process.env.WECHAT_FIXTURE_BOT ?? 'fixture-bot';
nock('https://ilinkai.weixin.qq.com').post('/ilink/bot/get_bot_qrcode').query(true)
  .reply(200, { qrcode: 'offline-qr-id', qrcode_img_content: 'https://example.test/offline-qr' });
nock('https://ilinkai.weixin.qq.com').get('/ilink/bot/get_qrcode_status').query(true)
  .reply(200, process.env.WECHAT_FIXTURE_FAILURE ? { status: 'verify_code_blocked' } : {
    status: 'confirmed', ilink_bot_id: bot, ilink_user_id: 'fixture-user@im.wechat', bot_token: 'fixture-private-token', baseurl: 'https://ilinkai.weixin.qq.com',
  });
// Read-only session probe (#5479): healthy by default, or -14 login-expired.
nock('https://ilinkai.weixin.qq.com').post('/ilink/bot/getconfig').query(true)
  .reply(200, process.env.WECHAT_FIXTURE_SESSION_EXPIRED ? { ret: -14, errmsg: 'session expired' } : { ret: 0 });
