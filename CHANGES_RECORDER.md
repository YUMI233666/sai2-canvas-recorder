# 相对上游的修改

基线：cromachina/art-timelapse，提交 `ac9f4c1da9d157592a5a9d9c63aae65429b6b325`。

- 新增 `src/sai_recorder/`：中文面板、严格只读画布源、版本识别、实时 / 延时采样、暂停、有界队列、H.264 编码、分段恢复与诊断。
- 新增 `recorder_main.py`、`launch_recorder.cmd`、`build_recorder.ps1`、`tools/build_recorder.py`：源码启动和独立 Windows 文件夹打包、对应源码和依赖通知。
- `pyproject.toml` 增加 imageio-ffmpeg 依赖和 sai2-recorder 入口，更新 `uv.lock`。
- `src/art_timelapse/__init__.py`：源码目录未生成翻译资源时，英文回退为 NullTranslations；其他语言仍要求翻译资源。
- `.gitignore` 增加项目内 runtime、缓存、诊断画布目录、用户设置和适配缓存。
- 增加中文说明、架构说明、第三方通知和待执行的手动验收清单。保留上游 README、LICENSE 和原功能入口。

- 0.1.1：为指定指纹的 SAI2 2023.04.05 增加只读用户画布链表配置；连接失败时区分列表读取和合成图验证。

- 0.1.2：延时采样间隔支持手动输入 0.1～60 秒；录制面板支持鼠标滚轮和纵向滚动条，并固定预览区高度。

- 0.1.3：成片按画布归档，跨次录制分别命名；重新连接后可选用原目录，分段和日志保存在各次会话的 `_sessions/` 子目录。

- 0.1.4：新增「笔画过程（SAI2 窗口）」采集来源，实时模式采样窗口显示的笔画中间态；保留原整画布固定构图来源与画布目录归档。

录制器版本：0.1.4。交付未对 SAI2 录制进行实机验收。
