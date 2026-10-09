#!/usr/bin/env python3
"""Install/control this user's OpenChat capture companion through launchd."""
import argparse
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys

LABEL='com.openchat.message-companion'


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=['install','start','stop','status'])
    parser.add_argument('--state',default=str(Path.home()/'Library/Application Support/OpenChat/companion.sqlite3'))
    parser.add_argument('--archive-only',action='store_true')
    args=parser.parse_args()
    plist=Path.home()/'Library/LaunchAgents'/f'{LABEL}.plist'
    target=f'gui/{os.getuid()}/{LABEL}'
    def run(*command):return subprocess.run(command,capture_output=True,text=True)
    if args.action=='install':
        state=Path(args.state).expanduser().resolve();state.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
        library=Path.home()/'.local/lib/openchat-companion';library.mkdir(parents=True,exist_ok=True)
        for name in ('companion.py','service.py','add-address.applescript'):
            source=Path(__file__).resolve().parent/name;dest=library/name
            if source!=dest:shutil.copy2(source,dest)
        command=[sys.executable,str(library/'companion.py'),'--state',str(state),'watch']
        if args.archive_only:command.append('--archive-only')
        config={'Label':LABEL,'ProgramArguments':command,'RunAtLoad':True,'KeepAlive':True,'ThrottleInterval':30,
                'StandardOutPath':str(state.parent/'companion.log'),'StandardErrorPath':str(state.parent/'companion-error.log'),
                'EnvironmentVariables':{'PATH':'/opt/homebrew/bin:/usr/bin:/bin'},'ProcessType':'Background'}
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
        result=run('launchctl','print',target)
        print(json.dumps({'installed':plist.exists(),'loaded':result.returncode==0,'running':'state = running' in result.stdout}));return 0
    print(json.dumps({'action':args.action,'success':result.returncode==0}))
    return int(result.returncode!=0)


if __name__=='__main__':sys.exit(main())
