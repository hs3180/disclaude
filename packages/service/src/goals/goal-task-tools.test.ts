import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const repo = fileURLToPath(new URL('../../../../', import.meta.url));
it.each(['complete', 'denied', 'changed', 'close-delivery', 'capacity'])(
  'executes a scoped Goal child through %s', scenario => {
    const root = mkdtempSync(join(tmpdir(), 'disclaude-goal-child-'));
    try {
      const config = join(root, 'config.json');
      writeFileSync(config, JSON.stringify({ workspace: { dir: root },
        agents: { default: { backend: 'claude', llm: 'default' } },
        llms: { default: { model: 'offline-default', api: { protocol: 'anthropic', apiKey: '$TEST_LLM_DEFAULT_KEY' } } },
      }));
      const script = `
        import assert from 'node:assert/strict';
        import { realpathSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
        import { join } from 'node:path';
        import { GoalStore, ProjectManager, getProvider } from './packages/core/dist/index.js';
        import { prepareTools } from './packages/core/dist/sdk/tools.js';
        import { GoalExecutionService } from './packages/service/dist/goals/goal-execution-service.js';
        import { createGoalTaskTurnTools } from './packages/service/dist/goals/goal-task-tools.js';
        globalThis.fetch = async () => { throw new Error('Live fetch forbidden'); };
        const scenario=${JSON.stringify(scenario)},root=realpathSync(${JSON.stringify(root)}),project=join(root,'project');mkdirSync(project);
        const gate=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return{promise,resolve}};
        const sending=gate(),delivery=gate(),notified=gate();
        const store=new GoalStore(join(root,'goals')),manager=new ProjectManager({workspaceDir:root});manager.use('chat',project);
        let allowed=true,id,closed=0,hooks=0;const calls=[],sends=[];
        const callbacks={sendMessage:async(chat,text,topic)=>{
          sends.push({chat,text,topic});
          if(text==='child result'&&scenario==='close-delivery'){sending.resolve();await delivery.promise;}
          if(text.startsWith('Goal '))notified.resolve();return 'local-receipt';
        },sendFile:async()=>{},sendCard:async()=>{}};
        getProvider('claude').queryStream=(input,options)=>{
          const parked=gate(),child=calls.length>0;calls.push(options);
          return{handle:{close:()=>{closed++;parked.resolve()},cancel:()=>{}},iterator:(async function*(){
            const actual=(await input.next()).value;assert.equal(options.model,'selected-offline');assert.equal(options.cwd,project);
            assert.equal(actual.inputContext.actorId,'actor');assert.equal(actual.inputContext.sourceMessageId,'start');
            assert.equal(options.onAsyncUserInputAnswer,undefined);
            if(child){
              assert.equal(options.capacityAdmission,'reject');
              assert.ok(!prepareTools(options.tools).some(t=>t.name==='goal_report'||t.name==='run_agent_task'));
              if(scenario==='capacity')throw new Error('offline capacity exhausted; no waiting');
              writeFileSync(join(project,'child.txt'),'verified child\\n');
              if(scenario==='changed'){const latest=await store.get(id);await store.update(id,latest.revision,{progress:'New user feedback'});}
              yield{type:'text',role:'assistant',content:'child result'};
            }else{
              const tools=prepareTools(options.tools),task=tools.find(t=>t.name==='run_agent_task');assert.ok(task);
              const args={operationId:'one_child',task:'Write and verify child.txt',workingDirectory:'.'};
              const context={signal:new AbortController().signal};
              if(scenario==='denied'){
                allowed=false;await assert.rejects(task.execute(args,context),/authorized/);allowed=true;assert.equal(calls.length,1);
              }else if(scenario==='changed')await assert.rejects(task.execute(args,context),/changed/);
              else{
                const first=await task.execute(args,context);
                if(scenario==='close-delivery')return;
                assert.equal(first.outcome,scenario==='capacity'?'failed':'succeeded');
                assert.deepEqual(await task.execute(args,context),first);assert.equal(calls.length,2);
                if(scenario==='complete')assert.equal(readFileSync(join(project,'child.txt'),'utf8'),'verified child\\n');
              }
              if(scenario!=='changed')await tools.find(t=>t.name==='goal_report').execute({
                outcome:scenario==='complete'?'completed':'blocked',progress:'Inspected actual subtask result',
                artifacts:scenario==='complete'?['child.txt']:[],checks:scenario==='complete'?[{criterion:0,satisfied:true,evidence:['child.txt']}]:[]
              },context);
              yield{type:'text',role:'assistant',content:'parent result'};
            }
            yield{type:'result',content:'',metadata:{stopReason:'end_turn'}};await parked.promise;
          })()};
        };
        const service=new GoalExecutionService({store,projectManager:manager,isCommandAllowed:()=>allowed,
          runtimeOptions:()=>({model:'selected-offline',configureQueryOptions:options=>{hooks++;return options}}),
          callbacks:()=>callbacks,createTurnTools:createGoalTaskTurnTools});
        try{
          const created=await store.create({chatId:'chat',projectRoot:project,objective:'Delegate the explicit task',acceptance:['Verify child.txt']});id=created.id;
          const {handle}=await service.start({goalId:id,expectedRevision:created.revision,chatId:'chat',actorId:'actor',sourceMessageId:'start',projectRoot:project,threadRootId:'topic',chatType:'topic'},'activate');
          if(scenario==='close-delivery'){
            await sending.promise;let finished=false;const closing=service.close().then(()=>{finished=true});
            for(let i=0;i<5;i++)await new Promise(r=>setImmediate(r));
            assert.equal(finished,false);assert.equal(service.isBusy('chat'),true);delivery.resolve();await closing;
          }else{await handle.completion;await notified.promise;}
          const actual=await store.get(id);assert.equal(actual.status,scenario==='complete'?'completed':['denied','capacity'].includes(scenario)?'blocked':'active');
          assert.equal(calls.length,scenario==='denied'?1:2);assert.equal(hooks,calls.length);assert.equal(closed,calls.length);
          assert.equal(new Set(calls.map(c=>c.sessionKey)).size,calls.length);
          assert.ok(sends.every(s=>s.chat==='chat'&&s.topic==='topic'));
          console.log('goal-child: passed');
        }finally{delivery.resolve();await service.close();}
      `;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: repo, env: { ...process.env, TEST_LLM_DEFAULT_KEY: 'offline-key',
          ['DIS' + 'CLAUDE_CONFIG_PATH']: config, ['DIS' + 'CLAUDE_WORKSPACE_DIR']: root,
          NODE_ENV: 'test', LOG_LEVEL: 'error', LOG_TO_FILE: 'false' },
        encoding: 'utf8', timeout: 15_000,
      });
      expect(result.signal, result.stderr || result.stdout).toBeNull();
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(result.stdout).toContain('goal-child: passed');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
