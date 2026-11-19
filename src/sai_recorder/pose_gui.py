"""Launcher for the independent 3D pose workspace."""
from pathlib import Path
import subprocess
import sys
from tkinter import messagebox

import ttkbootstrap as ttk


def _pose_host():
    directory = Path(sys.executable).parent if getattr(sys, 'frozen', False) else (
        Path(__file__).resolve().parents[2] / 'build')
    return directory / 'pose-studio' / 'SAI2PoseStudio.exe'


class PosePanel(ttk.Frame):
    def __init__(self, parent):
        super().__init__(parent, padding=16)
        self.pose = None
        ttk.Button(self, text='打开 3D 人偶', command=self.open_pose, bootstyle='primary').pack(anchor='w')

    def open_pose(self):
        executable = _pose_host()
        if self.pose is not None and self.pose.poll() is None:
            return
        try:
            self.pose = subprocess.Popen([str(executable)], cwd=executable.parent)
        except OSError:
            messagebox.showerror('3D 人偶', '未找到或无法启动 3D 组件。请使用完整的 Windows 发行包。',
                                 parent=self.winfo_toplevel())
