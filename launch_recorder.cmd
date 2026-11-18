@echo off
setlocal
cd /d "%~dp0"
for %%V in (0.1.4 0.1.3 0.1.2 0.1.1) do (
    if exist "dist\%%V\SAI2CanvasRecorder\SAI2CanvasRecorder.exe" (
        start "" "dist\%%V\SAI2CanvasRecorder\SAI2CanvasRecorder.exe"
        exit /b 0
    )
)
if exist "dist\SAI2CanvasRecorder\SAI2CanvasRecorder.exe" (
    start "" "dist\SAI2CanvasRecorder\SAI2CanvasRecorder.exe"
    exit /b 0
)
if exist ".venv\Scripts\pythonw.exe" (
    set "PYTHONPATH=%~dp0src"
    start "" ".venv\Scripts\pythonw.exe" -m sai_recorder
    exit /b 0
)
echo Recorder runtime not found. See README_zh-CN.md.
pause
exit /b 1
