# BGI 原项目技术学习路径（复盘版）

> 用途：读懂、改懂现有 BetterGI 本身。**不涉及任何在研的改进分支或新功能规划**。
> 配套文档：`bgi-learning-progress.md`（进度追踪与验收，供任务读取）。
> 起点：C 语言基础 + Python 入门。
> 对象：上游 `babalae/better-genshin-impact` 的现有实现。

## 1. 技术栈全貌

| 层 | 技术 | 目录/文件 |
|---|---|---|
| 运行时 | .NET 10 (`net10.0-windows10.0.22621.0`) | `BetterGenshinImpact.csproj` |
| 界面 | WPF + WPF-UI，MVVM 用 CommunityToolkit.Mvvm | `View/`、`ViewModel/`、`Markup/` |
| 宿主 | Microsoft.Extensions.Hosting / DI / Logging + Serilog | `App.xaml.cs`、`Service/` |
| 图像 | OpenCvSharp4（Window/Wpf 扩展） | `Core/Recognition/OpenCv/` |
| OCR | Paddle OCR、PP-OCRv6 服务、SVTR | `Core/Recognition/OCR/` |
| 模型 | ONNX Runtime（DirectML 加速）、YOLOv8（YoloSharp） | `Core/Recognition/ONNX/`、`GameTask/Common/YoloManager.cs` |
| 捕获 | GDI / DXGI，PresentMon 取帧率 | `GameTask/Model/Area/GameCaptureRegion.cs`、`GameTask/Runtime/` |
| 输入 | SendInput 后端、RawInput/MouseKeyHook 监听 | `Core/Input/`、`Core/Monitor/` |
| 脚本 | ClearScript V8（TypeScript/JavaScript） | `Core/Script/` |
| 资源 | 以 NuGet 包分发：`BetterGI.Assets.Map/Model/Other` | `Global.Absolute` 定位 |
| 其他 | LibGit2Sharp（脚本仓库）、WebView2、NAudio、DryWetMidi | 视子系统而定 |

## 2. 八个阶段

顺序按“先能跑 → 再看画面 → 再看识别 → 再看动作 → 最后看调度与脚本”排。每阶段都要有可运行产物。

### L0 工程与运行环境

- 学什么：Visual Studio 打开解决方案、编译、断点、日志窗口、Git 基础。
- 为什么：BGI 是单体 WPF 工程，文件多但分层清晰；先建立目录地图，后面才知道去哪读。
- 目录地图：
  - `Core/`：识别、输入、脚本、监控、配置等基础设施；
  - `GameTask/`：每个自动化功能一个子目录（AutoPick、AutoFight、AutoPathing…），公共能力在 `GameTask/Common/`；
  - `Service/`：应用级服务（配置、脚本、截图、通知…）；
  - `View/` `ViewModel/`：界面与 MVVM；
  - `Infrastructure/`：缓存、网络、存储、WebView；
  - `User/`：**运行时数据**（配置、脚本、日志），不是源码。
- 产出：本地编译成功并跑通一次自动拾取。
- 达标：能说出“截图 → 识别 → 决策 → 输入”分别在哪些目录发生。
- 常见坑：把 `User/` 当源码目录；忘了资源来自 `BetterGI.Assets.*` NuGet 包而非仓库内文件。

### L1 C# 工程模型：异步、资源、DI、配置

- 学什么：`async/await` + `CancellationToken`、`IDisposable`/`using`、泛型与接口、`IHostedService` 与 DI 生命周期、`record`、LINQ。
- 为什么：BGI 每个任务都要能被取消；`Mat`、截图、识别结果都是非托管资源；服务全部走 DI。
- 读什么：`App.xaml.cs`（Host 与 DI 注册）、`Core/Config/AllConfig.cs`（配置聚合与持久化）、`GameTask/Model/BaseIndependentTask.cs`、`GameTask/Common/TaskControl.cs`。
- 产出：控制台程序——循环调用截图、打印每帧耗时、Ctrl+C 优雅退出。
- 达标：能解释“为什么取消异常不能吞掉”“不释放 `Mat` 会怎样”“配置改动如何落盘”。
- 常见坑：`async void`；`CancellationToken` 不往下传；把 DI 单例当可随意 new 的类。

### L2 画面捕获与显示

- 学什么：GDI/DXGI 捕获差异、截图分辨率与缩放规则、窗口激活、遮罩窗口叠加、帧率统计。
- 为什么：识别的一切输入来自捕获；分辨率与坐标换算错误，后面全错。
- 读什么：`GameTask/Model/Area/GameCaptureRegion.cs`、`GameTask/Runtime/GameCaptureSettings.cs`、`Service/GameScreenshotService.cs`、`GameTask/MaskMask`/`MapMask`、`Service/OverlayMetricsService.cs`。
- 产出：独立小程序：热键截图并保存 PNG，连续跑 5 分钟观察内存。
- 达标：能解释“为什么 >1080P 会被缩放”“DXGI 与 GDI 各自的适用场景”“窗口不在前台会怎样”。
- 常见坑：以为截图坐标就是屏幕坐标；忽略 DPI 缩放；捕获对象不复用导致每帧分配。

### L3 OpenCV 识别层

- 学什么：`Mat`/ROI、灰度与二值化、模板匹配与阈值、多目标匹配、特征匹配、轮廓、图像差分、缩放。
- 为什么：BGI 的“眼睛”几乎都是“裁剪 ROI → 匹配/OCR → 返回区域”，90% 识别问题出在 ROI 与阈值。
- 读什么：`Core/Recognition/OpenCv/MatchTemplateHelper.cs`、`TemplateMatch/`、`ContoursHelper.cs`、`ImageDifferenceDetector.cs`、`ResizeHelper.cs`、`Core/Recognition/RecognitionObject.cs`、`GameTask/Common/Element/`。
- 产出：模板匹配 demo——在截图中找到派蒙菜单图标并画出匹配框与相似度。
- 达标：给定截图能标出合理 ROI 并说明理由；能解释模板与截图分辨率不一致时的后果。
- 常见坑：`Mat` 是引用，裁剪后不释放；阈值设为 1.0 永不命中；把匹配分数当绝对可信。

### L4 OCR 与 ONNX 推理

- 学什么：OCR 引擎选择与 ROI、结果拼接与后处理、置信度、YOLO 检测输出解析、推理设备（CPU/DirectML）、模型资源路径。
- 为什么：任务栏、对话、数字读数全靠 OCR；战斗与地图检测依赖模型。
- 读什么：`Core/Recognition/OCR/OcrFactory.cs`、`PpOcrV6Service.cs`、`Core/Recognition/ONNX/BgiOnnxFactory.cs`、`BgiYoloPredictor.cs`、`RuntimePackageDownloader.cs`、`GameTask/Common/YoloManager.cs`。
- 产出：把 L2 的截图程序扩展为“框选 ROI → OCR → 输出 JSON”。
- 达标：能解释“没识别到”和“识别为空”的区别；能对比 CPU 与 DirectML 的耗时。
- 常见坑：不区分 OCR 失败与业务为空；ROI 过大导致耗时；忽略模型首次加载开销。

### L5 输入模拟与监控

- 学什么：SendInput、后端抽象（`IInputBackend`）、窗口激活与管理员权限、RawInput/MouseKeyHook 监听、键鼠录制与回放。
- 为什么：这是 BGI 的“手”；坐标或权限差一点，点到的就是别的东西。
- 读什么：`Core/Input/InputHub.cs`、`Backends/`、`Core/Monitor/`、`Core/Recorder/`、`GameTask/Macro/`、`GameTask/KeyMacro/`。
- 产出：录制一段“移动 + 交互”的宏并回放；再写一份“点击无效”的排查记录（未激活/非管理员/坐标缩放）。
- 达标：能解释绝对坐标与相对位移的区别，以及前后台窗口对输入的影响。
- 常见坑：以为鼠标事件一定落到游戏；忘记 DPI；录制回放受帧率影响。

### L6 任务系统、触发器与调度

- 学什么：任务生命周期、触发器与调度器、独立任务与信号量、重试与状态机、全局设置对任务的影响。
- 为什么：单点识别会了之后，真正难的是“多个任务如何不打架、如何被正确启动和停止”。
- 读什么：`GameTask/GameTaskManager.cs`、`TaskTriggerDispatcher.cs`、`TaskRunner.cs`、`ITaskTrigger.cs`、`GameTask/SoloTask/`、`GameTask/Common/TaskControl.cs`、`NewRetry.cs`、`GameTask/Common/StateMachine/`。
- 产出：给一个已有任务画出“触发 → 启动 → 循环 → 取消 → 清理”的时序图（文字版即可）。
- 达标：能解释“任务实现了却没有被触发”的常见原因（未注册/触发器条件不满足/信号量被占）。
- 常见坑：重复启动导致并发操作；取消后未清理遮罩或按键状态。

### L7 脚本引擎与扩展接口

- 学什么：ClearScript V8 宿主、脚本生命周期、暴露给脚本的 API（`Genshin`、`Dispatcher`、`CustomHostFunctions`）、脚本仓库订阅与更新、TypeScript 类型提示。
- 为什么：BGI 大量功能以脚本形式分发；理解宿主边界才能判断“什么能写在脚本里、什么必须改主程序”。
- 读什么：`Core/Script/ScriptExecution.cs`、`EngineExtend.cs`、`ScriptHostOperations.cs`、`Dependence/Genshin.cs`、`Dependence/Dispatcher.cs`、`ScriptRepoUpdater.cs`。
- 产出：写一个最小脚本：截图 + 日志 + 读文件 + 异常处理，能在游戏内正常启动和退出。
- 达标：能列出“脚本层不能做但主程序能做的事”。
- 常见坑：脚本不是独立进程，卡死会拖住宿主；路径是相对脚本目录；旧 API 与新 API 命名混用。

### L8 专题（按兴趣选，非必修）

- 地图追踪：`GameTask/AutoPathing/`、`Core/Recognition` 中的地图坐标换算、`BetterGI.Assets.Map`。
- 自动战斗：`GameTask/AutoFight/`、`GameTask/Common/YoloManager.cs`、策略配置。
- 自动剧情：`GameTask/AutoSkip/`（对话识别、选项配置、音频处理）。
- 音乐游戏：`GameTask/Music/`（MIDI 解析与输入时序）。
- 语音：`Service/QuestVoiceService*`（TTS 与 AI 服务接入）。

## 3. 阅读方法

1. 先跑起来，再读代码；每个功能先看它的 `*Task.cs` 入口，再往下追一层。
2. 读一个模块前，先问三个问题：输入是什么（截图/配置）、输出是什么（区域/动作）、什么时候停。
3. 遇到识别结果不对，先怀疑 ROI 与坐标换算，再怀疑阈值，最后才怀疑算法。
4. 每读完一个子系统，用 200 字写下“它解决什么问题、边界在哪、我能在哪加东西”。

## 4. 明确不必碰

- 游戏内存读取/注入：BGI 不做，也有封号风险。
- 逆向、反检测：与本项目无关。
- 深度学习训练：先把 L3/L4 的推理与规则用明白。
- 界面美化：与理解系统无关。

## 5. 自测题

- L1：`catch (Exception)` 吞掉取消异常会发生什么？`Mat` 不释放的表现是什么？
- L2：为什么高分辨率截图会被缩放？DXGI 与 GDI 各自适合什么场景？
- L3：模板 1920×1080、截图 1280×720 直接匹配会怎样？怎么处理？
- L3：模板匹配分数 0.95 是否一定可信？为什么？
- L4：如何区分“没识别到文字”和“识别到空字符串”？
- L5：`moveMouseTo` 与 `moveMouseBy` 有何区别？窗口不在前台会怎样？
- L6：一个任务实现了却从不触发，排查顺序是什么？
- L7：脚本层做不到、必须改主程序的事情有哪些？

## 6. 参考资料

- BGI 仓库：<https://github.com/babalae/better-genshin-impact>
- 官方文档（用户手册与开发文档）：<https://www.bettergi.com/doc.html>
- 脚本 API 文档：<https://www.bettergi.com/dev/js/>
- C# 文档：<https://learn.microsoft.com/dotnet/csharp/>
- OpenCvSharp：<https://github.com/shimat/opencvsharp>
- ONNX Runtime：<https://onnxruntime.ai/docs/>
