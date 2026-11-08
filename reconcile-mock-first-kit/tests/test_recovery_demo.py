import contextlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import recovery_demo


class RecoveryDemoLauncherTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='reconcile-launcher-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.here = self.root / 'kit'
        self.config = self.here / 'runtime' / 'live-adapty' / 'live-config.json'
        self.config.parent.mkdir(parents=True)
        self.config.write_text('{}')

    def live_command(self, *args):
        with patch.object(recovery_demo, 'HERE', self.here), \
                patch.object(sys, 'argv', ['recovery_demo', *args]), \
                patch.object(recovery_demo.os, 'execv', side_effect=SystemExit(0)) as execute:
            with self.assertRaises(SystemExit):
                recovery_demo.main()
        return execute.call_args.args[1]

    def test_live_mode_honors_explicit_isolated_runtime(self):
        runtime = self.root / 'isolated'
        command = self.live_command('--runtime', str(runtime), '--port', '0')
        self.assertEqual(command[command.index('--runtime') + 1], str(runtime))
        self.assertIn('--live-bootstrap-pending', command)
        runtime.mkdir()
        self.assertNotIn('--live-bootstrap-pending',
                         self.live_command('--runtime', str(runtime)))

    def test_default_live_runtime_is_preserved(self):
        command = self.live_command()
        self.assertEqual(command[command.index('--runtime') + 1],
                         str(self.config.parent / 'demo'))

    def test_explicit_mock_modes_never_select_private_live_config(self):
        for flag, automatic in (('--mock', True), ('--manual', False)):
            with self.subTest(flag=flag), patch.object(recovery_demo, 'HERE', self.here), \
                    patch.object(sys, 'argv', ['recovery_demo', flag, '--port', '0']), \
                    patch.object(recovery_demo, 'Demo') as demo, \
                    patch.object(recovery_demo.signal, 'signal'), \
                    patch.object(recovery_demo.time, 'sleep', side_effect=KeyboardInterrupt), \
                    patch.object(recovery_demo.os, 'execv') as execute, \
                    contextlib.redirect_stdout(io.StringIO()) as output:
                instance = demo.return_value.__enter__.return_value
                instance.urls = {'engine': 'http://127.0.0.1:1'}
                instance.runtime = self.root / 'mock'
                instance.processes = {}
                recovery_demo.main()
                execute.assert_not_called()
                demo.assert_called_once_with(self.here / 'runtime' / 'recovery', 0,
                                             auto_repair=automatic)
                notice = json.loads(output.getvalue().splitlines()[0])['notice']
                self.assertIn('explicitly selected', notice)
                self.assertIn('automatic' if automatic else 'manual', notice)


if __name__ == '__main__':
    unittest.main()
