"""Real terminal bootstrap and local service acceptance; no model/channel credentials."""
import errno, json, os, pathlib, pty, select, signal, socket, subprocess, sys, tempfile, time, urllib.request

node, cli = sys.argv[1:]
with tempfile.TemporaryDirectory(prefix='disclaude-workspace-e2e-') as tmp:
    home = pathlib.Path(tmp)
    env = {k:v for k,v in os.environ.items() if not k.startswith(('DISCLAUDE_', 'ANTHROPIC_', 'CLAUDE_', 'DEEPSEEK_', 'FEISHU_'))}
    env.update(HOME=tmp, LOCKFILE_PATH=str(home/'service.pid'), LOG_TO_FILE='false', NODE_ENV='test')
    config = home/'.disclaude/disclaude.config.yaml'
    def run(args=None):
        return subprocess.run([node,cli,'start',*(args or [])],cwd=tmp,env=env,capture_output=True,text=True,timeout=20)
    result=run()
    assert result.returncode!=0 and 'Workspace setup required' in result.stderr
    assert not config.exists()
    def terminal(answers):
        master,slave=pty.openpty()
        child=subprocess.Popen([node,cli,'start'],cwd=tmp,env=env,stdin=slave,stdout=slave,stderr=slave,start_new_session=True)
        os.close(slave); output=''; step=0; until=time.monotonic()+25
        try:
            while time.monotonic()<until:
                if select.select([master],[],[],0.1)[0]:
                    try:chunk=os.read(master,65536)
                    except OSError as error:
                        if error.errno==errno.EIO:break
                        raise
                    if not chunk:break
                    output+=chunk.decode(errors='replace')
                    if step<len(answers) and answers[step][0] in output:
                        prompt,answer=answers[step];output=output.replace(prompt,'',1)
                        os.write(master,answer.encode());step+=1
                if child.poll() is not None:break
            assert child.poll() is not None or child.wait(timeout=3) is not None,output
            assert step==len(answers),output
            return child.returncode,output
        finally:
            if child.poll() is None:os.killpg(child.pid,signal.SIGTERM);child.wait(timeout=5)
            os.close(master)
    selected=home/'disclaude-workspace'
    code,out=terminal([('Workspace directory [','\n'),('Use '+str(selected),'n\n')])
    assert code!=0 and not config.exists() and not selected.exists(),out
    code,out=terminal([('Workspace directory [','\x03')])
    assert code!=0 and not config.exists(),out
    code,out=terminal([('Workspace directory [','\n'),('Use '+str(selected),'y\n')])
    assert selected.is_dir() and str(selected) in config.read_text(),out
    config.unlink();selected.rmdir()  # only this disposable test's empty first-run state
    invalid=home/'file';invalid.write_text('keep')
    custom=home/'My task files'
    code,out=terminal([('Workspace directory [',str(invalid)+'\n'),('Cannot use this workspace:',str(custom)+'\n'),('Use '+str(custom),'y\n')])
    assert custom.is_dir() and config.exists() and 'Workspace saved:' in out,out
    # Minimal config is created on a brand-new install; backend/channel setup is separate.
    assert code!=0 and ('channel' in out.lower() or 'API key' in out),out
    saved=config.read_text();assert str(custom) in saved and str(selected) not in saved
    assert (config.stat().st_mode & 0o777)==0o600
    result=run();assert 'Workspace directory [' not in result.stdout
    assert config.read_text()==saved
    # Exercise a real service twice; a real upload writes to the chosen workspace and survives restart.
    with socket.socket() as probe:
        probe.bind(('127.0.0.1',0));port=probe.getsockname()[1]
    payload={'workspace':{'dir':str(custom)},'agent':{'agentBackend':'claude','provider':'anthropic','model':'claude-sonnet-4'},
             'anthropic':{'apiKey':'offline-workspace-test'},'channels':{'feishu':{'enabled':False},'rest':{'enabled':True,'host':'127.0.0.1','port':port,'fileStorageDir':str(custom/'files')}},'logging':{'level':'info'}}
    config.write_text(json.dumps(payload))
    for attempt in range(2):
        output=home/f'run-{attempt}.log'
        with output.open('w') as log:
            child=subprocess.Popen([node,cli,'start','--api-port','0'],cwd=tmp,env=env,stdout=log,stderr=log,start_new_session=True)
            try:
                until=time.monotonic()+30
                while time.monotonic()<until:
                    try:
                        with urllib.request.urlopen(f'http://127.0.0.1:{port}/api/health',timeout=1) as response:
                            if response.status==200:break
                    except Exception:pass
                    assert child.poll() is None,output.read_text()
                    time.sleep(.1)
                else:raise AssertionError(output.read_text())
                if attempt==0:
                    data=json.dumps({'fileName':'workspace-result.txt','content':'d29ya3NwYWNlLXJlc3VsdA==','mimeType':'text/plain','chatId':'workspace-e2e'}).encode()
                    request=urllib.request.Request(f'http://127.0.0.1:{port}/api/files/upload',data=data,headers={'Content-Type':'application/json'})
                    with urllib.request.urlopen(request,timeout=5) as response:
                        uploaded=json.load(response);file_id=uploaded['file']['id']
                    assert any(p.is_file() and p.read_bytes()==b'workspace-result' for p in (custom/'files').rglob('*'))
                with urllib.request.urlopen(f'http://127.0.0.1:{port}/api/files/{file_id}/download',timeout=5) as response:
                    assert json.load(response)['content']=='d29ya3NwYWNlLXJlc3VsdA=='
                assert 'Workspace directory [' not in output.read_text()
            finally:
                if child.poll() is None:os.killpg(child.pid,signal.SIGTERM)
                child.wait(timeout=20)
            assert child.returncode==0,output.read_text()
    # Malformed YAML diagnostics must not quote secrets from the configuration.
    config.write_text('apiKey: [private-sentinel\n')
    result=run()
    assert result.returncode!=0 and 'Cannot parse configuration' in result.stderr
    assert 'private-sentinel' not in result.stdout+result.stderr
    # No automatic creation for explicit production paths.
    payload['workspace']['dir']=str(home/'missing-explicit')
    config.write_text(json.dumps(payload));result=run()
    assert result.returncode!=0 and not (home/'missing-explicit').exists()
    assert 'Workspace directory [' not in result.stdout
    print(json.dumps({'defaultVisibleDirectory':True,'ctrlCCancelNoWrite':True,'nonTTYInstructions':True,'cancelNoWrite':True,'invalidPathRetry':True,'customPathPersisted':True,'configMode600':True,'realUploadAcrossRestarts':True,'secondStartNoPrompt':True,'explicitMissingPathNotCreated':True}))
