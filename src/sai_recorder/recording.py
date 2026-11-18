from dataclasses import asdict
from datetime import datetime
from pathlib import Path
from queue import Empty, Full, Queue
import math
import logging
import os
import threading
import time
import traceback
import uuid

import numpy as np

from .canvas_output import SESSIONS_DIR
from .config import RecordingSettings, atomic_json, fit_frame, output_geometry
from .encoder import FfmpegWriter, merge_parts
from .memory import MemoryReadError


class ActiveClock:
    def __init__(self):
        self.start = time.monotonic()
        self.paused_at = None
        self.paused_total = 0.0
        self.lock = threading.Lock()

    def pause(self):
        with self.lock:
            if self.paused_at is None:
                self.paused_at = time.monotonic()

    def resume(self):
        with self.lock:
            if self.paused_at is not None:
                self.paused_total += time.monotonic() - self.paused_at
                self.paused_at = None

    def elapsed(self):
        with self.lock:
            return (self.paused_at if self.paused_at is not None else time.monotonic()) - self.start - self.paused_total


class RealtimeTimeline:
    """Map monotonic capture timestamps to CFR, duplicating holds after missed samples."""
    def __init__(self, fps, write):
        self.fps = fps
        self.write = write
        self.previous = None
        self.frames = 0

    def push(self, timestamp, image):
        target = max(0, math.floor(timestamp * self.fps + 1e-9))
        if self.previous is not None:
            while self.frames < target:
                self.write(self.previous)
                self.frames += 1
        self.previous = image

    def finish(self, duration):
        if self.previous is not None:
            target = max(1, math.ceil(duration * self.fps))
            while self.frames < target:
                self.write(self.previous)
                self.frames += 1


class Recorder:
    def __init__(self, source_factory, settings: RecordingSettings, canvas_folder: Path, description=None):
        self.source_factory = source_factory
        self.settings = settings.validate()
        self.canvas_folder = canvas_folder
        self.description = description or {}
        self.stop_event = threading.Event()
        self.pause_event = threading.Event()
        self.capture_done = threading.Event()
        self.encoder_done = threading.Event()
        self.queue = Queue(maxsize=3)
        self.lock = threading.Lock()
        self.clock = None
        self.writer = None
        self.duration = 0.0
        self.session = None
        self.output = None
        self.error = None
        self.encode_error = None
        self.preview = None
        self.stats = {'state': 'idle', 'captured': 0, 'encoded': 0, 'dropped': 0,
                      'missed_ticks': 0, 'read_errors': 0, 'read_ms': 0.0, 'duration': 0.0}
        self.thread = None

    def snapshot(self):
        with self.lock:
            stats = dict(self.stats)
        stats['duration'] = self.clock.elapsed() if self.clock and not self.finished else self.duration
        return stats

    @property
    def finished(self):
        return self.thread is not None and not self.thread.is_alive()

    def _set(self, **kwargs):
        with self.lock:
            self.stats.update(kwargs)

    def _increment(self, key, n=1):
        with self.lock:
            self.stats[key] += n

    def start(self):
        if self.thread is not None:
            raise RuntimeError('录制会话不能重复开始')
        self._set(state='starting')
        self.thread = threading.Thread(target=self._run, name='canvas-capture', daemon=True)
        self.thread.start()

    def pause(self):
        if self.clock and self.snapshot()['state'] == 'recording':
            self.clock.pause()
            self.pause_event.set()
            self._set(state='paused')

    def resume(self):
        if self.clock and self.pause_event.is_set():
            self.clock.resume()
            self.pause_event.clear()
            self._set(state='recording')

    def stop(self):
        self.stop_event.set()
        if self.clock:
            self.clock.pause()  # exclude shutdown/remux latency from recorded time

    def _enqueue(self, stamp, image):
        try:
            self.queue.put_nowait((stamp, image))
        except Full:
            try:
                self.queue.get_nowait()
                self._increment('dropped')
            except Empty:
                pass
            self.queue.put_nowait((stamp, image))

    def _encode(self):
        timeline = RealtimeTimeline(self.settings.fps, self.writer.write)
        try:
            while not self.capture_done.is_set() or not self.queue.empty():
                try:
                    stamp, image = self.queue.get(timeout=0.2)
                except Empty:
                    continue
                if self.settings.mode == 'realtime':
                    timeline.push(stamp, image)
                else:
                    self.writer.write(image)
                self._set(encoded=self.writer.frames)
            if self.settings.mode == 'realtime':
                timeline.finish(self.duration)
            self._set(encoded=self.writer.frames)
        except BaseException as exc:
            self.encode_error = exc
            self.stop()
        finally:
            try:
                self.writer.close()
            except BaseException as exc:
                self.encode_error = self.encode_error or exc
            self.encoder_done.set()

    def _manifest(self, state, **extra):
        if self.session:
            atomic_json(self.session / 'session.json', {
                'schema': 1, 'application': 'SAI2CanvasRecorder', 'state': state,
                'settings': asdict(self.settings), 'source': self.description,
                'statistics': self.snapshot(), **extra,
            })

    def _run(self):
        source = None
        encoder = None
        try:
            source = self.source_factory()
            started = time.monotonic()
            first = source.capture()
            geometry = output_geometry(first.shape[1], first.shape[0], self.settings.long_edge)
            first = fit_frame(first, geometry)
            name = datetime.now().strftime('%Y%m%d-%H%M%S') + '-' + uuid.uuid4().hex[:6]
            self.session = self.canvas_folder / SESSIONS_DIR / name
            self.session.mkdir(parents=True, exist_ok=False)
            self._set(size=geometry[1], content_size=geometry[0], read_ms=(time.monotonic()-started)*1000)
            self._manifest('starting')
            self.writer = FfmpegWriter(self.session, geometry[1], self.settings)
            self.clock = ActiveClock()
            self._enqueue(0.0, first)
            self.preview = first
            self._increment('captured')
            encoder = threading.Thread(target=self._encode, name='video-encoder', daemon=True)
            encoder.start()
            self._set(state='recording')
            interval = 1 / self.settings.fps if self.settings.mode == 'realtime' else self.settings.interval
            due = interval
            previous = first
            error_since = None
            last_manifest = time.monotonic()
            while not self.stop_event.is_set():
                if self.encode_error:
                    raise self.encode_error
                if self.writer.busy_since and time.monotonic() - self.writer.busy_since > 15:
                    self.writer.abort()
                    raise RuntimeError('编码器连续 15 秒无响应，已保留分段')
                if self.pause_event.is_set():
                    self.stop_event.wait(0.05)
                    continue
                remaining = due - self.clock.elapsed()
                if remaining > 0:
                    self.stop_event.wait(min(remaining, 0.05))
                    continue
                read_start = time.monotonic()
                try:
                    image = fit_frame(source.capture(), geometry)
                    error_since = None
                except MemoryReadError:
                    self._increment('read_errors')
                    error_since = error_since or time.monotonic()
                    if time.monotonic() - error_since > 2.0:
                        raise RuntimeError('画布连续 2 秒读取失败，请重新连接；已有视频已保留')
                    self.stop_event.wait(0.02)
                    continue
                stamp = self.clock.elapsed()
                self._set(read_ms=(time.monotonic()-read_start)*1000)
                # A pause/stop that happened during a read must not leak that frame into the clip.
                if self.pause_event.is_set() or self.stop_event.is_set():
                    continue
                self._increment('captured')
                if not (self.settings.mode == 'timelapse' and self.settings.skip_unchanged
                        and np.array_equal(previous, image)):
                    self._enqueue(stamp, image)
                    previous = image
                self.preview = image
                due += interval
                if stamp >= due:
                    missed = math.floor((stamp - due) / interval) + 1
                    due += missed * interval
                    self._increment('missed_ticks', missed)
                if time.monotonic() - last_manifest >= 5:
                    self._manifest('recording')
                    last_manifest = time.monotonic()
        except BaseException as exc:
            self.error = str(exc)
            logging.exception('录制会话失败')
            if self.session:
                try:
                    (self.session / 'error.txt').write_text(traceback.format_exc(), encoding='utf-8')
                except OSError:
                    logging.exception('无法写入会话错误记录')
        finally:
            if self.clock:
                self.clock.pause()
                self.duration = self.clock.elapsed()
            self._set(state='finalizing')
            self.capture_done.set()
            if source:
                try:
                    source.close()
                except Exception as exc:
                    self.error = self.error or str(exc)
                    logging.exception('无法关闭录制源')
            if encoder:
                # Watch the encoder during shutdown too; GUI remains responsive.
                while not self.encoder_done.wait(0.2):
                    if self.writer.busy_since and time.monotonic() - self.writer.busy_since > 15:
                        self.writer.abort()
                encoder.join()
            elif self.writer:
                try:
                    self.writer.close()
                except Exception as exc:
                    self.error = self.error or str(exc)
            if self.encode_error:
                self.error = self.error or str(self.encode_error)
            if self.session and self.writer and self.writer.frames:
                try:
                    self.output, _ = merge_parts(self.session, self.settings.container)
                except Exception as exc:
                    self.error = self.error or str(exc)
            self._set(state='error' if self.error else 'completed')
            try:
                self._manifest(self.stats['state'], error=self.error,
                               output=os.path.relpath(self.output, self.session) if self.output else None)
            except OSError as exc:
                self.error = self.error or f'无法写入会话记录：{exc}'
                self._set(state='error')
