param([switch]$ExternalFfmpeg)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$env:UV_CACHE_DIR = Join-Path $PSScriptRoot '.cache\uv'
$env:UV_PYTHON_INSTALL_DIR = Join-Path $PSScriptRoot '.runtime'
& uv sync --extra dev --locked
if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
$BuildArgs = @()
if ($ExternalFfmpeg) { $BuildArgs += '--external-ffmpeg' }
& '.\.venv\Scripts\python.exe' '.\tools\build_recorder.py' @BuildArgs
if ($LASTEXITCODE -ne 0) { throw 'Recorder packaging failed.' }
