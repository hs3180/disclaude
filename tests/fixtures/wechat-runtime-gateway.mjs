// Keep installed-package long polls local and abortable; never contact Tencent.
import nock from 'nock';
nock.disableNetConnect();
nock.enableNetConnect('127.0.0.1');
nock('https://ilinkai.weixin.qq.com').persist().post('/ilink/bot/getupdates').reply((_uri, _body, _callback) => {});
