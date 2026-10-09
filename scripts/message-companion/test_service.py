import contextlib
import io
import json
from pathlib import Path
import plistlib
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import service


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.plist = self.root / 'Library/LaunchAgents' / f'{service.LABEL}.plist'
        self.loaded = False
        self.running = False
        self.launches = []
        self.calls = []
        sleep = patch.object(service.time, 'sleep')
        sleep.start(); self.addCleanup(sleep.stop)
        home = patch.object(Path, 'home', return_value=self.root)
        home.start(); self.addCleanup(home.stop)
        run = patch.object(service.subprocess, 'run', side_effect=self.launchctl)
        run.start(); self.addCleanup(run.stop)

    def launchctl(self, command, **kwargs):
        self.calls.append(command)
        action = command[1]
        rc = 0
        if action == 'print':
            rc = 0 if self.loaded else 1
        elif action == 'bootstrap':
            path = Path(command[3])
            if self.loaded or not path.exists():
                rc = 1
            else:
                self.launches.append(plistlib.loads(path.read_bytes()))
                self.loaded = self.running = True
        elif action == 'bootout':
            rc = 0 if self.loaded else 1
            self.loaded = self.running = False
        elif action == 'kickstart':
            rc = 0 if self.loaded else 1
            if self.loaded:
                self.running = True
        else:
            raise AssertionError(command)
        return subprocess.CompletedProcess(command, rc, 'state = running' if self.running else '', '')

    def invoke(self, *arguments):
        output = io.StringIO()
        with patch.object(service.sys, 'argv', ['service.py', *arguments]), contextlib.redirect_stdout(output):
            rc = service.main()
        return rc, json.loads(output.getvalue())

    def test_stop_start_reloads_installed_configuration(self):
        state = self.root / 'custom/archive.sqlite3'
        self.assertEqual(self.invoke('install', '--state', str(state), '--archive-only')[0], 0)
        installed = self.plist.read_bytes()
        self.assertEqual(self.invoke('stop')[0], 0)
        self.assertFalse(self.loaded)
        self.assertEqual(self.invoke('start')[0], 0)
        self.assertTrue(self.running)
        self.assertEqual(self.plist.read_bytes(), installed)
        self.assertEqual(self.launches[1], self.launches[0])
        self.assertEqual(self.launches[1]['ProgramArguments'][-4:], ['--state', str(state), 'watch', '--archive-only'])
        self.assertEqual([c[1] for c in self.calls[-4:]], ['print','bootstrap','kickstart','print'])

    def test_loaded_service_starts_without_bootstrapping(self):
        self.loaded = True
        self.assertEqual(self.invoke('start')[0], 0)
        self.assertEqual([c[1] for c in self.calls], ['print','kickstart','print'])
        self.assertTrue(self.running)

    def test_missing_install_fails_without_replacing_configuration(self):
        rc, outcome = self.invoke('start')
        self.assertEqual(rc, 1)
        self.assertFalse(outcome['success'])
        self.assertFalse(outcome['loaded'])
        self.assertEqual([c[1] for c in self.calls], ['print','bootstrap','print'])
        self.assertFalse(self.plist.exists())

    def test_install_resolves_executable_and_preserves_configuration_on_reinstall(self):
        executable=self.root/'real python'
        executable.write_text('dummy executable')
        executable.chmod(0o700)
        alias=self.root/'python3'
        alias.symlink_to(executable)
        state=self.root/'external archive/state.sqlite3'
        with patch.object(service.sys,'executable',str(alias)):
            self.assertEqual(self.invoke('install','--state',str(state),'--archive-only')[0],0)
            self.assertEqual(self.invoke('install')[0],0)
        config=self.launches[-1]
        self.assertEqual(config['ProgramArguments'][0],str(executable))
        self.assertEqual(config['ProgramArguments'][-4:],['--state',str(state),'watch','--archive-only'])
        self.assertTrue(Path(config['WorkingDirectory']).is_dir())

    def test_loaded_but_not_running_is_reported_as_failed_start(self):
        def failed(command, **kwargs):
            return subprocess.CompletedProcess(command,0,'state = spawn scheduled\nlast exit code = 78: EX_CONFIG\n','')
        with patch.object(service.subprocess,'run',side_effect=failed):
            rc, outcome=self.invoke('start')
        self.assertEqual(rc,1)
        self.assertTrue(outcome['loaded'])
        self.assertFalse(outcome['running'])
        self.assertFalse(outcome['success'])
        self.assertEqual(outcome['lastExitCode'],78)

    def test_upload_mode_can_be_enabled_disabled_and_preserved(self):
        state=self.root/'external archive/state.sqlite3'
        self.assertEqual(self.invoke('install','--state',str(state),'--archive-only')[0],0)
        executable=self.launches[-1]['ProgramArguments'][0]
        for flag, archive_only in [('--upload-enabled',False),(None,False),('--archive-only',True),(None,True)]:
            args=('install',flag) if flag else ('install',)
            self.assertEqual(self.invoke(*args)[0],0)
            command=self.launches[-1]['ProgramArguments']
            self.assertEqual('--archive-only' in command,archive_only)
            self.assertEqual(command[command.index('--state')+1],str(state))
            self.assertEqual(command[0],executable)

    def test_conflicting_modes_are_rejected_without_service_changes(self):
        with contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as error:
                self.invoke('install','--archive-only','--upload-enabled')
        self.assertEqual(error.exception.code,2)
        self.assertEqual(self.calls,[])

    def test_logs_default_locally_and_override_preserves_state_and_mode(self):
        state=self.root/'external archive/state.sqlite3'
        self.assertEqual(self.invoke('install','--state',str(state),'--archive-only')[0],0)
        config=self.launches[-1]
        default_logs=self.root/'Library/Logs/OpenChatCompanion'
        self.assertEqual(Path(config['StandardOutPath']).parent,default_logs)
        self.assertEqual(Path(config['StandardErrorPath']).parent,default_logs)
        self.assertTrue(default_logs.is_dir())
        command=config['ProgramArguments']
        custom=self.root/'custom logs'
        self.assertEqual(self.invoke('install','--log-dir',str(custom))[0],0)
        self.assertEqual(self.launches[-1]['ProgramArguments'],command)
        self.assertEqual(Path(self.launches[-1]['StandardOutPath']).parent,custom)
        self.assertEqual(Path(self.launches[-1]['StandardErrorPath']).parent,custom)
        self.assertEqual(self.invoke('install')[0],0)
        self.assertEqual(Path(self.launches[-1]['StandardOutPath']).parent,custom)
        self.assertEqual(self.launches[-1]['ProgramArguments'],command)
        self.assertEqual(self.invoke('stop')[0],0)
        self.assertEqual(self.invoke('start')[0],0)
        self.assertEqual(Path(self.launches[-1]['StandardOutPath']).parent,custom)

    def test_legacy_external_logs_change_only_with_explicit_override(self):
        state=self.root/'external archive/state.sqlite3'
        self.assertEqual(self.invoke('install','--state',str(state),'--archive-only')[0],0)
        config=plistlib.loads(self.plist.read_bytes())
        config['StandardOutPath']=str(state.parent/'companion.log')
        config['StandardErrorPath']=str(state.parent/'companion-error.log')
        self.plist.write_bytes(plistlib.dumps(config))
        self.assertEqual(self.invoke('install')[0],0)
        self.assertEqual(self.launches[-1]['StandardOutPath'],config['StandardOutPath'])
        local=self.root/'Library/Logs/OpenChatCompanion'
        self.assertEqual(self.invoke('install','--log-dir',str(local))[0],0)
        self.assertEqual(Path(self.launches[-1]['StandardOutPath']).parent,local)
        self.assertEqual(self.launches[-1]['ProgramArguments'],config['ProgramArguments'])


if __name__ == '__main__':
    unittest.main()
