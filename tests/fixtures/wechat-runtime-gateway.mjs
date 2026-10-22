// Keep installed-package long polls local and abortable; never contact Tencent.
import nock from 'nock';
nock.disableNetConnect();
nock.enableNetConnect('127.0.0.1');
nock('https://ilinkai.weixin.qq.com').persist().post('/ilink/bot/getupdates').reply((_uri, _body, _callback) => {});
// Startup session probe (#5479): healthy by default; WECHAT_FIXTURE_SESSION_EXPIRED
// flips it to -14. Health confirmation no longer waits for a long-poll answer.
nock('https://ilinkai.weixin.qq.com').persist().post('/ilink/bot/getconfig').query(true)
  .reply(200, process.env.WECHAT_FIXTURE_SESSION_EXPIRED ? { ret: -14, errmsg: 'session expired' } : { ret: 0 });
