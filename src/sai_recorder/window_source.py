from ctypes import WinDLL, WINFUNCTYPE, POINTER, byref, wintypes
import threading

import cv2
import psutil


class SaiWindowSource:
    """Sample the latest composited SAI2 window frame independently of the canvas reader."""

    def __init__(self, pid: int, process_created: float):
        try:
            from windows_capture import WindowsCapture
        except ImportError as exc:
            raise RuntimeError('窗口采集组件不可用，请使用完整的 Windows 发行包。') from exc

        try:
            if psutil.Process(pid).create_time() != process_created:
                raise RuntimeError('SAI2 进程已变化，请刷新并重新选择进程。')
        except psutil.Error as exc:
            raise RuntimeError('无法找到原 SAI2 进程，请刷新并重新选择进程。') from exc

        user32 = WinDLL('user32', use_last_error=True)
        self._is_minimized = user32.IsIconic
        self._is_minimized.argtypes = (wintypes.HWND,)
        self._is_minimized.restype = wintypes.BOOL
        self._hwnd = _find_main_window(user32, pid, self._is_minimized)
        self._ready = threading.Event()
        self._lock = threading.Lock()
        self._latest = None
        self._failure = None
        self._capture = None

        try:
            self._capture = WindowsCapture(window_hwnd=self._hwnd, cursor_capture=False)

            @self._capture.event
            def on_frame_arrived(frame, control):
                with self._lock:
                    previous = self._latest
                try:
                    if previous is not None and frame.frame_buffer.shape[:2] != previous.shape[:2]:
                        raise RuntimeError('SAI2 窗口尺寸已改变，请在新尺寸下重新开始录制。')
                    # Release the native mapped frame after the callback, not on the encoder thread.
                    image = cv2.cvtColor(frame.frame_buffer, cv2.COLOR_BGRA2BGR)
                    with self._lock:
                        self._latest = image
                    self._ready.set()
                except Exception as exc:
                    self._fail(str(exc))
                    control.stop()

            @self._capture.event
            def on_closed():
                self._fail('SAI2 窗口采集已结束，请重新打开或选择窗口后再录制。')

            self._control = self._capture.start_free_threaded()
        except Exception as exc:
            self._release_callbacks()
            raise RuntimeError(f'无法启动 SAI2 窗口采集：{exc}') from exc

    def _fail(self, message):
        with self._lock:
            self._failure = self._failure or message
        self._ready.set()

    def capture(self):
        self._ready.wait(3)
        with self._lock:
            image, failure = self._latest, self._failure
        if failure:
            raise RuntimeError(failure)
        if self._is_minimized(self._hwnd):
            raise RuntimeError('SAI2 窗口已最小化，请还原窗口后再录制。')
        if image is None or self._control.is_finished():
            raise RuntimeError('未收到 SAI2 窗口画面，请保持窗口可见并重新开始录制。')
        return image

    def close(self):
        try:
            if self._control.is_finished():
                self._control.wait()
            else:
                self._control.stop()
        finally:
            self._release_callbacks()
            with self._lock:
                self._latest = None

    def _release_callbacks(self):
        if self._capture is not None:
            self._capture.frame_handler = None
            self._capture.closed_handler = None
            self._capture = None


def _find_main_window(user32, pid, is_minimized):
    callback_type = WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    user32.EnumWindows.argtypes = (callback_type, wintypes.LPARAM)
    user32.EnumWindows.restype = wintypes.BOOL
    user32.GetWindowThreadProcessId.argtypes = (wintypes.HWND, POINTER(wintypes.DWORD))
    user32.GetWindowThreadProcessId.restype = wintypes.DWORD
    user32.IsWindowVisible.argtypes = (wintypes.HWND,)
    user32.IsWindowVisible.restype = wintypes.BOOL
    user32.GetWindowTextLengthW.argtypes = (wintypes.HWND,)
    user32.GetWindowTextLengthW.restype = wintypes.INT
    user32.GetWindow.argtypes = (wintypes.HWND, wintypes.UINT)
    user32.GetWindow.restype = wintypes.HWND
    user32.GetClientRect.argtypes = (wintypes.HWND, POINTER(wintypes.RECT))
    user32.GetClientRect.restype = wintypes.BOOL
    candidates = []

    @callback_type
    def visit(hwnd, _):
        owner_pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, byref(owner_pid))
        if (owner_pid.value == pid and user32.IsWindowVisible(hwnd) and not is_minimized(hwnd)
                and not user32.GetWindow(hwnd, 4) and user32.GetWindowTextLengthW(hwnd) > 0):  # GW_OWNER
            rect = wintypes.RECT()
            if user32.GetClientRect(hwnd, byref(rect)) and rect.right > 0 and rect.bottom > 0:
                candidates.append((rect.right * rect.bottom, hwnd))
        return True

    if not user32.EnumWindows(visit, 0) or not candidates:
        raise RuntimeError('找不到可录制的 SAI2 主窗口，请先打开或还原窗口。')
    return max(candidates, key=lambda candidate: candidate[0])[1]
