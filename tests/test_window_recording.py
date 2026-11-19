from dataclasses import dataclass
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from sai_recorder import gui
from sai_recorder.canvas_output import create_canvas_folder, session_output_directory
from sai_recorder.config import RecordingSettings


@dataclass(frozen=True)
class Canvas:
    name: str = 'Drawing'
    width: int = 3000
    height: int = 2000


class RecordingStartTests(unittest.TestCase):
    def setUp(self):
        temp = self.enterContext(TemporaryDirectory())
        self.root = Path(temp).resolve()
        self.app = app = SimpleNamespace(
            closing=False, busy=False, choosing_folder=False, canvas_destinations={},
            recorder=None, destination=Mock(), status=Mock(), _controls=Mock(),
            _active=Mock(return_value=False), _spec=Mock(side_effect=AssertionError('Unexpected canvas lookup')),
            _selected_process=Mock(return_value={'pid': 1234, 'created': 100.0, 'exe': None}),
            _settings=Mock(return_value=RecordingSettings(output_dir=str(self.root), capture_source='window')),
        )
        app._select_canvas_folder = lambda root, canvas=None: gui.App._select_canvas_folder(app, root, canvas)
        self.recorder = self.enterContext(patch.object(gui, 'Recorder'))
        self.save_settings = self.enterContext(patch.object(gui, 'save_settings'))
        self.window_source = self.enterContext(patch.object(gui, 'SaiWindowSource'))
        self.canvas_source = self.enterContext(patch.object(gui, 'SaiSource'))
        self.pick = self.enterContext(patch.object(gui.Querybox, 'get_item'))
        self.name = self.enterContext(patch.object(gui.Querybox, 'get_string', return_value='My drawing'))

    def test_window_starts_without_a_canvas_or_executable_path(self):
        gui.App._start(self.app)
        self.app._spec.assert_not_called()
        factory, _, folder, description = self.recorder.call_args.args
        self.assertEqual(description, {'window': {'pid': 1234}})
        self.assertIs(factory(), self.window_source.return_value)
        self.window_source.assert_called_once_with(1234, 100.0)
        self.recorder.return_value.start.assert_called_once()
        marker = json.loads((folder / 'canvas.json').read_text(encoding='utf-8'))
        self.assertEqual(marker['name'], 'My drawing')
        self.assertIsNone(marker['width'])
        self.assertIsNone(marker['height'])
        self.assertEqual(session_output_directory(folder / '_sessions' / 'test'), folder)

    def test_window_reuses_existing_canvas_archive(self):
        existing = create_canvas_folder(self.root, 'Existing', 3000, 2000)
        self.pick.return_value = existing.name
        gui.App._start(self.app)
        self.assertEqual(self.recorder.call_args.args[2], existing)
        self.name.assert_not_called()
        self.assertEqual(list(self.root.iterdir()), [existing])

    def test_cancel_new_archive_does_not_start(self):
        self.name.return_value = None
        gui.App._start(self.app)
        self.recorder.assert_not_called()
        self.save_settings.assert_not_called()
        self.assertFalse(self.app.choosing_folder)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_unspecified_process_does_not_prompt_for_a_folder(self):
        self.app._selected_process.return_value = None
        gui.App._start(self.app)
        self.recorder.assert_not_called()
        self.name.assert_not_called()
        self.assertIn('SAI2', self.app.last_error)

    def test_full_canvas_keeps_using_connected_canvas(self):
        canvas = Canvas()
        self.app._settings.return_value = RecordingSettings(output_dir=str(self.root))
        self.app._spec.side_effect = None
        spec = gui.SourceSpec(1234, 100.0, Canvas('Profile'), canvas)
        self.app._spec.return_value = spec
        gui.App._start(self.app)
        factory, _, folder, description = self.recorder.call_args.args
        self.app._spec.assert_called_once()
        self.app._selected_process.assert_not_called()
        self.assertIs(factory(), self.canvas_source.return_value)
        self.canvas_source.assert_called_once_with(spec)
        self.assertEqual(description['canvas']['width'], 3000)
        self.assertEqual(self.app.canvas_destinations[(self.root, canvas)], folder)
        self.name.assert_not_called()
