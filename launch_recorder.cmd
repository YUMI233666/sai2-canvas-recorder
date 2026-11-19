@echo off
setlocal
cd /d "%~dp0"
for %%V in (0.2.2-alpha.1 0.2.1) do (
    for %%D in (dist dist\github) do (
        if exist "%%D\%%V\SAI2CanvasRecorder\SAI2CanvasRecorder.exe" (
            start "" "%%D\%%V\SAI2CanvasRecorder\SAI2CanvasRecorder.exe"
            exit /b 0
        )
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
