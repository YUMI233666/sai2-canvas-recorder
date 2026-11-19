"""Strict SAI2 reader, reusing upstream art-timelapse's reverse-engineered layouts.

No injection, writes, hooks, license access or executable modification are used.
Unrecognized executables require a user-initiated, bounded data-section discovery.
"""
import ctypes
from dataclasses import asdict, dataclass
import hashlib
import json
import math
from pathlib import Path
import struct
import uuid

import numpy as np
import psutil

from art_timelapse import sai
from .config import atomic_json, data_directory
from .memory import MemoryReadError, ReadOnlyProcess


class UnsupportedVersion(RuntimeError):
    pass


class CanvasUnavailable(RuntimeError):
    pass


class CanvasSizeChanged(RuntimeError):
    pass


TILE_MAP = sai.SAIv2_API_Base.SAICanvasTileMap
MAX_PIXELS = 64_000_000
LAYOUT_20230405 = 'sai2-20230405-user-list'


class SAI20230405Canvas(sai.SAIv2CanvasBase):
    pass


SAI20230405Canvas._fields_ = sai.offset_fields([
    # This build walks the user list from its tail, following the previous user node.
    (0x010, 'next_canvas', sai.RPOINTER(SAI20230405Canvas)),
    (0x020, 'id', ctypes.c_int32),
    (0x028, 'tile_maps', sai.RPOINTER(sai.RPOINTER(TILE_MAP)) * sai.SAIv2_API_Base.map_count),
    (0x250, 'width', ctypes.c_int32),
    (0x254, 'height', ctypes.c_int32),
    (0x2ac, 'name', ctypes.c_uint16 * 0x100),
])
DISCOVERY_LAYOUTS = {
    'sai2-legacy': sai.SAIv2_API_Base.SAICanvas,
    'sai2-20261019': sai.SAIv2_API_2026_10_19_alpha.SAICanvas,
}
LAYOUTS = {**DISCOVERY_LAYOUTS, LAYOUT_20230405: SAI20230405Canvas}


@dataclass(frozen=True)
class Profile:
    exe_hash: str
    version_name: str
    session_offset: int
    layout: str = 'sai2-legacy'
    origin: str = 'upstream'


# The exact executable's user-canvas lookup at RVA 0x1f140 loads this global.
PROFILE_20230405 = Profile(
    '9da34848ba9e6993a40262b462e0445d', 'SAI Ver.2 (64bit) Preview.2023.04.05',
    0x319f30, LAYOUT_20230405, 'recorder-20230405',
)


@dataclass(frozen=True)
class Canvas:
    address: int
    identity: int
    name: str
    width: int
    height: int

    @property
    def label(self):
        return f'{self.name}  ·  {self.width} × {self.height}'


def running_sai2():
    result = []
    for p in psutil.process_iter(['pid', 'name', 'exe']):
        try:
            if p.info['name'].lower() == 'sai2.exe':
                result.append({'pid': p.pid, 'exe': p.info['exe']})
        except (psutil.Error, AttributeError):
            continue
    return sorted(result, key=lambda p: p['pid'])


def executable_hash(path):
    with open(path, 'rb') as stream:
        return hashlib.file_digest(stream, 'md5').hexdigest()


def known_profile(fingerprint):
    if fingerprint == PROFILE_20230405.exe_hash:
        return PROFILE_20230405
    api = sai.get_sai_api(fingerprint)
    if api is not None and issubclass(api, sai.SAIv2_API_Base):
        layout = 'sai2-20261019' if api is sai.SAIv2_API_2026_10_19_alpha else 'sai2-legacy'
        return Profile(fingerprint, api.version_name, api.session_offset, layout)
    path = data_directory() / 'recorder-profiles.json'
    if path.exists():
        raw = json.loads(path.read_text(encoding='utf-8'))
        if fingerprint in raw:
            p = Profile(**raw[fingerprint])
            if (p.exe_hash != fingerprint or p.layout not in DISCOVERY_LAYOUTS or
                    not 0 < p.session_offset < 0x40000000):
                raise UnsupportedVersion('本地适配配置无效，请重新识别')
            return p
    return None


def save_profile(profile):
    path = data_directory() / 'recorder-profiles.json'
    try:
        data = json.loads(path.read_text(encoding='utf-8')) if path.exists() else {}
        if not isinstance(data, dict):
            raise ValueError('配置不是对象')
    except (ValueError, UnicodeError):
        backup = path.with_name(path.name + '.invalid-' + uuid.uuid4().hex[:6])
        backup.write_bytes(path.read_bytes())
        data = {}
    data[profile.exe_hash] = asdict(profile)
    atomic_json(path, data)


class CanvasReader:
    def __init__(self, process: ReadOnlyProcess, profile: Profile):
        if profile.layout not in LAYOUTS:
            raise UnsupportedVersion('不支持的画布结构')
        self.process = process
        self.profile = profile
        self.kind = LAYOUTS[profile.layout]
        self.tile = np.empty((256, 256, 4), np.uint8)
        self.image = None

    def _canvas(self, address):
        return self.process.structure(address, self.kind)

    @staticmethod
    def _valid_dimensions(width, height):
        if not (1 <= width <= 65536 and 1 <= height <= 65536 and
                width * height <= MAX_PIXELS):
            raise MemoryReadError('画布尺寸无效或超过 6400 万像素限制')

    def list_canvases(self):
        if not self.process.alive():
            raise CanvasUnavailable('SAI2 已退出')
        head = self.process.pointer(self.process.base + self.profile.session_offset)
        if not head:
            return []
        if self.profile.layout == LAYOUT_20230405:
            address, seen = head, set()
        else:
            address, seen = self.process.pointer(head), {head}  # skip the upstream sentinel
        canvases = []
        while address:
            if address in seen or len(canvases) >= 256:
                raise MemoryReadError('画布链表异常，请重新连接')
            seen.add(address)
            raw = self._canvas(address)
            self._valid_dimensions(raw.width, raw.height)
            name = raw.get_name()
            if not name or not name.isprintable():
                raise MemoryReadError('画布名称无效，请重新识别版本')
            identity = int(raw.id) if hasattr(raw, 'id') else address
            canvases.append(Canvas(address, identity, name, raw.width, raw.height))
            address = raw.next_canvas.value
        return canvases

    def _tile_map(self, raw):
        # Full-resolution composite avoids depending on mip-level refresh behavior.
        map_ptr = self.process.pointer(raw.tile_maps[0].value)
        tile_map = self.process.structure(map_ptr, TILE_MAP)
        self._valid_dimensions(tile_map.width, tile_map.height)
        if (tile_map.width, tile_map.height) != (raw.width, raw.height):
            raise MemoryReadError('画布合成图尚未就绪或版本结构不匹配')
        if (tile_map.count_x, tile_map.count_y) != (
                math.ceil(raw.width / 256), math.ceil(raw.height / 256)):
            raise MemoryReadError('画布分块结构无效')
        return map_ptr, tile_map

    def validate_canvas(self, canvas):
        raw = self._canvas(canvas.address)
        _, tile_map = self._tile_map(raw)
        row = self.process.pointer(tile_map.tree.value)
        tile = self.process.pointer(row)
        self.process.read(tile, 16)

    def capture(self, selected: Canvas):
        current = next((c for c in self.list_canvases()
                        if c.address == selected.address and c.identity == selected.identity), None)
        if current is None:
            raise CanvasUnavailable('目标画布已关闭，录制已停止')
        if (current.width, current.height) != (selected.width, selected.height):
            raise CanvasSizeChanged('画布像素尺寸已改变；已结束本次录制，请重新开始')
        raw = self._canvas(selected.address)
        map_ptr, tile_map = self._tile_map(raw)
        shape = (tile_map.count_y * 256, tile_map.count_x * 256, 4)
        if self.image is None or self.image.shape != shape:
            self.image = np.empty(shape, np.uint8)
        rows = struct.unpack('<' + 'Q' * tile_map.count_y,
                             self.process.read(tile_map.tree.value, tile_map.count_y * 8))
        for y, row_ptr in enumerate(rows):
            tiles = struct.unpack('<' + 'Q' * tile_map.count_x,
                                  self.process.read(row_ptr, tile_map.count_x * 8))
            for x, tile_ptr in enumerate(tiles):
                self.process.read_into(tile_ptr, self.tile.ctypes.data, self.tile.nbytes)
                self.image[y*256:(y+1)*256, x*256:(x+1)*256] = self.tile
        # Reject reallocated/resized composites rather than encode an old buffer as a new frame.
        after = self._canvas(selected.address)
        after_ptr, after_map = self._tile_map(after)
        if (after.width, after.height) != (selected.width, selected.height):
            raise CanvasSizeChanged('画布像素尺寸已改变，录制已停止')
        if after_ptr != map_ptr or bytes(after_map) != bytes(tile_map):
            raise MemoryReadError('画布合成图正在重建，将重新采样')
        return np.ascontiguousarray(self.image[:selected.height, :selected.width, :3])


def discover_profile(process, fingerprint, progress=None):
    """Experimental, read-only discovery. Never accept ambiguous pointer candidates.

    Only inspect static pointers in the executable's .data/.bss, then validate
    sentinel -> named canvas -> dimensions -> tile map -> pixel block.
    This is deliberately not a general heap scan or a silent version override.
    """
    candidates = {}
    for rva, size in process.writable_sections():
        if progress:
            progress(f'正在只读识别画布结构：数据区 +0x{rva:x}')
        block = process.read(process.base + rva, size)
        for index in range(0, len(block) - 7, 8):
            head = struct.unpack_from('<Q', block, index)[0]
            if not 0x10000 <= head < 0x0000800000000000 or head % 8:
                continue
            try:
                first = process.pointer(head)
                if not first or first == head or first % 8:
                    continue
            except MemoryReadError:
                continue
            for layout, kind in DISCOVERY_LAYOUTS.items():
                try:
                    sentinel = process.structure(head, kind)
                    # A user-canvas predecessor is not a stable session-list root.
                    if sentinel.width != 0 or sentinel.height != 0:
                        continue
                    raw = process.structure(first, kind)
                    CanvasReader._valid_dimensions(raw.width, raw.height)
                    name = raw.get_name()
                    if not name or not name.isprintable():
                        continue
                    profile = Profile(fingerprint, '本机自动识别（待手动验收）', rva + index,
                                      layout, 'local-discovery')
                    reader = CanvasReader(process, profile)
                    canvases = reader.list_canvases()
                    if not canvases:
                        continue
                    for canvas in canvases:
                        reader.validate_canvas(canvas)
                    candidates[(head, layout)] = profile
                except (MemoryReadError, UnicodeError, ValueError):
                    continue
    if len(candidates) != 1:
        if not candidates:
            raise UnsupportedVersion('未能识别此 SAI2 的画布结构。请先打开一张画布再重试；'
                                     '若仍失败，请提供诊断信息以增加专门适配。')
        raise UnsupportedVersion('检测到多个画布结构候选，已停止识别，避免误读。请提供诊断信息。')
    return next(iter(candidates.values()))


@dataclass(frozen=True)
class SourceSpec:
    pid: int
    process_created: float
    profile: Profile
    canvas: Canvas


class SaiSource:
    def __init__(self, spec: SourceSpec):
        self.spec = spec
        self.process = ReadOnlyProcess(spec.pid)
        try:
            if (self.process.created != spec.process_created or
                    executable_hash(self.process.exe) != spec.profile.exe_hash):
                raise CanvasUnavailable('SAI2 进程已更换，请重新连接')
            self.reader = CanvasReader(self.process, spec.profile)
        except BaseException:
            self.process.close()
            raise

    def capture(self):
        return self.reader.capture(self.spec.canvas)

    def close(self):
        self.process.close()


def capture_snapshot(spec: SourceSpec):
    source = SaiSource(spec)
    try:
        return source.capture()
    finally:
        source.close()


def connect(pid, discover=False, progress=None):
    with ReadOnlyProcess(pid) as process:
        fingerprint = executable_hash(process.exe)
        if fingerprint == PROFILE_20230405.exe_hash:
            reader = CanvasReader(process, PROFILE_20230405)
            try:
                canvases = reader.list_canvases()
            except (MemoryReadError, UnicodeError) as exc:
                raise MemoryReadError(f'2023.04.05 专版：读取用户画布列表失败：{exc}') from exc
            for canvas in canvases:
                try:
                    reader.validate_canvas(canvas)
                except MemoryReadError as exc:
                    raise MemoryReadError(
                        f'2023.04.05 专版：验证 {canvas.width}×{canvas.height} 合成图失败：{exc}'
                    ) from exc
            return PROFILE_20230405, canvases, process.created
        profile = None if discover else known_profile(fingerprint)
        if profile is None or discover:
            if not discover:
                raise UnsupportedVersion(f'未适配的 SAI2（MD5: {fingerprint}）。'
                                         '请打开画布，点击“识别此版本”。')
            try:
                profile = discover_profile(process, fingerprint, progress)
            except UnsupportedVersion as exc:
                raise UnsupportedVersion(f'{exc}\n程序 MD5：{fingerprint}') from exc
        reader = CanvasReader(process, profile)
        canvases = reader.list_canvases()
        for canvas in canvases:
            reader.validate_canvas(canvas)
        if discover and canvases:
            save_profile(profile)
        return profile, canvases, process.created
