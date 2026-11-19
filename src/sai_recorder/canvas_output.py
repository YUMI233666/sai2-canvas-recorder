import json
from pathlib import Path
import re
import uuid

from .config import atomic_json


CANVAS_MARKER = 'canvas.json'
SESSIONS_DIR = '_sessions'


def _canvas_metadata(directory: Path):
    if directory.is_symlink() or directory.is_junction():
        return None
    try:
        data = json.loads((directory / CANVAS_MARKER).read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return None
    if isinstance(data, dict) and data.get('application') == 'SAI2CanvasRecorder' and data.get('schema') == 1:
        return data
    return None


def canvas_folders(root: Path, name: str | None = None, width: int | None = None, height: int | None = None):
    if not root.exists():
        return []
    folders = []
    for path in root.iterdir():
        if path.is_dir() and (metadata := _canvas_metadata(path)) is not None:
            identity = (metadata.get('name'), metadata.get('width'), metadata.get('height'))
            match = name is not None and identity == (name, width, height)
            folders.append((path, match))
    return sorted(folders, key=lambda item: (not item[1], item[0].name.casefold()))


def create_canvas_folder(root: Path, name: str, width: int | None = None, height: int | None = None) -> Path:
    safe_name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', name).strip(' .')[:48].rstrip(' .')
    folder = root / f'画布-{safe_name or "未命名"}-{uuid.uuid4().hex[:8]}'
    folder.mkdir(parents=True)
    atomic_json(folder / CANVAS_MARKER, {'application': 'SAI2CanvasRecorder', 'schema': 1,
                                        'name': name, 'width': width, 'height': height})
    return folder


def session_output_directory(session: Path) -> Path:
    canvas = session.parent.parent
    if session.parent.name == SESSIONS_DIR and _canvas_metadata(canvas) is not None:
        return canvas
    return session
