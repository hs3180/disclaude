import { initLogger, createLogger, closeLogger, flushLogger } from './packages/core/dist/index.js';

const mirror = process.env.SMOKE_MIRROR === '1';
await initLogger({ level: 'info', rotate: true, mirror });
const L = createLogger('smoke');
for (let i = 0; i < 3000; i++) {
  L.info({ i }, 'rotation smoke line number ' + i + ' '.repeat(80));
}
await new Promise((r) => setTimeout(r, 400));
await flushLogger();
await closeLogger();
console.log('DONE');