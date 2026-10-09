#!/usr/bin/env python3
"""Install/control this user's OpenChat capture companion through launchd."""
import argparse
import json
import os
from pathlib import Path
import plistlib
import re
import time
import shutil
import subprocess
import sys

LABEL='com.openchat.message-companion'


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=['install','start','stop','status'])
    parser.add_argument('--state')
    parser.add_argument('--log-dir')
    mode=parser.add_mutually_exclusive_group()
    mode.add_argument('--archive-only',dest='archive_only',action='store_true',default=None)
    mode.add_argument('--upload-enabled',dest='archive_only',action='store_false')
    args=parser.parse_args()
    plist=Path.home()/'Library/LaunchAgents'/f'{LABEL}.plist'
    target=f'gui/{os.getuid()}/{LABEL}'
    def run(*command):return subprocess.run(command,capture_output=True,text=True)
    def status():
        result=run('launchctl','print',target)
        state=re.search(r'^\s*state = (.+)$',result.stdout,re.M)
        exit_code=re.search(r'^\s*last exit code = (-?\d+)',result.stdout,re.M)
        return {'installed':plist.exists(),'loaded':result.returncode==0,
                'running':result.returncode==0 and bool(state and state[1]=='running'),
                'lastExitCode':int(exit_code[1]) if exit_code else None}
    if args.action=='install':
        previous_config=plistlib.loads(plist.read_bytes()) if plist.exists() else {}
        previous=previous_config.get('ProgramArguments',[])
        previous_state=previous[previous.index('--state')+1] if '--state' in previous else None
        selected_state=args.state or previous_state or str(Path.home()/'Library/Application Support/OpenChat/companion.sqlite3')
        archive_only=args.archive_only if args.archive_only is not None else '--archive-only' in previous
        executable=Path(sys.executable).resolve()
        if not executable.is_file() or not os.access(executable,os.X_OK):
            print(json.dumps({'action':'install','success':False,'error':'Python executable unavailable'}));return 1
        state=Path(selected_state).expanduser().resolve();state.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
        log_dir=Path(args.log_dir).expanduser().resolve() if args.log_dir else Path.home()/'Library/Logs/OpenChatCompanion'
        stdout=log_dir/'companion.log' if args.log_dir else Path(previous_config.get('StandardOutPath',log_dir/'companion.log'))
        stderr=log_dir/'companion-error.log' if args.log_dir else Path(previous_config.get('StandardErrorPath',log_dir/'companion-error.log'))
        for directory in {stdout.parent,stderr.parent}:directory.mkdir(parents=True,exist_ok=True,mode=0o700)
        library=Path.home()/'.local/lib/openchat-companion';library.mkdir(parents=True,exist_ok=True)
        for name in ('companion.py','service.py','add-address.applescript'):
            source=Path(__file__).resolve().parent/name;dest=library/name
            if source!=dest:shutil.copy2(source,dest)
        command=[str(executable),str(library/'companion.py'),'--state',str(state),'watch']
        if archive_only:command.append('--archive-only')
        config={'Label':LABEL,'ProgramArguments':command,'RunAtLoad':True,'KeepAlive':True,'ThrottleInterval':30,
                'StandardOutPath':str(stdout),'StandardErrorPath':str(stderr),
                'WorkingDirectory':str(library),'EnvironmentVariables':{'PATH':'/opt/homebrew/bin:/usr/bin:/bin'},'ProcessType':'Background'}
        plist.parent.mkdir(parents=True,exist_ok=True)
        run('launchctl','bootout',target)
        plist.write_bytes(plistlib.dumps(config));os.chmod(plist,0o600)
        result=run('launchctl','bootstrap',f'gui/{os.getuid()}',str(plist))
    elif args.action=='start':
        result=run('launchctl','print',target)
        if result.returncode!=0:
            result=run('launchctl','bootstrap',f'gui/{os.getuid()}',str(plist))
        if result.returncode==0:
            result=run('launchctl','kickstart',target)
    elif args.action=='stop':result=run('launchctl','bootout',target)
    else:
        print(json.dumps(status()));return 0
    outcome={'action':args.action,'success':result.returncode==0,'launchctlExitCode':result.returncode}
    if args.action in ('install','start'):
        runtime=status()
        for _ in range(5):
            if runtime['running'] or result.returncode!=0:break
            time.sleep(0.2)
            runtime=status()
        outcome.update(runtime)
        outcome['success']=result.returncode==0 and runtime['running']
        if not outcome['success']:
            outcome['error']='Service did not reach running state; inspect launchctl status and configured log files'
    print(json.dumps(outcome))
    return int(not outcome['success'])


if __name__=='__main__':sys.exit(main())
