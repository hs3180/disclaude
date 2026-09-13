// Offline release check: only loopback HTTP and a local delivery sink; no live channel writes.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
assert(process.argv[2], 'Pass the installed prebuilt disclaude package directory');
const installed = resolve(process.argv[2]);
const temp = mkdtempSync(join(tmpdir(), 'disclaude-scheduled-channel-'));
process.chdir(temp);
process.env.DISCLAUDE_CONFIG_PATH = join(temp, 'config.json');
writeFileSync(process.env.DISCLAUDE_CONFIG_PATH, JSON.stringify({agent:{agentBackend:'claude'},workspace:{dir:temp},logging:{level:'silent'}}));
const load = (name, file='index.js') => import(pathToFileURL(join(installed,'packages',name,'dist',file)).href);
const { Scheduler } = await load('core');
const { HttpApiServer } = await load('service','http-api-server.js');
const { publishChannelApiEnvironment } = await load('service','cli-main.js');
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const task = {id:'installed-channel-env',name:'Installed channel environment',cron:'* * * * *',chatId:'rest-lab',enabled:true,createdAt:new Date().toISOString(),timeoutMs:10000,
 command:[process.execPath,join(installed,'bin/disclaude.js'),'channel','send_text','--chat','rest-lab','--text','packaged schedule'].map(quote).join(' ')};
const notices=[];
const scheduler = new Scheduler({scheduleManager:{get:async()=>task},callbacks:{sendMessage:async(...args)=>notices.push(args),resetAgent:()=>{}},
 jobFactory:(_cron,onTick)=>({start(){},stop(){},fireOnTick:onTick})});
const servers=[];
try {
 scheduler.addTask(task);
 let previousPort;
 for(const [mode,token] of [['authenticated','synthetic-lab-token'],['unauthenticated',undefined]]) {
  const server=new HttpApiServer({port:0,host:'127.0.0.1',apiToken:token});servers.push(server);
  const deliveries=[];const headers=[];
  server.setSendMessageHandler(async(chat,text)=>{deliveries.push({chat,text});return {success:true,messageId:'om_lab'};});
  await server.start();
  server.server.on('request',req=>{if(req.url==='/api/send-message')headers.push(req.headers.authorization);});
  const {port}=server.getAddress();
  assert.notEqual(port,previousPort);previousPort=port;
  const base=`http://127.0.0.1:${port}`;
  publishChannelApiEnvironment(base,token);
  assert.equal(process.env.DISCLAUDE_API_TOKEN,token);
  if(token){const denied=await fetch(`${base}/api/send-message`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chatId:'rest-lab',text:'denied'})});assert.equal(denied.status,401);headers.length=0;}
  void scheduler.getActiveJobs()[0].job.fireOnTick();
  const deadline=Date.now()+12000;
  while((scheduler.isTaskRunning(task.id)||deliveries.length===0)&&Date.now()<deadline)await delay(20);
  assert.equal(scheduler.isTaskRunning(task.id),false);
  assert.deepEqual(deliveries,[{chat:'rest-lab',text:'packaged schedule'}],JSON.stringify(notices));
  assert.deepEqual(headers,[token?`Bearer ${token}`:undefined]);
  assert.equal(notices.length, mode==='authenticated'?1:2);
  assert(notices.every(([,text])=>text.includes('开始执行命令')));
  console.log(`SCHEDULED_INSTALLED_CHANNEL_OK mode=${mode} dynamicPort=${port}`);
  // Keep the first server alive until the second binds, proving per-tick address replacement.
 }
 console.log('SCHEDULED_INSTALLED_CHANNEL_MATRIX_OK');
} finally {await scheduler.stop();for(const server of servers)await server.stop();rmSync(temp,{recursive:true,force:true});}
