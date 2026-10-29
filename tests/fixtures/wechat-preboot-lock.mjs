// Subprocess-only simulated boot. No live network or host clock changes.
import os from 'node:os';
const now = Date.now();
Date.now = () => now + 10_000;
os.uptime = () => 0;
globalThis.fetch = async () => { throw new Error('Live network forbidden in lock recovery fixture'); };
