# BGI 技术学习路径（复盘版）

> 用途：给自己复盘用。讲清楚"为什么这样排、每个阶段在 BGI 里对应什么、怎么算学会了"。
> 配套文档：`bgi-learning-progress.md`（进度追踪版，供任务读取与验收）。
> 起点：C 语言基础 + Python 入门；目标：能独立修改 BGI、能独立做识别与自动化。
> 关联方案：`Docs/design/commission-mechanism-generalization-plan.md` 第 11 节 T 轨道。

## 1. 路线的基本判断

你的语法基础不是瓶颈，真正的瓶颈有两个：

1. **C# 的工程模型**：`async/await` + `CancellationToken` + `IDisposable` 三者交织，写错不报错，只表现为"任务不退出""截图越跑越卡"。
2. **视觉识别的调试方法**：识别错了不是"代码写错"，而是"ROI 不对/阈值不对/坐标没换算"。这类问题只能靠可复现的调试手段，不能靠猜。

所以路线不按"先学完 C# 再学 CV"排，而按"每个阶段都产出一个能跑的东西"排。看完教程不写，等于没学。

## 2. 六阶段

### L0 环境与代码地图

- 学什么：Visual Studio 打开解决方案、断点、日志窗口、Git 基础（分支/提交/推送）。
- 为什么：BGI 是 .NET + WPF 的单体工程，先知道"东西在哪"，后面才不会在 3000 个文件里乱撞。
- BGI 对应：`BetterGenshinImpact.sln`、`BetterGenshinImpact/Core`、`GameTask`、`Assets`。
- 产出：本地编译成功并跑通一次自动拾取。
- 达标：能说清"截图从哪里来、识别结果在哪里生成、动作在哪里发出"这条链路。
- 常见坑：把 `User/` 目录当成源码目录（它是运行时数据，脚本和日志都在那里）。

### L1 C# 语言与异步模型

- 学什么：类/接口/泛型、`record`、`IDisposable` 与 `using`、`Task`/`async`/`await`、`CancellationToken`、LINQ。
- 为什么：BGI 每个任务都是 `BaseIndependentTask` 子类，靠 `CancellationToken` 停止；截图与识别对象不释放就会持续吃内存。
- BGI 对应：`GameTask/Model/BaseIndependentTask.cs`、`GameTask/Common/TaskControl.cs`、任选一个 `*Task.cs` 精读。
- 产出：控制台程序——循环截图、打印每帧耗时、按 Ctrl+C 优雅退出。
- 达标：能解释"为什么 `catch` 里不能吞掉 `OperationCanceledException`"、"`using` 与手动 `Dispose()` 的差别"。
- 常见坑：`async void`；忘记 `await` 导致任务静默失败；`CancellationToken` 不往下传。

### L2 图像基础

- 学什么：`Mat`、ROI 裁剪、灰度、二值化、模板匹配与阈值、坐标缩放与 DPI。
- 为什么：BGI 的感知层几乎全是"裁剪 ROI → 匹配/OCR → 得到坐标"，90% 的识别问题出在 ROI 与坐标换算。
- BGI 对应：`Core/Recognition`、`OpenCvSharp` 封装、`GameTask/Model/Area`。
- 产出：Python 版"每秒 1 次 OCR 小地图下方任务栏，落 CSV"（对应 `js/quest-watch` 的监听逻辑，可作为参考答案）。
- 达标：给定一张截图，能在纸上标出 ROI 并说明为什么是这个范围；能解释模板尺寸与分辨率不一致时会发生什么。
- 常见坑：`Mat` 是引用，裁剪后忘记释放；模板分辨率与截图分辨率不匹配导致永不命中；把"直线距离"当成"可达距离"。

### L3 OCR 与结果处理

- 学什么：ROI 设计、PaddleOCR 调用、多段文字拼接、距离/数字提取、置信度与误识别处理。
- 为什么：任务栏、对话选项、距离读数全是 OCR；OCR 的稳定性决定自动化的下限。
- BGI 对应：`Core/Recognition/OCR`、`ElementRecognition`、脚本层的 `RecognitionObject.ocr`。
- 产出：把 L2 的采样做成一个独立 Task，输出与 Python 版一致的 CSV。
- 达标：同一场景连续采样 100 次，文字提取成功率可量化（写进追踪文档）。
- 常见坑：把 OCR 结果当"必然正确"直接驱动按键；没有区分"没识别到"和"识别成空"。

### L4 输入与画面捕获

- 学什么：`SendInput` 键鼠模拟、窗口激活、GDI/DXGI 捕获、管理员权限、DPI 缩放。
- 为什么：这是 BGI"手"的部分；坐标算错一点，点到的就是别的东西。
- BGI 对应：`Core/Simulator`、`Core/Input`、捕获工厂。
- 产出：一个可中断的宏——按 V 追踪 → 读距离 → 按 W 前进。
- 达标：能在不同窗口状态下解释"为什么点击没生效"（未激活/管理员/坐标缩放）。
- 常见坑：`moveMouseTo` 用绝对坐标受分辨率影响，`moveMouseBy` 是相对位移；游戏不在前台时输入会丢。

### L5 架构与脚本层

- 学什么：任务调度、状态机、事件与优先级、配置与日志、JS 脚本 API 与 `dispatcher`。
- 为什么：单点识别会了之后，难点变成"多个任务如何不打架、失败如何恢复"。
- BGI 对应：`TaskDispatcher`、`GameTask/AutoSkip`、脚本仓库里的 `AutoCommissionNova` / `AutoStoryLoader`。
- 产出：把 QuestWatch 的"目标类型 → 动作"映射调通，或先做成 JS 版调优（当前分支已有原型）。
- 达标：能解释"为什么逐帧循环里不能调用 LLM"、"任务失败预算如何避免死循环"。
- 常见坑：注册点漏挂（实现了但没注册，功能永远不触发）；脚本与内置任务同时操作导致抢点击。

### L6 模型（可选，按需）

- 学什么：YOLOv8 标注与训练、ONNX Runtime 推理、量化。
- 为什么：只有当你用数据证明"模板匹配与 OCR 已达上限"时才值得投入。
- BGI 对应：`Assets/Model/*.onnx`。
- 产出：一个小数据集 + 一个能替换现有模板的模型。
- 常见坑：先训模型再想场景；忽略推理耗时挤占帧预算。

## 3. 最短正反馈链

1. Python 写追踪栏采样（练 ROI + OCR，一天量级）。
2. C# 把采样做成独立 Task（练 `CancellationToken` + `IDisposable`）。
3. 在 JS 层把 QuestWatch 的传送/卡死恢复调通（练 API 调试与实机验证）。
4. 回 C# 给主程序补一个"任务目标变化"的注册点（练架构与注册链路）。
5. 向上游提 PR（需先 fork；`bgi_changing` 不是上游 fork，不能直接提）。

每一步都同时练到"语言 + 识别 + 架构"，第 3 步现在就能做。

## 4. 明确不必学

- 游戏内存读取/注入：BGI 明确不做，且有封号风险。
- 深度学习训练：先证明规则不够用。
- WPF 界面美化：与目标无关。
- 逆向工程/反检测：不要碰。

## 5. 自测题（能答上来才算过阶段）

- L1：`catch (Exception)` 里吞掉 `OperationCanceledException` 会发生什么？
- L1：为什么 `Mat` 用完必须释放？不释放的表现是什么？
- L2：模板 1920×1080、截图 1280×720，直接匹配会怎样？怎么处理？
- L2：为什么 `xx m` 是直线距离，不能用来选传送点？
- L3：如何区分"没识别到文字"和"识别到空字符串"？
- L4：`moveMouseTo` 与 `moveMouseBy` 的区别？游戏窗口不在前台会怎样？
- L5：为什么逐帧决策不能接 LLM？失败预算解决的是什么问题？
- L5：一个功能实现了却从不触发，最可能的原因是什么？

## 6. 学习资源

- BGI 官方文档（脚本与开发）：<https://www.bettergi.com/dev/js/>
- 用户手册（功能边界）：<https://www.bettergi.com/doc.html>
- C# 官方文档：<https://learn.microsoft.com/dotnet/csharp/>
- OpenCV：<https://docs.opencv.org/>
- OpenCvSharp：<https://github.com/shimat/opencvsharp>

## 7. 与项目的关系

- 阶段 L2/L3 的产物就是 T 轨道监听器的"人能自己写一遍"版本。
- 阶段 L5 的产出决定 T 轨道能否从"脚本原型"升级为"主程序能力"。
- P0（样本 → 内容库）仍然暂停，恢复前提是真实样本；学习路径不依赖它。
