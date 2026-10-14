import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveDshBootstrap, dshSdkModules } from './sdk-bootstrap.js';
import { DeepSeekHarnessProvider } from './provider.js';
import { DshStdioTransport } from './dsh-transport.js';
import { dshApiProvider } from './native-profile.js';

describe('DSH direct Node SDK bootstrap', () => {
  it('keeps the CLI default and rejects an unknown bootstrap without falling back', () => {
    expect(resolveDshBootstrap()).toBe('cli');
    expect(resolveDshBootstrap('node-sdk')).toBe('node-sdk');
    expect(() => resolveDshBootstrap('unknown')).toThrow('must be cli or node-sdk');
  });

  it('rejects unsupported compositions and launch overrides before starting a worker', () => {
    expect(() => new DeepSeekHarnessProvider({ bootstrap:'node-sdk', mode:'standard' })).toThrow('minimal mode');
    expect(() => new DeepSeekHarnessProvider({ bootstrap:'node-sdk', mode:'minimal', binary:'dsh' })).toThrow('owned Node worker');
  });

  it('opens and cancels real native sessions and shuts down with no dsh executable on PATH', async () => {
    dshSdkModules();
    const directory=await mkdtemp(join(tmpdir(),'owned-node-sdk-'));
    const api={protocol:'openai' as const,baseUrl:'http://127.0.0.1:1/v1',model:'owned-no-model-request'};
    const built=await import(pathToFileURL(resolve('packages/core/dist/sdk/providers/deepseek/native-profile.js')).href);
    const overlay=built.createDshNativeProfileOverlay(api);
    let stderr='';
    const transport=new DshStdioTransport({
      binary:process.execPath,
      args:[resolve('packages/core/dist/sdk/providers/deepseek/sdk-worker.js'),overlay.path],
      cwd:directory,
      env:{...process.env,PATH:'/usr/bin:/bin',DSH_HOME:directory,DISCLAUDE_DSH_API_KEY:'non-secret-test-placeholder'},
      requestTimeoutMs:10_000,
      onStderr:data=>{stderr=(stderr+data).slice(-4000);},
    });
    try {
      const init=await transport.request('initialize',{cwd:directory,provider:dshApiProvider(api),model:api.model,tools:[]});
      expect(init).toMatchObject({capabilities:{resume:true,cancel:true}});
      for(const sessionId of ['owned_sdk_a','owned_sdk_b']) {
        expect(await transport.request('session/open',{sessionId,resume:false})).toMatchObject({sessionId,resumed:false});
        expect(await transport.request('session/cancel',{sessionId})).toMatchObject({reasoningStopped:true,executionStop:'not_confirmed'});
      }
      await transport.shutdown();
    } catch(error) {
      throw new Error(`Native SDK worker failed: ${stderr}`,{cause:error});
    } finally {
      await transport.shutdown().catch(()=>{});
      overlay.dispose();
      await rm(directory,{recursive:true});
    }
  });
});
