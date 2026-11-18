from dataclasses import asdict, dataclass
from pathlib import Path
import json
import math
import os
import sys

import cv2
import numpy as np


SAMPLE_INTERVAL_ERROR = '延时采样间隔应在 0.1～60 秒之间'


def app_directory() -> Path:
    if getattr(sys, 'frozen', False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parents[2]


def data_directory() -> Path:
    # Keep source runs self-contained; installed builds use a writable per-user folder.
    if getattr(sys, 'frozen', False):
        return Path(os.environ.get('LOCALAPPDATA', str(Path.home()))) / 'SAI2CanvasRecorder'
    return app_directory()


@dataclass(frozen=True)
class RecordingSettings:
    mode: str = 'realtime'
    fps: int = 30
    interval: float = 0.5
    skip_unchanged: bool = True
    long_edge: int = 1920  # 0 = original size; never enlarge smaller canvases
    crf: int = 20
    preset: str = 'veryfast'
    container: str = 'mp4'
    segment_seconds: int = 60
    output_dir: str = str(Path.home() / 'Videos' / 'SAI2录制')
    capture_source: str = 'canvas'

    def validate(self):
        if self.mode not in ('realtime', 'timelapse'):
            raise ValueError('未知的录制模式')
        if self.capture_source not in ('canvas', 'window'):
            raise ValueError('未知的采集来源')
        if self.fps not in (15, 24, 30, 60):
            raise ValueError('帧率应为 15、24、30 或 60')
        if not math.isfinite(self.interval) or not 0.1 <= self.interval <= 60:
            raise ValueError(SAMPLE_INTERVAL_ERROR)
        if self.long_edge not in (0, 1280, 1920, 2560, 3840):
            raise ValueError('不支持的输出尺寸')
        if self.crf not in (16, 20, 24, 28):
            raise ValueError('不支持的画质参数')
        if self.preset not in ('ultrafast', 'veryfast', 'fast', 'medium'):
            raise ValueError('不支持的编码速度')
        if self.container not in ('mp4', 'mkv'):
            raise ValueError('输出格式应为 MP4 或 MKV')
        if not 5 <= self.segment_seconds <= 600:
            raise ValueError('分段时长应在 5～600 秒之间')
        if not self.output_dir.strip():
            raise ValueError('请选择输出文件夹')
        return self


def atomic_json(path: Path, data: dict):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + '.tmp')
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
    tmp.replace(path)


def load_settings(path: Path | None = None) -> RecordingSettings:
    path = path or data_directory() / 'recorder-settings.json'
    if not path.exists():
        return RecordingSettings()
    raw = json.loads(path.read_text(encoding='utf-8'))
    fields = RecordingSettings.__dataclass_fields__
    return RecordingSettings(**{k: v for k, v in raw.items() if k in fields}).validate()


def save_settings(settings: RecordingSettings):
    atomic_json(data_directory() / 'recorder-settings.json', asdict(settings.validate()))


def output_geometry(width: int, height: int, long_edge: int):
    if width < 1 or height < 1:
        raise ValueError('画布尺寸无效')
    scale = min(1.0, long_edge / max(width, height)) if long_edge else 1.0
    content = (max(1, round(width * scale)), max(1, round(height * scale)))
    # H.264 yuv420p requires even dimensions. Pad at most one pixel, never crop.
    encoded = (content[0] + content[0] % 2, content[1] + content[1] % 2)
    return content, encoded


def fit_frame(image: np.ndarray, geometry) -> np.ndarray:
    content, encoded = geometry
    if (image.shape[1], image.shape[0]) != content:
        image = cv2.resize(image, content, interpolation=cv2.INTER_AREA)
    if encoded != content:
        image = cv2.copyMakeBorder(image, 0, encoded[1] - content[1],
                                  0, encoded[0] - content[0], cv2.BORDER_CONSTANT)
    return np.ascontiguousarray(image)
