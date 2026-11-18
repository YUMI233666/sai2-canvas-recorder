"""Small Windows process reader. Opens handles with QUERY_INFORMATION | VM_READ only."""
import ctypes as C
from ctypes import wintypes as W
from pathlib import Path
import struct
import sys

import psutil


class MemoryReadError(RuntimeError):
    pass


class ReadOnlyProcess:
    def __init__(self, pid: int):
        if sys.platform != 'win32' or C.sizeof(C.c_void_p) != 8:
            raise RuntimeError('此录制器需要 64 位 Windows 和 64 位 Python')
        self.pid = pid
        self.process = psutil.Process(pid)
        self.created = self.process.create_time()
        self.exe = Path(self.process.exe())
        self.k32 = C.WinDLL('kernel32', use_last_error=True)
        self.k32.OpenProcess.argtypes = (W.DWORD, W.BOOL, W.DWORD)
        self.k32.OpenProcess.restype = W.HANDLE
        self.k32.ReadProcessMemory.argtypes = (W.HANDLE, C.c_void_p, C.c_void_p,
                                               C.c_size_t, C.POINTER(C.c_size_t))
        self.k32.ReadProcessMemory.restype = W.BOOL
        self.k32.CloseHandle.argtypes = (W.HANDLE,)
        self.k32.CloseHandle.restype = W.BOOL
        self.handle = self.k32.OpenProcess(0x0400 | 0x0010, False, pid)
        if not self.handle:
            raise MemoryReadError(f'无法只读连接 SAI2：{C.WinError(C.get_last_error())}')
        try:
            self.base = self._module_base()
        except BaseException:
            self.close()
            raise

    def _module_base(self):
        psapi = C.WinDLL('psapi', use_last_error=True)
        psapi.EnumProcessModulesEx.argtypes = (W.HANDLE, C.POINTER(W.HMODULE),
                                               W.DWORD, C.POINTER(W.DWORD), W.DWORD)
        psapi.EnumProcessModulesEx.restype = W.BOOL
        modules = (W.HMODULE * 1024)()
        needed = W.DWORD()
        if not psapi.EnumProcessModulesEx(self.handle, modules, C.sizeof(modules),
                                          C.byref(needed), 0x03) or not needed.value:
            raise MemoryReadError('无法获取 SAI2 主模块')
        return modules[0]

    def alive(self):
        try:
            return (self.process.is_running() and
                    self.process.create_time() == self.created)
        except psutil.Error:
            return False

    def read_into(self, address: int, target, size: int):
        if not self.handle or not 0x10000 <= address < 0x0000800000000000:
            raise MemoryReadError('画布数据指针无效')
        if not 0 < size <= 512 * 1024 * 1024:
            raise MemoryReadError('画布读取大小超过限制')
        count = C.c_size_t()
        ok = self.k32.ReadProcessMemory(self.handle, address, target, size, C.byref(count))
        if not ok or count.value != size:
            raise MemoryReadError(f'画布内存读取失败（{count.value}/{size} 字节）')

    def read(self, address: int, size: int) -> bytes:
        if not 0 < size <= 512 * 1024 * 1024:
            raise MemoryReadError('画布读取大小超过限制')
        result = C.create_string_buffer(size)
        self.read_into(address, result, size)
        return result.raw

    def pointer(self, address: int) -> int:
        return struct.unpack('<Q', self.read(address, 8))[0]

    def structure(self, address, kind):
        return kind.from_buffer_copy(self.read(address, C.sizeof(kind)))

    def writable_sections(self):
        """Return initialized PE data sections only, excluding executable code."""
        data = self.exe.read_bytes()
        pe = struct.unpack_from('<I', data, 0x3c)[0]
        if data[pe:pe+4] != b'PE\0\0':
            raise MemoryReadError('不是有效的 Windows 程序')
        machine, count = struct.unpack_from('<HH', data, pe + 4)
        if machine != 0x8664:
            raise MemoryReadError('此版本只支持 64 位 SAI2')
        optional_size = struct.unpack_from('<H', data, pe + 20)[0]
        for i in range(count):
            pos = pe + 24 + optional_size + i * 40
            name = data[pos:pos+8].rstrip(b'\0').decode('ascii', errors='replace')
            size, rva = struct.unpack_from('<II', data, pos + 8)
            flags = struct.unpack_from('<I', data, pos + 36)[0]
            if flags & 0x80000000 and not flags & 0x20000000 and name in ('.data', '.bss'):
                yield rva, min(size, 16 * 1024 * 1024)

    def close(self):
        if getattr(self, 'handle', None):
            self.k32.CloseHandle(self.handle)
            self.handle = None

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
