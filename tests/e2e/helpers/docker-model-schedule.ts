import { expect } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';

type Inside = (code: string) => Promise<string>;
type Docker = (...args: string[]) => Promise<string>;

/** Real service watcher + wall-clock cron + model turn; never calls the scheduler directly. */
export async function verifyDockerModelSchedule(inside: Inside, docker: Docker,
  container: string, boot: string, priorBoot?: string): Promise<void> {
  const name = `model-${boot}`;
  const taskId = `schedule-${name}`;
  const marker = `scheduled-model-${boot}`;
  const target = `/data/workspace/${name}.json`;
  const directory = `/data/workspace/schedules/${name}`;
  const command = `node -e 'require("node:fs").writeFileSync(${JSON.stringify(target)}, JSON.stringify({marker:${JSON.stringify(marker)},boot:${JSON.stringify(boot)},uid:process.getuid()}))'`;
  const prompt = `Use your shell tool to execute exactly this command: ${command}\nThen reply with ${marker}. Do not create or modify schedules, inspect credentials, delegate work or modify unrelated files.`;
  // Calculate from the container's clock after readiness. A single calendar
  // instant avoids repeated paid model calls while the rest of the E2E runs.
  const written = JSON.parse(await inside(`import fs from 'node:fs';
const at = new Date(Date.now() + 30000);
const cron = [at.getUTCSeconds(),at.getUTCMinutes(),at.getUTCHours(),at.getUTCDate(),at.getUTCMonth()+1,'*'].join(' ');
const schedule = ['---','name: Container model schedule acceptance','cron: '+JSON.stringify(cron),'timezone: UTC',
'chatId: rest-${name}','enabled: true','blocking: true','freshSession: true','skipHistory: true','timeoutMs: 90000','---',${JSON.stringify(prompt)}].join('\\n');
fs.mkdirSync(${JSON.stringify(directory)},{recursive:true});
fs.writeFileSync(${JSON.stringify(`${directory}/SCHEDULE.md`)},schedule);
console.log(JSON.stringify({schedule,scheduledAt:at.toISOString()}));`)) as { schedule: string; scheduledAt: string };

  let completed = false;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const logs = await docker('logs', container);
    completed = logs.split('\n').some(line => line.includes(taskId)
      && line.includes('Scheduled task completed (agent turn finished)'));
    if (completed) { break; }
    const failed = logs.split('\n').find(line => line.includes(taskId)
      && (line.includes('Scheduled task failed') || line.includes('Scheduled task timed out')));
    if (failed) { throw new Error(`Model schedule ${taskId} did not complete successfully`); }
    await delay(1000);
  }
  expect(completed, `No completed cron model turn for ${taskId}`).toBe(true);
  const result = JSON.parse(await inside(`import fs from 'node:fs'; console.log(fs.readFileSync(${JSON.stringify(target)},'utf8'));`));
  expect(result).toEqual({ marker, boot, uid: 1001 });
  expect(await inside(`import fs from 'node:fs'; console.log(JSON.stringify(fs.readFileSync(${JSON.stringify(`${directory}/SCHEDULE.md`)},'utf8')));`))
    .toBe(JSON.stringify(written.schedule));
  if (priorBoot) {
    const prior = JSON.parse(await inside(`import fs from 'node:fs'; console.log(fs.readFileSync(${JSON.stringify(`/data/workspace/model-${priorBoot}.json`)},'utf8'));`));
    expect(prior).toEqual({ marker: `scheduled-model-${priorBoot}`, boot: priorBoot, uid: 1001 });
  }
  console.info('DOCKER_MODEL_SCHEDULE_ACCEPTANCE', JSON.stringify({ boot, taskId,
    scheduledAt: written.scheduledAt, actualCronModelTurn: true, independentArtifactReadback: true,
    priorResultRetained: Boolean(priorBoot), scheduleUnchanged: true, uid: 1001 }));
}
