# 委托样本库（P0）

本目录只存放样本与标注，不放代码。目录约定见 [commission-mechanism-generalization-plan.md](../commission-mechanism-generalization-plan.md) 第 9 节。

## 目录结构

```
commission-samples/
├── README.md
├── labels.csv              # 机制标注表（人工填写）
├── samples/
│   └── <sample_id>/
│       ├── description.txt # 委托面板描述原文（必填）
│       ├── panel.png       # 委托面板截图（必填）
│       ├── scene.png       # 现场截图（必填，至少 1 张）
│       └── scene-2.png     # 现场截图补充（可选）
└── output/                 # 工具生成，可删除重建
```

## sample_id 命名

`<地区缩写>-<三位序号>`，如 `nodkrai-001`、`mondstadt-003`。序号从 001 起，不复用，删除的样本编号也不回收。

## 采集要求

1. `description.txt`：委托面板描述原文，逐字抄录；多段之间用空行分隔。
2. `panel.png`：完整委托面板截图，至少含名称、地区、描述、进度 `n/4`。
3. `scene.png`：接取后现场截图，含追踪图标或目标；需要多张时追加 `scene-2.png`、`scene-3.png`。
4. 同一委托只收一条；不同地区的同名委托分别收。
5. 截图保留完整 UI，不要裁掉面板边缘，便于后续复用 OCR 区域配置。

## 标注流程

1. 先读 [prompt.md](../../tools/commission-p0/prompt.md) 的机制口径，再逐条标注；人工标注与模型使用同一份口径。
2. 只依据描述文本判断“这个委托要做什么”，不看路线与坐标；现场截图仅用于核对是否误读描述。
3. 混合机制取主导机制（决定成败或耗时最长的环节），判定优先级见 prompt.md。
4. 无法判断写 `other`，并在 `notes` 写明缺什么信息。
5. `labels.csv` 一行一条，字段说明：

| 字段 | 取值 | 说明 |
|---|---|---|
| `id` | 目录名 | 必须与 `samples/<id>/` 一致 |
| `region` | 原文 | 面板上地区名 |
| `name` | 原文 | 面板上委托名 |
| `truth_mechanism` | 8 个枚举之一 | 人工标注的机制 |
| `truth_target` | `npc` / `enemy` / `object` / `place` / `unknown` | 交互对象 |
| `truth_time_limit` | 秒 | 无时间限制写 `0` |
| `truth_combat` | `true` / `false` | 是否需要战斗 |
| `annotator` | 文本 | 标注人 |
| `notes` | 文本 | 存疑点、缺失信息 |

## 校验与评估

```bash
python3 Docs/design/tools/commission-p0/p0_tool.py validate
python3 Docs/design/tools/commission-p0/p0_tool.py classify --mode scene   # 需 VLM 环境变量
python3 Docs/design/tools/commission-p0/p0_tool.py metrics --mode scene
```

`validate` 不依赖模型，可随时运行。P0 结论只认 `metrics` 输出的准确率；样本数量本身不构成验收结论。
