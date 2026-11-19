@echo off
setlocal
cd /d "%~dp0"
for %%D in (dist\github dist) do (
    if exist "%%D\0.2.0\SAI2CanvasRecorder\SAI2CanvasRecorder.exe" (
        start "" "%%D\0.2.0\SAI2CanvasRecorder\SAI2CanvasRecorder.exe"
        exit /b 0
    )
)
if exist ".venv\Scripts\pythonw.exe" (
    set "PYTHONPATH=%~dp0src"
    start "" ".venv\Scripts\pythonw.exe" -m sai_recorder
    exit /b 0
)
echo Recorder runtime not found. See README_zh-CN.md.
pause
exit /b 1
