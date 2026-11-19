"""Build the Windows recorder for local use or GitHub distribution.

This packages the application. It does not open SAI or run recording tests.
"""
import argparse
from datetime import datetime, timezone
from importlib import metadata
from pathlib import Path
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[1]
os.chdir(ROOT)
sys.path.insert(0, str(ROOT / 'src'))
from sai_recorder import __version__


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--external-ffmpeg', action='store_true',
                        help='Build a GitHub release without the FFmpeg binaries.')
    external_ffmpeg = parser.parse_args().external_ffmpeg
    if sys.platform != 'win32':
        raise SystemExit('Build on 64-bit Windows with the project virtual environment.')
    pose = ROOT / 'build' / 'pose-studio'
    pose_files = ('SAI2PoseStudio.exe', 'SAI2PoseStudio.exe.config', 'WebView2Loader.dll',
                  'Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll')
    if not all((pose / name).is_file() for name in (*pose_files, 'web/mannequin.glb')):
        raise SystemExit('Build Pose Studio first with build_pose_studio.ps1.')
    env = dict(os.environ, PYINSTALLER_CONFIG_DIR=str(ROOT / '.cache' / 'pyinstaller'))
    output_dir = ROOT / 'dist' / 'github' if external_ffmpeg else ROOT / 'dist'
    release_dir = output_dir / __version__
    cmd = [sys.executable, '-m', 'PyInstaller', '--noconfirm', '--clean', '--onedir',
           '--windowed', '--name', 'SAI2CanvasRecorder', '--paths', str(ROOT / 'src'),
           '--distpath', str(release_dir), '--workpath', str(ROOT / 'build' / 'recorder'),
           '--specpath', str(ROOT / 'build' / 'recorder'),
           '--collect-data', 'ttkbootstrap']
    if external_ffmpeg:
        cmd += ['--exclude-module', 'imageio_ffmpeg']
    else:
        cmd += ['--collect-all', 'imageio_ffmpeg', '--copy-metadata', 'imageio-ffmpeg']
    cmd.append(str(ROOT / 'recorder_main.py'))
    subprocess.run(cmd, check=True, env=env)
    target = release_dir / 'SAI2CanvasRecorder'
    for name in ('LICENSE', 'README_zh-CN.md', 'MANUAL_ACCEPTANCE.md',
                 'THIRD_PARTY_NOTICES.md', 'CHANGES_RECORDER.md'):
        shutil.copy2(ROOT / name, target / name)
    shutil.copytree(ROOT / 'docs', target / 'docs', dirs_exist_ok=True)
    pose_target = target / 'pose-studio'
    pose_target.mkdir(exist_ok=True)
    for name in pose_files:
        shutil.copy2(pose / name, pose_target / name)
    shutil.copytree(pose / 'web', pose_target / 'web', dirs_exist_ok=True)
    licenses = target / 'licenses'
    licenses.mkdir(exist_ok=True)
    webview = ROOT / '.cache' / 'nuget' / 'microsoft.web.webview2' / '1.0.3595.46'
    for name in ('LICENSE.txt', 'NOTICE.txt'):
        shutil.copy2(webview / name, licenses / f'WebView2-{name}')
    packages = []
    # Keep notices of the build environment as a conservative superset of bundled packages.
    for dist in metadata.distributions():
        name = dist.metadata.get('Name', 'unknown')
        packages.append({'name': name, 'version': dist.version,
                         'home_page': dist.metadata.get('Home-page')})
        folder = licenses / re.sub(r'[^a-zA-Z0-9_.-]', '_', name)
        for item in dist.files or []:
            text = str(item).replace('\\', '/')
            if '.dist-info/' not in text:
                continue
            relative = text.split('.dist-info/', 1)[1]
            if ('license' in relative.lower() or 'copying' in relative.lower() or
                    'notice' in relative.lower()):
                original = Path(dist.locate_file(item))
                if original.is_file():
                    destination = folder / relative
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(original, destination)
    # Include Python's own license and Tcl/Tk notices where available.
    for base in (Path(sys.base_prefix), Path(sys.base_prefix) / 'tcl'):
        for name in ('LICENSE.txt', 'LICENSE', 'license.terms'):
            original = base / name
            if original.is_file():
                shutil.copy2(original, licenses / f'python-{base.name}-{name}')
    for original in (Path(sys.base_prefix) / 'tcl').glob('*/license.terms'):
        shutil.copy2(original, licenses / f'{original.parent.name}-license.terms')
    if external_ffmpeg:
        # The recorder uses OpenCV for images, not its optional video I/O backend.
        for plugin in (target / '_internal' / 'cv2').glob('opencv_videoio_ffmpeg*.dll'):
            plugin.unlink()
        if any(path.suffix in ('.exe', '.dll', '.pyd') for path in target.rglob('*ffmpeg*')):
            raise SystemExit('Unexpected FFmpeg binary in the GitHub package.')
    else:
        import imageio_ffmpeg
        ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
        flags = subprocess.CREATE_NO_WINDOW
        for argument, name in (('-version', 'FFMPEG_BUILD.txt'), ('-L', 'FFMPEG_LICENSE.txt')):
            result = subprocess.run([ffmpeg, argument], capture_output=True, creationflags=flags)
            (licenses / name).write_bytes(result.stdout + result.stderr)
    manifest = {'application': 'SAI2CanvasRecorder', 'version': __version__,
                'built_at': datetime.now(timezone.utc).isoformat(),
                'upstream': 'https://github.com/cromachina/art-timelapse',
                'upstream_commit': 'ac9f4c1da9d157592a5a9d9c63aae65429b6b325',
                'python': sys.version, 'build_environment_packages': sorted(packages, key=lambda p: p['name']),
                'ffmpeg': 'external' if external_ffmpeg else 'bundled',
                'sai_live_validation': 'not performed; manual acceptance requested by user'}
    (target / 'build-info.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    suffix = '-external-ffmpeg' if external_ffmpeg else ''
    archive = output_dir / f'SAI2CanvasRecorder-{__version__}-windows-x64{suffix}.zip'
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as bundle:
        for file in sorted(target.rglob('*')):
            if file.is_file():
                bundle.write(file, str(file.relative_to(target.parent)))
    print(f'Packaged: {target}')
    print(f'Windows archive: {archive}')
    if external_ffmpeg:
        # The tagged Git snapshot supplies the clean source archive on GitHub.
        write_checksums(output_dir, [archive])
        return
    source = ROOT / 'dist' / f'SAI2CanvasRecorder-{__version__}-source.zip'
    excluded = {'.git', '.venv', '.runtime', '.cache', 'build', 'dist', '__pycache__',
                'validation', 'recordings', 'downloads', '.agents', '.aws', '.codex', 'node_modules'}
    with zipfile.ZipFile(source, 'w', zipfile.ZIP_DEFLATED) as bundle:
        for directory, folders, files in os.walk(ROOT):
            folders[:] = [p for p in folders if p not in excluded]
            if Path(directory) == ROOT / 'pose_studio' / 'host':
                folders[:] = [p for p in folders if p not in ('bin', 'obj')]
            for name in files:
                if name.startswith(('recorder-settings', 'recorder-profiles')) or name.endswith(('.pyc', '.log')):
                    continue
                file = Path(directory) / name
                bundle.write(file, str(file.relative_to(ROOT)))
    write_checksums(output_dir, [archive, source])
    print(f'Corresponding source: {source}')


def write_checksums(output_dir, artifacts):
    hashes = []
    for file in artifacts:
        with file.open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        hashes.append(f'{digest}  {file.name}')
    (output_dir / 'SHA256SUMS.txt').write_text('\n'.join(hashes) + '\n', encoding='ascii')


if __name__ == '__main__':
    main()
