# SAI2 绘画工具包

适用于 Windows x64 的 PaintTool SAI Ver.2 独立工具。无需替换 SAI2 或安装插件；不包含 SAI2 本体，也不录音。

正式版 `0.2.1` 在同一个 Windows 发行包中提供「录制」和「3D 人偶」。内置原版灰模及 hinzka 男、女两款试用版原始 VRM，支持本地导入 GLB、GLTF、FBX 和 VRM。可直接调整关节及双肩、命名保存姿势、拖动主光方向，并导出长边最高 4096 像素的透明 PNG。

## 下载与启动

1. 从 [GitHub Releases](https://github.com/YUMI233666/sai2-canvas-recorder/releases/latest) 下载 `windows-x64-external-ffmpeg.zip` 后缀的发行包，完整解压并打开 `SAI2CanvasRecorder.exe`。无需另装 Python。
2. **3D 人偶**：选择「3D 人偶」页，再点「打开 3D 人偶」。只需 [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)，无需启动 SAI2 或安装 FFmpeg。
3. **录制**：从 [FFmpeg 官方下载页](https://ffmpeg.org/download.html#build-windows) 获取含 `libx264` 的 Windows 构建。将 `ffmpeg.exe` 放在 `SAI2CanvasRecorder.exe` 同目录，或将 FFmpeg 的 `bin` 目录加入 `PATH`。打开 SAI2 画布，在「录制」页选择进程并连接。

| 采集来源 | 适用场景 |
| --- | --- |
| 整画布（固定构图） | 只录画布的合成图。画布缩放、平移和旋转视图不影响视频，不含界面 |
| 笔画过程（SAI2 窗口） | 采集 SAI2 当前显示的中间笔画。想保留落笔速度，搭配「实时录制」；会录入 SAI2 界面和视图变化 |

支持实时和延时（自定义采样间隔）、MP4/MKV、暂停和分段恢复。多个录制会话可以归到同一画布文件夹，各自导出成片，不会自动合成总视频。

## 文档与源码

- [中文使用手册](README_zh-CN.md)：兼容性、输出目录、恢复分段和源码运行方式。
- [手动验收](MANUAL_ACCEPTANCE.md) · [架构](docs/ARCHITECTURE.md) · [版本记录](CHANGES_RECORDER.md)
- 录制源码在 [`src/sai_recorder/`](src/sai_recorder)，3D 人偶源码在 [`pose_studio/`](pose_studio)，附有 [art-timelapse 上游说明](README_upstream.md)。

基于 [cromachina/art-timelapse](https://github.com/cromachina/art-timelapse)，按 [GPLv3](LICENSE) 分发，详见[第三方声明](THIRD_PARTY_NOTICES.md)。发行包已构建，SAI2 实机录制未在发布阶段验证。
