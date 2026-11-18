# 感知层与认知层优化方向（备忘录）

状态：**待定**（记录讨论结论，未立项、未实施）

## 方向一：用针对性小模型替换热点路径上的通用模型

- 现状：`BgiOnnxModel.cs` 中通用模型（PaddleOCR 等）同时服务于内置 C# 任务与 JS 脚本，并非只为脚本降低门槛。
- 思路：对**每帧调用**的感知热点（拾取文字、钓鱼状态、技能冷却等），训练领域专用的小模型（小 SVTR / YOLOv8n / 小 CNN 分类器），替换通用模型以降低延迟。
- 已有先例：`YapModelTraining`（拾取文字）、`BgiQClassify`/`BgiEClassify`（技能冷却分类）即此模式。
- 约束：需自行采集标注数据；游戏 UI 变更后需重训；只优化高频路径才划算。

## 方向三：角色姿态判断小模型（战斗中被击飞/打断检测）

状态：**可优化方向**（已讨论设计，未实施）

- 目标：在战斗中识别角色是否被击飞/被打断（受击硬直），供 AutoFight 决策（如被击飞时闪避或中断当前攻击序列）。
- 设计（分类模型路线，**不是**改 RecognitionObject）：
  - 训练一个小分类 CNN / YOLOv8 分类分支：输入 = 角色所在位置的图像块，输出 = `被击飞 / 正常 / 受击硬直 / …`，导出 ONNX。
  - 在 `BgiOnnxModel.cs` 注册新模型（一行 `Register`）。
  - 用 `BgiOnnxFactory.CreateYoloPredictor(...)` + `Predictor.Classify(图像块)` 推理；置信度 < 0.7 视为 Unknown，防止误判。
  - 定位角色区域：模板匹配（RecognitionObject）或写死 ROI（战斗 UI 位置固定，Q/E 冷却判断即写死 ROI，`AutoFightAssets.Get(...)`）。
  - 决策接入：AutoFight 战斗行为树新增分支。
- 现成模板：`Avatar.IsBurstReadyByClassify`（`GameTask/AutoFight/Model/Avatar.cs` L793）——注册模型 + CreateYoloPredictor + Classify + 置信度阈值的完整套路。
- 注意事项：
  - 类别命名直接影响代码判断（`e_classify_sim` 输出格式 `"<前缀> <角色名> <编号> <状态>"`，代码用 `Contains` 匹配），训练时类别名要稳定、语义清晰。
  - 共享会话需 `lock` 串行化推理（参照 `ESkillClassifierLock`）。
  - 训练数据从真实战斗截图采集；游戏更新改 UI 后需重训。
- 遵循级联原则：感知层用专用小模型（几 ms），不引入统一大模型全包。

## 方向二：在高层规划（L3）引入认知层模型

- 现状：项目无认知层，所有决策均为 C# 手写规则；唯一 LLM 相关是 QuestVoice 的 TTS（语音合成，非决策）。
- 分层结论：
  - **L1 逐帧决策**（黑白名单、状态判定）：不能用 LLM，需 <50ms 且确定性强。
  - **L2 流程状态机**（秘境/钓鱼流程）：不建议纯 LLM，可混合（LLM 提议 + 状态机兜底）。
  - **L3 高层规划**（一条龙、Pulonia 任务编排）：频率低、需灵活、可重试，是认知层的合理位置。
- 思路：用 LLM 在 L3 生成/调整任务计划，L1/L2 仍由规则保证实时性与确定性。
- 约束：本地大模型的硬件成本 / API 延迟与费用 / 离线能力。
- **[修正] 适用边界**：LLM 可承担**事件级**的任务理解与机制选择（每个委托判断一次，0.5~2s 可接受），用于替代内容库中的"语义流程"；但不能替代"空间路径"（坐标必须靠导航）。因此原来的"L3 才可用"应改为：**低频事件可用，逐帧不可用**。落地见 [commission-mechanism-generalization-plan.md](commission-mechanism-generalization-plan.md)。

## 方向四：地图追踪控制回路的感知升级与局部重规划

状态：**可优化方向**（已讨论设计，未实施）

- 问题定位：`PathExecutor` 的"不够智能/不够拟人"并非缺少推理能力，而是**没有空间模型 + 感知刷新率过低**。具体短板：
  - 卡死检测每 1 秒才采样一次、攒 8 个点比较（`MoveTo`，`PathExecutor.cs` L916-945），反应慢。
  - `TrapEscaper` 为固定抖动策略，**无局部重规划能力**，撞墙只能原地试探。
  - 路线为人工录制的死路径（`ConvertWaypointsForTrack` 仅按传送点切段），中途不重算，障碍物前不会绕行。
  - 定位依赖小地图模板匹配（`Navigation.GetPosition`），遮挡或特效下易丢失，退化到开大地图（上百 ms）。
- 分层思路（延续级联原则，**不把 LLM 放进逐帧闭环**）：
  - **快路径（5~150ms，每帧）**：新增轻量视觉里程计模型（小 CNN 回归头，输入相邻两帧小地图局部，输出相对位移 dx/dy，3~8ms）。定位频率可提至约 10Hz，使卡死检测窗口从 1s 降到 0.2s 级，并可在丢帧时外推。属方向一的具体实例。
  - **中路径（异常时刻）**：把脱困从固定策略换为行为克隆策略（输入截图，输出键鼠序列），训练数据来自录制回放/路线录制/人工脱困操作；必须保留现有确定性兜底。
  - **慢路径（段失败后，0.5~3s）**：VLM 仅做异常兜底与事后决策。`ResolveAnomalies`（L1409）当前靠固定模板识别"Cook/PageClose/大地图"并按 ESC，遇到新 UI/活动弹窗即失效，适合改为"连续失败 N 次 → 整屏截图问 VLM 当前界面与应对"。
- 优先级（收益/风险比）：① 视觉里程计与定位鲁棒性 → ② 局部避障/重规划 → ③ VLM 异常兜底 → ④ 在线 LLM 决策（不建议）。
- 补充：真正拟人的路线应由**离线**地图数据全局规划（可通行网格 A*）生成路线文件，在线只做"跟随 + 微调"，而非在线实时推理。
- 约束：LLM 调用延迟 0.5~3s，与 5~150ms 的控制节拍差 1~2 个数量级，进入闭环等价于在 ISR 内做阻塞 IO，会累积概率性误差；模型只能置于回路之外。

## 方向五：战场感知与战斗策略选择（配置组战斗链路现状）

状态：**可优化方向**（已讨论设计，未实施）

- 现状事实（配置组内的"战斗配置"如何生效）：
  - 配置组里**没有"识别进入战斗"**。是否开打由路线点 `waypoint.Action` 决定（录制时人工标注），属"预知式"触发，不是感知式。`PathExecutor.cs` L268-277 是全流程唯一调用战斗的地方；`ActionFactory.cs` L40 把 `"fight"` 映射到 `AutoFightHandler`。
  - 触发链：路线点 `action: fight` → `AfterMoveToTarget` → `AutoFightHandler.StartFight` → `AutoFightEntryTask` → `CombatStrategyResolver`（解出策略文件路径 + 类型 json/txt/combo/keymouse）→ `CombatTaskFactory`。
  - 配置选择两级回退（`AutoFightHandler.cs` L48-57）：`Enabled && AutoFightEnabled` → 用配置组的 `AutoFightConfig`；否则退回全局（独立任务页）配置。该开关是**选择器而非启停开关**，关闭后 `fight` 点仍会打，只是改用全局配置（UI 文案见 `ScriptGroupConfigView.xaml` L973）。
  - 战斗内无"进战检测"：`FightStartTime = DateTime.Now`（`AutoFightTask.cs` L314）后直接按策略背板执行。
  - 唯一"看见敌人"的地方是 `CheckFightFinish`（L667-731）里的 `FindBloodBars`（`AvatarRecognition.cs` L189-227）：BGR 红色阈值 `Scalar(255,90,90)` + 二值化 + 连通域，过滤 x<=200 排除队伍头像。**无神经网络**，只判断"屏幕上还有没有红色长条"，用途是结束检测跳过与传奇血条追踪。
  - 无 `AutoFightTrigger`（触发器仅有 AutoFishing/AutoPick/AutoEat/AutoSkip/SkillCd/QuickTeleport/MapMask/Placeholder）。即**不存在"敌人出现即自动开战"的实时能力**，战斗永远是显式节点调用。
- 缺口（"不智能"的根因）：无战场感知（敌人位置/数量、角色受击状态）+ 无策略选择（按敌人类型与队伍状态切策略）；策略为人工编排的按键序列，靠角色名分支。
- 可优化方向：
  - 战场感知：敌人检测/计数小模型（接方向一），角色受击硬直分类（接方向三）。
  - 策略选择：仅在**每场战斗开始时决策一次**（非逐帧），可由规则 + 小模型完成；认知层（LLM）只适合放在"这场怎么打/要不要打"的离线或低频率层。
  - 保持不引入逐帧推理，延续级联原则。

## 方向六：自动点亮传送锚点 / 神像

判断：**可实现**。依据：未探索区域仍会显示未点亮的神像图标，神像点亮后区域显形并出现未激活锚点图标，且两者在可见时均可追踪；脚本仓库中已有"追踪图标视觉伺服导航"原型（`js/AutoCommissionNova/src/processors/commission-tracking.js` 的 `autoNavigateToTalk`）。

## 关联设计

- [commission-mechanism-generalization-plan.md](commission-mechanism-generalization-plan.md)：委托机制泛化实施计划（P0~P5 + 验收门槛）。核心结论：语义层（这个委托要做什么）可由推理模型在事件级替代，空间层（具体怎么走）必须交给通用导航；执行按四层优先级——内容库精确命中 → 语义泛化 → 通用导航 → 兜底放弃。P0 离线可行性验证是启动门槛，不通过则停止。
- [gated-content-distribution.md](gated-content-distribution.md)：敏感内容的分级与授权分发。结论：用"公开说明 + 私有仓库人工授权"（可撤销、可审计），不用密码包；程序侧挂载点为 `ScriptRepositoryRegistration.Kind` 与 `ScriptRepositoryRemote` 的凭据字段；授权只作用于内容数据，不对 GPL-3.0 主程序加功能锁。
- 分层原则（适用于上述所有方向）：**代码 GPL、资产私有**。方向一/三/四/五的程序改动合入后随 GPL 公开，可被任意 fork 拿走；可形成差异的是模型权重与训练数据（`Assets\Model\*.onnx` 为外部资产，经 `Global.Absolute` 加载，不在代码仓库），以及方向六与敏感内容所走的内容授权通道。

## 不做的事

- 不用 LLM 替换逐帧决策规则。
- 不把通用模型全部替换为专用模型（泛化场景仍需兜底）。
