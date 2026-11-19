# 第三方来源与通知

本项目基于 **cromachina/art-timelapse**，上游地址 https://github.com/cromachina/art-timelapse ，基线提交 `ac9f4c1da9d157592a5a9d9c63aae65429b6b325`。上游使用 GPLv3，完整许可保留于项目和分发包的 `LICENSE`。新增录制器代码按相同许可提供；修改列表见 `CHANGES_RECORDER.md`，对应源码与 Windows 包同时交付。

主要运行组件：Python、NumPy、OpenCV、Pillow、psutil、ttkbootstrap 和 PyMemoryEditor。FFmpeg 通过独立子进程完成编码和合并。GitHub 发行包不包含 FFmpeg 可执行文件，也不包含 OpenCV 的可选 FFmpeg 视频 I/O 插件；录制器的图像处理不依赖该插件。带 FFmpeg 的本机构建记录其编译选项及许可文本，路径为 `licenses/FFMPEG_BUILD.txt` 和 `licenses/FFMPEG_LICENSE.txt`。

Windows 包的 `licenses/` 汇集构建环境中依赖包附带的 license / notice 文件，`build-info.json` 记录构建环境依赖版本。该清单是构建环境的保守超集，其中部分原上游功能依赖不一定进入当前可执行程序。

窗口采集使用 [windows-capture](https://github.com/NiiightmareXD/windows-capture) 的 Python 扩展（MIT 许可），通过 Windows Graphics Capture 取所选 SAI2 窗口的图像。

3D 人偶窗口使用 Three.js（MIT）、Lucide（附带 ISC / MIT 声明）和 Microsoft Edge WebView2 SDK；不打包 WebView2 Runtime。人偶采用 Innerscene 的 MakeHuman 衍生底模（CC0 1.0），出处、原始文件哈希和许可见 [模型声明](pose_studio/assets/LICENSE.md)。分发包中对应声明在 `pose-studio/web/` 和 `licenses/`。

源码获取位置：GitHub Release 对应标签的「Source code」压缩包，或本机构建随附的 `SAI2CanvasRecorder-<版本>-source.zip`。依赖包的来源由 `uv.lock` 及各自包元数据记录。重新公开分发含 FFmpeg 的二进制前，应另外准备对应 FFmpeg 构建及相关库所需的完整源代码和构建材料；本项目的源码 ZIP 不包含 FFmpeg 和其他第三方库的完整源代码。

本工具未包含 SAI2 程序、授权文件或任何安装补丁。
