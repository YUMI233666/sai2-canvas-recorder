from pathlib import Path
import os
import re
import shutil
import subprocess
import sys
import time
import uuid

from .canvas_output import session_output_directory


def ffmpeg_executable():
    explicit = os.environ.get('SAI2_FFMPEG_EXE')
    if explicit:
        path = Path(explicit)
        if not path.is_file():
            raise RuntimeError('SAI2_FFMPEG_EXE 指定的 FFmpeg 不存在')
        return str(path.resolve())
    try:
        import imageio_ffmpeg
    except ModuleNotFoundError as exc:
        if exc.name != 'imageio_ffmpeg':
            raise
        if getattr(sys, 'frozen', False):
            adjacent = Path(sys.executable).resolve().with_name('ffmpeg.exe')
            if adjacent.is_file():
                return str(adjacent)
        if executable := shutil.which('ffmpeg'):
            return executable
        raise RuntimeError('未找到 FFmpeg。请安装带 libx264 的 Windows 版 FFmpeg，'
                           '将 ffmpeg.exe 放到录制器同目录或加入 PATH。') from None
    return imageio_ffmpeg.get_ffmpeg_exe()


def subprocess_options():
    return {'creationflags': subprocess.CREATE_NO_WINDOW} if sys.platform == 'win32' else {}


class FfmpegWriter:
    def __init__(self, session: Path, size, settings):
        self.session = session
        self.size = size
        self.settings = settings
        self.frames = 0
        self.busy_since = None
        self.process = None
        (session / 'parts').mkdir()
        executable = ffmpeg_executable()
        self.log = (session / 'encoder.log').open('wb')
        cmd = [executable, '-hide_banner', '-loglevel', 'warning', '-nostdin',
               '-f', 'rawvideo', '-pixel_format', 'bgr24', '-video_size', f'{size[0]}x{size[1]}',
               '-framerate', str(settings.fps), '-i', 'pipe:0', '-an',
               '-c:v', 'libx264', '-preset', settings.preset, '-crf', str(settings.crf),
               '-pix_fmt', 'yuv420p', '-threads', '4', '-g', str(settings.fps * 2),
               '-force_key_frames', f'expr:gte(t,n_forced*{settings.segment_seconds})',
               '-f', 'segment', '-segment_time', str(settings.segment_seconds),
               '-reset_timestamps', '1', '-segment_format', 'matroska',
               '-segment_list', 'segments.csv', '-segment_list_type', 'csv',
               'parts/part-%05d.mkv']
        try:
            self.process = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                                            stderr=self.log, cwd=session, bufsize=0,
                                            **subprocess_options())
        except BaseException:
            self.log.close()
            raise

    def write(self, image):
        if image.shape != (self.size[1], self.size[0], 3):
            raise ValueError('编码画面尺寸与会话不一致')
        self.busy_since = time.monotonic()
        try:
            data = memoryview(image).cast('B')
            while data:
                written = self.process.stdin.write(data)
                if not written:
                    raise BrokenPipeError('FFmpeg 管道已关闭')
                data = data[written:]
            self.frames += 1
        except (OSError, ValueError) as exc:
            raise RuntimeError('视频编码失败，请查看会话中的 encoder.log') from exc
        finally:
            self.busy_since = None

    def abort(self):
        if self.process and self.process.poll() is None:
            self.process.kill()

    def close(self):
        try:
            if self.process.stdin and not self.process.stdin.closed:
                try:
                    self.process.stdin.close()
                except OSError:
                    pass
            try:
                code = self.process.wait(timeout=30)
            except subprocess.TimeoutExpired:
                self.abort()
                self.process.wait(timeout=5)
                raise RuntimeError('FFmpeg 收尾超时，已保留分段供恢复')
            if code:
                raise RuntimeError(f'FFmpeg 退出码 {code}，请查看 encoder.log')
        finally:
            self.log.close()


def merge_parts(session: Path, container='mp4', check_parts=False):
    """Remux closed segments; keep original segments and logs for recovery."""
    session = session.resolve()
    if container not in ('mp4', 'mkv'):
        raise ValueError('未知容器格式')
    parts = sorted(p for p in (session / 'parts').glob('part-*.mkv')
                   if re.fullmatch(r'part-\d{5,}\.mkv', p.name) and p.stat().st_size > 0)
    skipped = []
    ffmpeg = ffmpeg_executable()
    with (session / 'export.log').open('ab') as log:
        if check_parts:
            good = []
            for part in parts:
                result = subprocess.run([ffmpeg, '-v', 'error', '-xerror', '-nostdin',
                                         '-i', str(part), '-map', '0:v:0', '-f', 'null', '-'],
                                        stdout=subprocess.DEVNULL, stderr=log, timeout=300,
                                        **subprocess_options())
                (good if result.returncode == 0 else skipped).append(part)
            parts = good
        if not parts:
            raise RuntimeError('没有可导出的完整视频片段；请查看编码日志')
        playlist = session / 'concat.txt'
        playlist.write_text(''.join(f"file 'parts/{p.name}'\n" for p in parts), encoding='utf-8')
        directory = session_output_directory(session)
        name = session.name if directory != session else 'video'
        if check_parts:
            prefix = f'{name}-' if directory != session else ''
            name = f'{prefix}recovered-{time.strftime("%Y%m%d-%H%M%S")}'
        output = directory / f'{name}.{container}'
        if output.exists():
            output = directory / f'{name}-{uuid.uuid4().hex[:6]}.{container}'
        temporary = session / f'{output.stem}.partial{output.suffix}'
        cmd = [ffmpeg, '-v', 'warning', '-nostdin', '-n', '-f', 'concat', '-safe', '1',
               '-i', str(playlist), '-map', '0:v:0', '-c', 'copy', '-an']
        if container == 'mp4':
            cmd += ['-movflags', '+faststart']
        cmd += [str(temporary)]
        result = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=log,
                                timeout=300, **subprocess_options())
        if result.returncode or not temporary.exists() or not temporary.stat().st_size:
            raise RuntimeError('合并视频失败，原始分段已保留，请查看 export.log')
        temporary.replace(output)
    return output, [p.name for p in skipped]
