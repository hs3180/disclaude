import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const repo = fileURLToPath(new URL('../../../../', import.meta.url));
it.each(['complete', 'submission-ack', 'board-read-ack', 'unknown-projection', 'foreign-goal', 'premature-complete', 'artifact-changed', 'busy-task', 'report-missing'])(
  'composes actual Goal/task/review components through %s', scenario => {
    const root = mkdtempSync(join(tmpdir(), 'disclaude-goal-board-'));
    try {
      const config = join(root, 'config.json');
      writeFileSync(config, JSON.stringify({ workspace: { dir: root },
        agents: { default: { backend: 'claude', llm: 'default' } },
        llms: { default: { defaultModel: 'offline-default', api: { protocol: 'anthropic', apiKey: '$TEST_LLM_DEFAULT_KEY' } } },
      }));
      const script = `
        import assert from 'node:assert/strict';
        import { realpathSync,mkdirSync,writeFileSync,readFileSync,existsSync } from 'node:fs';
        import { join } from 'node:path';
        import { GoalStore,ProjectManager,TaskClaimStore,TaskReviewStore,getProvider } from './packages/core/dist/index.js';
        import { prepareTools } from './packages/core/dist/sdk/tools.js';
        import { GoalExecutionService } from './packages/service/dist/goals/goal-execution-service.js';
        import { createGoalBoardTurnTools } from './packages/service/dist/goals/goal-board-tools.js';
        import { writeTaskReport } from './packages/service/dist/goals/task-report-inbox.js';
        globalThis.fetch=async()=>{throw new Error('Live fetch forbidden')};
        const scenario=${JSON.stringify(scenario)},root=realpathSync(${JSON.stringify(root)}),project=join(root,'project');mkdirSync(project);
        const store=new GoalStore(join(root,'goals')),manager=new ProjectManager({workspaceDir:root});manager.use('chat',project);
        const target={baseToken:'baseFixture',tableId:'tblFixture',recordId:'recFixture'};
        const criteria='Report includes required section';let id,writes=0,readAck=false,worker=0,reviewer=0,closed=0;
        const rows={recordId:target.recordId,fields:{'任务 ID':'task-A','Goal ID':'pending','验收要求':criteria,'状态':['待办'],'负责人':'','userNote':'keep'}};
        const port={read:async()=>{if(readAck){readAck=false;throw new Error('lost read ACK')}return structuredClone(rows)},patch:async fields=>{
          writes++;if(scenario==='unknown-projection')throw new Error('unknown remote write');Object.assign(rows.fields,fields);
          if(scenario==='board-read-ack'&&fields['状态']?.[0]==='待 review'&&worker===1)readAck=true;
        }};
        const queries=[],sends=[];let notify;const notified=new Promise(resolve=>{notify=resolve});
        if(scenario==='submission-ack'){
          const save=TaskReviewStore.prototype.submit;let lost=false;
          TaskReviewStore.prototype.submit=async function(...args){const value=await save.apply(this,args);if(!lost){lost=true;throw new Error('lost submission ACK')}return value};
        }
        getProvider('claude').queryStream=(input,options)=>{
          let release;const parked=new Promise(resolve=>{release=resolve});const index=queries.length;queries.push(options);
          return{handle:{close:()=>{closed++;release()},cancel:()=>{}},iterator:(async function*(){
            const actual=(await input.next()).value;assert.equal(actual.inputContext.actorId,'actor');assert.equal(actual.inputContext.sourceMessageId,'start');
            assert.equal(options.model,'selected-offline');assert.equal(options.cwd,project);
            const tools=prepareTools(options.tools),context={signal:new AbortController().signal};
            const injected=(options.tools??[]).map(tool=>tool.name).filter(name=>['goal_report','goal_board_task','run_agent_task','board_artifacts_report','board_review_report'].includes(name));
            if(index===0){
              assert.deepEqual(injected.sort(),['goal_board_task','goal_report']);
              const tool=tools.find(t=>t.name==='goal_board_task');assert.ok(tool);
              const args={action:'execute',operationId:'work1',taskId:'task-A',target,task:'Make first report'};
              if(['unknown-projection','foreign-goal'].includes(scenario)){
                await assert.rejects(tool.execute(args,context));await assert.rejects(tool.execute(args,context));
                assert.equal(queries.length,1);assert.equal(writes,scenario==='unknown-projection'?1:0);
              }else if(scenario==='busy-task'){
                await assert.rejects(tool.execute(args,context),/claimed by another owner/);
                assert.equal(queries.length,1);assert.equal(writes,0);assert.equal(worker,0);
              }else{
                let first;
                if(['submission-ack','board-read-ack'].includes(scenario))await assert.rejects(tool.execute(args,context));
                if(scenario==='report-missing')await assert.rejects(tool.execute(args,context),/no artifacts proposal/);
                else{first=await tool.execute(args,context);const retry=await tool.execute(args,context);
                assert.equal(first.native.id,retry.native.id);assert.equal(worker,1);assert.equal(first.approved,false);
                assert.equal(JSON.stringify(first).includes('claimId'),false);}
                if(scenario!=='premature-complete'&&scenario!=='report-missing'){
                const rejected=await tool.execute({action:'review',operationId:'review1',taskId:'task-A',target,submissionId:first.review.submissions.at(-1).id},context);
                assert.equal(rejected.approved,false);assert.equal(rows.fields['状态'][0],'返工');
                const repaired=await tool.execute({...args,operationId:'work2',task:'Repair report'},context);
                const approved=await tool.execute({action:'review',operationId:'review2',taskId:'task-A',target,submissionId:repaired.review.submissions.at(-1).id},context);
                assert.equal(approved.approved,true);assert.equal(rows.fields['状态'][0],'完成');
                assert.equal(approved.review.submissions.length,2);assert.equal(approved.review.submissions[0].review.verdict,'changes-requested');
                assert.notEqual(approved.review.submissions[1].submitter,approved.review.submissions[1].review.reviewer);
                assert.equal((await tool.execute({action:'get',operationId:'review2',taskId:'task-A',target},context)).approved,true);
                assert.equal(readFileSync(join(project,'report.txt'),'utf8'),'ready\\nrequired section\\n');
                if(scenario==='artifact-changed'){
                  writeFileSync(join(project,'report.txt'),'changed after approval\\n');
                  assert.equal((await tool.execute({action:'get',operationId:'review2',taskId:'task-A',target},context)).approved,false);
                }
                }
              }
              const blocked=['unknown-projection','foreign-goal','busy-task','report-missing'].includes(scenario);
              const premature=scenario==='premature-complete';
              await tools.find(t=>t.name==='goal_report').execute({outcome:blocked?'blocked':premature?'completed':'completed',
                progress:'Inspected actual task/review states',artifacts:blocked?[]:['report.txt'],
                checks:blocked?[]:[{criterion:0,satisfied:true,evidence:['report.txt']}]},context);
              yield{type:'text',role:'assistant',content:'parent result'};
            }else{
              // Children never receive Goal/board tools; they report through
              // the disclaude CLI receipt inbox parsed from their own task.
              assert.deepEqual(injected,[]);assert.equal(options.capacityAdmission,'reject');assert.equal(options.onAsyncUserInputAnswer,undefined);
              const text=typeof actual.content==='string'?actual.content:'',kind=/--kind (artifacts|review)\\b/.exec(text)?.[1],inbox=/--inbox (\\S+) --kind/.exec(text)?.[1];
              assert.ok(kind&&inbox);
              if(kind==='artifacts'){worker++;
                if(scenario!=='report-missing'){
                  writeFileSync(join(project,'report.txt'),worker===1?'draft\\n':'ready\\nrequired section\\n');
                  await writeTaskReport(inbox,'artifacts',{summary:'Read back report.txt',refs:['report.txt']});
                }else{writeFileSync(join(project,'report.txt'),'draft\\n');}
              }else{reviewer++;
                const ok=readFileSync(join(project,'report.txt'),'utf8').includes('required section');
                await writeTaskReport(inbox,'review',{verdict:ok?'approved':'changes-requested',
                  reason:ok?'Read required section':'Required section missing',
                  evidence:[{criterion:0,note:ok?'Verified actual required section':'Read actual draft; missing required section'}]});
              }
              yield{type:'text',role:'assistant',content:'child result'};
            }
            yield{type:'result',content:'',metadata:{stopReason:'end_turn'}};await parked;
          })()};
        };
        const callbacks={sendMessage:async(chat,text,topic)=>{sends.push({chat,text,topic});if(text.startsWith('Goal '))notify();return 'local-receipt'},sendFile:async()=>{},sendCard:async()=>{}};
        const service=new GoalExecutionService({store,projectManager:manager,isCommandAllowed:()=>true,runtimeOptions:()=>({model:'selected-offline'}),callbacks:()=>callbacks,
          createTurnTools:scope=>createGoalBoardTurnTools(scope,join(root,'task-state'),{boardPort:()=>port})});
        try{
          const goal=await store.create({chatId:'chat',projectRoot:project,objective:'Deliver independent reviewed report',acceptance:['Current report reviewed against actual bytes']});id=goal.id;
          rows.fields['Goal ID']=scenario==='foreign-goal'?'other-goal':id;
          if(scenario==='busy-task'){
            const foreign=new TaskClaimStore(join(root,'task-state','claims'));
            await foreign.claim(JSON.stringify([project,id,'baseFixture','tblFixture','recFixture','task-A']),0,'foreign-owner');
          }
          const {handle}=await service.start({goalId:id,expectedRevision:goal.revision,chatId:'chat',actorId:'actor',sourceMessageId:'start',threadRootId:'topic',chatType:'topic',projectRoot:project},'activate');
          await handle.completion;await notified;
          const blocked=['unknown-projection','foreign-goal','busy-task','report-missing'].includes(scenario),premature=scenario==='premature-complete';
          assert.equal((await store.get(id)).status,blocked?'blocked':premature||scenario==='artifact-changed'?'active':'completed');
          if(blocked)assert.equal(queries.length,scenario==='busy-task'?1:scenario==='report-missing'?2:1);
          else assert.equal(queries.length,premature?2:5);
          assert.equal(closed,queries.length);
          assert.equal(worker,['busy-task','unknown-projection','foreign-goal'].includes(scenario)?0:['premature-complete','report-missing'].includes(scenario)?1:2);
          assert.equal(reviewer,blocked||premature||scenario==='report-missing'?0:2);
          assert.equal(rows.fields.userNote,'keep');assert.ok(sends.every(s=>s.chat==='chat'&&s.topic==='topic'));
          if(scenario==='busy-task'||scenario==='unknown-projection')assert.equal(existsSync(join(project,'report.txt')),false);
          console.log('goal-board: passed');
        }finally{await service.close();}
      `;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: repo, env: { ...process.env, TEST_LLM_DEFAULT_KEY: 'offline-key',
          ['DIS' + 'CLAUDE_CONFIG_PATH']: config, ['DIS' + 'CLAUDE_WORKSPACE_DIR']: root,
          NODE_ENV: 'test', LOG_LEVEL: 'error', LOG_TO_FILE: 'false' }, encoding: 'utf8', timeout: 20_000,
      });
      expect(result.signal, result.stderr || result.stdout).toBeNull();
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(result.stdout, result.stderr).toContain('goal-board: passed');
    } finally { rmSync(root, { recursive: true, force: true }); }
  },
);
