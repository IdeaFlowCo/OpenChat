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
        self.assertEqual(self.invoke('start'), (0, {'action':'start', 'success':True}))
        self.assertTrue(self.running)
        self.assertEqual(self.plist.read_bytes(), installed)
        self.assertEqual(self.launches[1], self.launches[0])
        self.assertEqual(self.launches[1]['ProgramArguments'][-4:], ['--state', str(state), 'watch', '--archive-only'])
        self.assertEqual([c[1] for c in self.calls[-3:]], ['print','bootstrap','kickstart'])

    def test_loaded_service_starts_without_bootstrapping(self):
        self.loaded = True
        self.assertEqual(self.invoke('start')[0], 0)
        self.assertEqual([c[1] for c in self.calls], ['print','kickstart'])
        self.assertTrue(self.running)

    def test_missing_install_fails_without_replacing_configuration(self):
        self.assertEqual(self.invoke('start'), (1, {'action':'start', 'success':False}))
        self.assertEqual([c[1] for c in self.calls], ['print','bootstrap'])
        self.assertFalse(self.plist.exists())


if __name__ == '__main__':
    unittest.main()
