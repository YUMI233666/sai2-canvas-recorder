from dataclasses import asdict
import json
import logging
import os
from pathlib import Path
from queue import Empty, Queue
import threading
import tkinter as tk
from tkinter import filedialog

import cv2
from PIL import Image, ImageTk
import ttkbootstrap as ttk
from ttkbootstrap.dialogs import Querybox
from ttkbootstrap.widgets.scrolled import ScrolledFrame

from . import __version__
from .canvas_output import canvas_folders, create_canvas_folder
from .config import SAMPLE_INTERVAL_ERROR, RecordingSettings, data_directory, load_settings, save_settings
from .encoder import merge_parts
from .recording import Recorder
from .source import (SaiSource, SourceSpec, connect, executable_hash, running_sai2)
from .window_source import SaiWindowSource


MODES = {'实时录制（保留真实时长）': 'realtime', '延时录制（按间隔采样）': 'timelapse'}
CAPTURE_SOURCES = {'整画布（固定构图）': 'canvas', '笔画过程（SAI2 窗口）': 'window'}
CAPTURE_HINTS = {'canvas': '全画布 · 无界面、鼠标和音频', 'window': 'SAI2 窗口 · 含界面与视图变化 · 无音频'}
SIZES = {'1280': 1280, '1920': 1920, '2560': 2560, '3840': 3840, '采集原始尺寸': 0}
QUALITIES = {'极高 · CRF 16': 16, '高 · CRF 20': 20, '均衡 · CRF 24': 24, '小文件 · CRF 28': 28}
PRESETS = {'优先速度': 'ultrafast', '快速（推荐）': 'veryfast', '均衡': 'fast', '优先压缩': 'medium'}
STATES = {'idle': '就绪', 'starting': '正在准备', 'recording': '正在录制', 'paused': '已暂停',
          'finalizing': '正在收尾与导出', 'completed': '已完成', 'error': '已停止，请查看提示'}
PANEL_PADDING = 16
PREVIEW_SIZE = (450, 200)


def label_for(mapping, value):
    return next(k for k, v in mapping.items() if v == value)


class App(ttk.Window):
    def __init__(self):
        super().__init__(themename='darkly')
        self.title(f'SAI2 画布录制 · {__version__}')
        self.geometry('570x780')
        self.minsize(520, 420)
        self.messages = Queue()
        self.busy = False
        self.choosing_folder = False
        self.recorder = None
        self.reported_finished = False
        self.closing = False
        self.processes = []
        self.canvases = []
        self.profile = None
        self.connected_pid = None
        self.process_created = None
        self.last_error = None
        self.last_output_folder = None
        self.canvas_destinations = {}
        self.preview_identity = None
        self.param_widgets = []
        try:
            settings = load_settings()
        except Exception as exc:
            settings = RecordingSettings()
            self.last_error = f'设置加载失败，已使用默认值：{exc}'
        self.mode = tk.StringVar(value=label_for(MODES, settings.mode))
        self.capture_source = tk.StringVar(value=label_for(CAPTURE_SOURCES, settings.capture_source))
        self.size = tk.StringVar(value=label_for(SIZES, settings.long_edge))
        self.fps = tk.StringVar(value=str(settings.fps))
        self.saved_interval = settings.interval
        self.interval = tk.StringVar(value=str(settings.interval))
        self.quality = tk.StringVar(value=label_for(QUALITIES, settings.crf))
        self.preset = tk.StringVar(value=label_for(PRESETS, settings.preset))
        self.container = tk.StringVar(value=settings.container.upper())
        self.skip = tk.BooleanVar(value=settings.skip_unchanged)
        self.segment = settings.segment_seconds
        self.output_dir = tk.StringVar(value=settings.output_dir)
        self.topmost = tk.BooleanVar(value=False)
        self.status = tk.StringVar(value=self.last_error or '请打开 SAI2 和画布，再点击“连接画布”。')
        self.hint = tk.StringVar(value=CAPTURE_HINTS[settings.capture_source])
        self.metrics = tk.StringVar(value='尚未开始录制')
        self.destination = tk.StringVar(value='')
        self._build()
        self.protocol('WM_DELETE_WINDOW', self._close)
        self.bind('<F8>', lambda _: self._stop() if self._active() else self._start())
        self.after(100, self._poll)
        self._refresh_processes()

    def _build(self):
        main = ScrolledFrame(self, padding=PANEL_PADDING)
        main.pack(fill='both', expand=True)
        top = ttk.Frame(main)
        top.pack(fill='x')
        ttk.Label(top, text='画布录制', font=('Microsoft YaHei UI', 18, 'bold')).pack(side='left')
        ttk.Checkbutton(top, text='窗口置顶', variable=self.topmost,
                        command=lambda: self.attributes('-topmost', self.topmost.get())).pack(side='right')

        target = ttk.Labelframe(main, text=' 选择画布 ', padding=10)
        target.pack(fill='x', pady=(10, 0))
        row = ttk.Frame(target)
        row.pack(fill='x')
        self.process_box = ttk.Combobox(row, state='readonly')
        self.process_box.pack(side='left', fill='x', expand=True)
        self.process_box.bind('<<ComboboxSelected>>', self._process_selected)
        self.refresh_button = ttk.Button(row, text='刷新', command=self._refresh_processes, width=6)
        self.refresh_button.pack(side='left', padx=(6, 0))
        row = ttk.Frame(target)
        row.pack(fill='x', pady=(8, 0))
        self.connect_button = ttk.Button(row, text='连接画布', command=lambda: self._connect(False))
        self.connect_button.pack(side='left')
        self.discover_button = ttk.Button(row, text='识别此版本', command=lambda: self._connect(True), bootstyle='secondary')
        self.discover_button.pack(side='left', padx=8)
        self.canvas_box = ttk.Combobox(target, state='readonly')
        self.canvas_box.pack(fill='x', pady=(8, 0))
        self.canvas_box.bind('<<ComboboxSelected>>', lambda _: self._preview())

        preview = ttk.Frame(main, height=PREVIEW_SIZE[1])
        preview.pack(fill='x', pady=10)
        preview.pack_propagate(False)
        self.preview_label = ttk.Label(preview, text='连接后显示完整画布预览', anchor='center', bootstyle='secondary')
        self.preview_label.pack(fill='both', expand=True)

        params = ttk.Labelframe(main, text=' 下次录制参数 ', padding=10)
        params.pack(fill='x')
        params.columnconfigure(1, weight=1)
        params.columnconfigure(3, weight=1)

        def combo(label, variable, values, row, column):
            ttk.Label(params, text=label).grid(row=row, column=column, sticky='w', padx=(0, 6), pady=4)
            widget = ttk.Combobox(params, textvariable=variable, values=list(values), state='readonly', width=17)
            widget.grid(row=row, column=column+1, sticky='ew', padx=(0, 8), pady=4)
            self.param_widgets.append(widget)
            return widget

        source_box = combo('采集来源', self.capture_source, CAPTURE_SOURCES, 0, 0)
        source_box.grid(columnspan=3)
        self.mode_box = combo('模式', self.mode, MODES, 1, 0)
        self.mode_box.grid(columnspan=3)
        combo('输出长边', self.size, SIZES, 2, 0)
        combo('视频帧率', self.fps, ['15', '24', '30', '60'], 2, 2)
        combo('画质', self.quality, QUALITIES, 3, 0)
        combo('编码速度', self.preset, PRESETS, 3, 2)
        combo('视频格式', self.container, ['MP4', 'MKV'], 4, 0)
        ttk.Label(params, text='采样间隔 / 秒').grid(row=4, column=2, sticky='w', padx=(0, 6), pady=4)
        self.interval_entry = ttk.Entry(params, textvariable=self.interval, width=17)
        self.interval_entry.grid(row=4, column=3, sticky='ew', padx=(0, 8), pady=4)
        self.skip_check = ttk.Checkbutton(params, text='延时模式跳过静止画面', variable=self.skip)
        self.skip_check.grid(row=5, column=0, columnspan=4, sticky='w', pady=4)
        ttk.Label(params, text='帧率越高，对电脑性能要求越高；60 FPS 请先自行试录。',
                  bootstyle='secondary').grid(row=6, column=0, columnspan=4, sticky='w', pady=(2, 0))
        self.mode.trace_add('write', lambda *_: self._mode_changed())
        self.capture_source.trace_add('write', lambda *_: self.hint.set(
            CAPTURE_HINTS[CAPTURE_SOURCES[self.capture_source.get()]]))

        path_row = ttk.Frame(main)
        path_row.pack(fill='x', pady=(10, 4))
        ttk.Label(path_row, text='保存到').pack(side='left', padx=(0, 8))
        self.output_entry = ttk.Entry(path_row, textvariable=self.output_dir)
        self.output_entry.pack(side='left', fill='x', expand=True)
        self.browse_button = ttk.Button(path_row, text='选择', command=self._browse)
        self.browse_button.pack(side='left', padx=(6, 0))

        buttons = ttk.Frame(main)
        buttons.pack(fill='x', pady=10)
        self.start_button = ttk.Button(buttons, text='开始录制', command=self._start, bootstyle='success', width=14)
        self.start_button.pack(side='left', fill='x', expand=True)
        self.pause_button = ttk.Button(buttons, text='暂停', command=self._pause, state='disabled', width=9)
        self.pause_button.pack(side='left', padx=8)
        self.stop_button = ttk.Button(buttons, text='停止并导出', command=self._stop, state='disabled', bootstyle='danger')
        self.stop_button.pack(side='left', fill='x', expand=True)
        status = ttk.Label(main, textvariable=self.status)
        status.pack(anchor='w', fill='x')
        metrics = ttk.Label(main, textvariable=self.metrics, bootstyle='secondary')
        metrics.pack(anchor='w', pady=4)
        hint = ttk.Label(main, textvariable=self.hint, bootstyle='secondary')
        hint.pack(anchor='w')
        destination = ttk.Label(main, textvariable=self.destination, bootstyle='info')
        destination.pack(anchor='w', pady=4)

        wrap_width = 0

        def wrap_status(event):
            nonlocal wrap_width
            width = max(1, event.width - 2 * PANEL_PADDING)
            if width == wrap_width:
                return
            wrap_width = width
            for label in (status, metrics, hint, destination):
                label.configure(wraplength=width)

        main.bind('<Configure>', wrap_status, add='+')
        footer = ttk.Frame(main)
        footer.pack(fill='x', pady=(8, 0))
        self.folder_button = ttk.Button(footer, text='打开输出', command=self._open_output, bootstyle='link')
        self.folder_button.pack(side='left')
        self.recover_button = ttk.Button(footer, text='恢复分段', command=self._recover, bootstyle='link')
        self.recover_button.pack(side='left')
        self.diagnostic_button = ttk.Button(footer, text='保存诊断', command=self._diagnostic, bootstyle='link')
        self.diagnostic_button.pack(side='right')

        def scroll_over_combo(event):
            # Prevent Windows from changing a closed dropdown's selection on wheel input.
            first, last = main.yview()
            if first > 0 or last < 1:
                main.yview_scroll(-round(event.delta / 120))
            return 'break'

        for widget in (self.process_box, self.canvas_box, *self.param_widgets):
            widget.bind('<MouseWheel>', scroll_over_combo)
        main.enable_scrolling()
        self._mode_changed()

    def _active(self):
        return self.recorder is not None and not self.recorder.finished

    def _run_task(self, action, callback):
        if self.closing or self.busy or self._active():
            return
        self.busy = True
        self._controls()
        def worker():
            try:
                self.messages.put(('result', callback, action()))
            except Exception as exc:
                logging.exception('后台操作失败')
                self.messages.put(('error', str(exc)))
        threading.Thread(target=worker, name='recorder-ui-task', daemon=True).start()

    def _refresh_processes(self):
        def result(items):
            self.processes = items
            self.process_box['values'] = [f"SAI2 · PID {p['pid']} · {Path(p['exe']).parent.name}" for p in items]
            self._process_selected()
            if len(items) == 1:
                self.process_box.current(0)
                self.status.set('已找到 SAI2，请点击“连接画布”。')
            else:
                self.process_box.set('')
                self.status.set('请选择要连接的 SAI2 进程。' if items else '没有找到 SAI2，请打开后刷新。')
        self._run_task(running_sai2, result)

    def _process_selected(self, *_):
        self.canvas_destinations.clear()
        self.profile = None
        self.connected_pid = None
        self.canvases = []
        self.canvas_box['values'] = []
        self.canvas_box.set('')
        self.preview_label.configure(image='', text='连接后显示完整画布预览')
        self.preview_identity = None

    def _connect(self, discover):
        index = self.process_box.current()
        if not 0 <= index < len(self.processes):
            self.status.set('请先选择一个 SAI2 进程。')
            return
        pid = self.processes[index]['pid']
        self._process_selected()
        self.status.set('正在只读识别此版本，请保持至少一张画布打开。' if discover else '正在连接画布……')
        def progress(text):
            self.messages.put(('status', text))
        def result(value):
            self.profile, self.canvases, self.process_created = value
            self.connected_pid = pid
            self.canvas_box['values'] = [c.label for c in self.canvases]
            suffix = ' · 本机识别结果，尚需手动验收' if self.profile.origin == 'local-discovery' else ''
            if self.profile.origin == 'recorder-20230405':
                suffix = ' · 2023.04.05 专版'
            self.status.set(f'已连接，找到 {len(self.canvases)} 张画布{suffix}')
            if self.canvases:
                self.canvas_box.current(0)
                self.after(0, self._preview)
            else:
                self.status.set('请在 SAI2 中打开画布，再点击“连接画布”。')
        self._run_task(lambda: connect(pid, discover, progress), result)

    def _spec(self):
        index = self.canvas_box.current()
        if self.profile is None or not 0 <= index < len(self.canvases):
            raise ValueError('请先连接并选择画布')
        return SourceSpec(self.connected_pid, self.process_created, self.profile, self.canvases[index])

    def _preview(self):
        if self.closing:
            return
        try:
            spec = self._spec()
        except ValueError:
            return
        def action():
            source = SaiSource(spec)
            try:
                return source.capture()
            finally:
                source.close()
        self._run_task(action, self._show_image)

    def _show_image(self, image):
        rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        preview = Image.fromarray(rgb)
        preview.thumbnail(PREVIEW_SIZE)
        self.photo = ImageTk.PhotoImage(preview, master=self)
        self.preview_label.configure(image=self.photo, text='')

    def _settings(self):
        mode = MODES[self.mode.get()]
        interval = self.saved_interval
        if mode == 'timelapse':
            try:
                interval = float(self.interval.get())
            except ValueError:
                raise ValueError(SAMPLE_INTERVAL_ERROR) from None
        return RecordingSettings(mode=mode, fps=int(self.fps.get()),
                                 capture_source=CAPTURE_SOURCES[self.capture_source.get()],
                                 interval=interval, long_edge=SIZES[self.size.get()],
                                 crf=QUALITIES[self.quality.get()], preset=PRESETS[self.preset.get()],
                                 container=self.container.get().lower(), output_dir=self.output_dir.get(),
                                 skip_unchanged=self.skip.get(), segment_seconds=self.segment).validate()

    def _select_canvas_folder(self, root, canvas):
        folders = canvas_folders(root, canvas.name, canvas.width, canvas.height)
        key = (root, canvas)
        previous = self.canvas_destinations.get(key)
        if previous is not None and any(path == previous for path, _ in folders):
            return previous
        if folders:
            new = '新建画布目录'
            choices = {path.name: path for path, _ in folders}
            matched = [path.name for path, match in folders if match]
            self.choosing_folder = True
            try:
                choice = Querybox.get_item(
                    prompt=f'当前画布：{canvas.label}\n请选择已有目录，或新建画布目录。',
                    title='选择画布输出目录', initialvalue=matched[0] if len(matched) == 1 else new,
                    items=[new, *choices], parent=self)
            finally:
                self.choosing_folder = False
            if choice is None:
                return None
            if choice in choices:
                return choices[choice]
            if choice != new:
                return None
        return create_canvas_folder(root, canvas.name, canvas.width, canvas.height)

    def _start(self):
        if self.closing or self.busy or self.choosing_folder or self._active():
            return
        try:
            spec = self._spec()
            settings = self._settings()
            root = Path(settings.output_dir).expanduser().resolve()
            folder = self._select_canvas_folder(root, spec.canvas)
            if folder is None:
                return
            save_settings(settings)
            self.saved_interval = settings.interval
            def open_source():
                if settings.capture_source == 'window':
                    return SaiWindowSource(spec.pid, spec.process_created)
                return SaiSource(spec)

            self.recorder = Recorder(open_source, settings, folder,
                                     {'profile': asdict(spec.profile), 'canvas': asdict(spec.canvas)})
            self.reported_finished = False
            self.destination.set(str(folder))
            self.last_error = None
            self.recorder.start()
            self.canvas_destinations[(root, spec.canvas)] = folder
            self._controls()
        except Exception as exc:
            self.last_error = str(exc)
            self.status.set(str(exc))

    def _pause(self):
        if self._active():
            if self.recorder.pause_event.is_set():
                self.recorder.resume()
            else:
                self.recorder.pause()

    def _stop(self):
        if self._active():
            self.recorder.stop()
            self.stop_button.configure(state='disabled')
            self.pause_button.configure(state='disabled')
            self.status.set('正在停止采集并导出视频，请稍候……')

    def _mode_changed(self):
        active = self._active() or self.busy
        enabled = MODES[self.mode.get()] == 'timelapse' and not active
        self.interval_entry.configure(state='normal' if enabled else 'disabled')
        self.skip_check.configure(state='normal' if enabled else 'disabled')

    def _controls(self):
        active = self._active()
        locked = active or self.busy
        for widget in self.param_widgets:
            widget.configure(state='disabled' if locked else 'readonly')
        for widget in (self.process_box, self.canvas_box):
            widget.configure(state='disabled' if locked else 'readonly')
        for widget in (self.refresh_button, self.connect_button, self.discover_button,
                       self.browse_button, self.recover_button, self.diagnostic_button):
            widget.configure(state='disabled' if locked else 'normal')
        self.output_entry.configure(state='disabled' if locked else 'normal')
        self.start_button.configure(state='disabled' if locked else 'normal')
        stopping = active and self.recorder.stop_event.is_set()
        self.stop_button.configure(state='normal' if active and not stopping else 'disabled')
        ready = active and self.recorder.snapshot()['state'] in ('recording', 'paused') and not stopping
        self.pause_button.configure(state='normal' if ready else 'disabled')
        self._mode_changed()

    def _poll(self):
        try:
            self._poll_once()
        except Exception as exc:
            self.report_callback_exception(type(exc), exc, exc.__traceback__)
        try:
            if self.winfo_exists():
                window_active = self._active() and self.recorder.settings.capture_source == 'window'
                self.after(100 if window_active else 250, self._poll)
        except tk.TclError:
            pass  # the root was destroyed after completing shutdown

    def _poll_once(self):
        try:
            while True:
                item = self.messages.get_nowait()
                if item[0] == 'result':
                    self.busy = False
                    item[1](item[2])
                    self._controls()
                elif item[0] == 'error':
                    self.busy = False
                    self.last_error = item[1]
                    self.status.set(item[1])
                    self._controls()
                elif item[0] == 'status':
                    self.status.set(item[1])
        except Empty:
            pass
        if self.recorder:
            s = self.recorder.snapshot()
            if not self.reported_finished:
                self.status.set(STATES[s['state']])
                active_fps = s['captured'] / max(s['duration'], 0.01)
                self.metrics.set(f"有效时长 {s['duration']:.1f} 秒 · 已写入 {s['encoded']} 帧\n"
                                 f"平均采样 {active_fps:.1f} 次/秒 · 跳过 {s['dropped'] + s['missed_ticks']} 次 · "
                                 f"读取 {s['read_ms']:.1f} ms · 读取失败 {s['read_errors']} 次")
                self.pause_button.configure(text='继续' if self.recorder.pause_event.is_set() else '暂停')
                if self.recorder.preview is not None and self.preview_identity is not self.recorder.preview:
                    self.preview_identity = self.recorder.preview
                    self._show_image(self.preview_identity)
                self._controls()
            if self.recorder.finished and not self.reported_finished:
                self.reported_finished = True
                self.last_output_folder = self.recorder.canvas_folder
                self.last_error = self.recorder.error
                self.status.set(self.recorder.error or '录制完成，视频已导出。')
                self.destination.set(str(self.recorder.output or self.recorder.session or ''))
                self._controls()
        if self.closing and not self._active() and not self.busy:
            self.destroy()
            return

    def _browse(self):
        path = filedialog.askdirectory(title='选择视频保存文件夹', parent=self)
        if path:
            self.output_dir.set(path)

    def _open_output(self):
        path = (self.recorder.canvas_folder if self._active() else self.last_output_folder)
        path = path or Path(self.output_dir.get()).expanduser()
        if path.is_dir():
            os.startfile(str(path))
        else:
            self.status.set('输出文件夹尚未创建，开始录制后会自动创建。')

    def _recover(self):
        directory = filedialog.askdirectory(title='选择包含 session.json 和 parts 的录制会话文件夹',
                                            initialdir=self.last_output_folder or self.output_dir.get(), parent=self)
        if not directory:
            return
        session = Path(directory)
        try:
            meta = json.loads((session / 'session.json').read_text(encoding='utf-8'))
            if meta.get('application') != 'SAI2CanvasRecorder':
                raise ValueError('不是本工具创建的录制会话')
            container = meta['settings']['container']
        except Exception as exc:
            self.status.set(f'无法恢复：{exc}')
            return
        self.status.set('正在检查并恢复分段，请稍候……')
        def complete(result):
            output, skipped = result
            self.last_output_folder = output.parent
            self.destination.set(str(output))
            self.status.set(f'恢复完成；跳过 {len(skipped)} 个无法解码的分段。')
        self._run_task(lambda: merge_parts(session, container, check_parts=True), complete)

    def _diagnostic(self):
        path = filedialog.asksaveasfilename(title='保存诊断信息', defaultextension='.json',
                                          initialfile='sai2-recorder-diagnostic.json', parent=self)
        if not path:
            return
        result = {'recorder_version': __version__, 'profile': asdict(self.profile) if self.profile else None,
                  'pid': self.connected_pid, 'error': self.last_error,
                  'canvas_sizes': [(c.width, c.height) for c in self.canvases],
                  'statistics': self.recorder.snapshot() if self.recorder else None}
        index = self.process_box.current()
        if 0 <= index < len(self.processes):
            result['selected_process'] = self.processes[index]
            try:
                result['executable_md5'] = executable_hash(self.processes[index]['exe'])
            except OSError as exc:
                result['fingerprint_error'] = str(exc)
        try:
            Path(path).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
            self.status.set('诊断已保存。该文件不包含画布图像或内存转储。')
        except OSError as exc:
            self.status.set(f'无法保存诊断：{exc}')

    def _close(self):
        if self._active():
            self.closing = True
            self._stop()
            self.status.set('正在结束录制，导出完成后关闭窗口……')
        elif self.busy:
            self.closing = True
            self.status.set('后台操作完成后将关闭窗口……')
        else:
            self.destroy()

    def report_callback_exception(self, kind, value, tb):
        logging.error('界面操作失败', exc_info=(kind, value, tb))
        self.last_error = str(value)
        self.status.set(f'操作失败：{value}；详细信息见 recorder.log')


def main():
    directory = data_directory()
    directory.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(filename=directory / 'recorder.log', encoding='utf-8', level=logging.INFO,
                        format='%(asctime)s %(levelname)s %(message)s', force=True)
    try:
        App().mainloop()
    except Exception:
        logging.exception('录制器界面异常')
        raise


if __name__ == '__main__':
    main()
