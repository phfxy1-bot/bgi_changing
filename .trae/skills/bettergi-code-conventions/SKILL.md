---
name: "bettergi-code-conventions"
description: "Enforces BetterGI repo coding, design, MVVM/XAML, JSON, input-timing and build-verification rules from AGENTS.md. Invoke before editing any code in this repository, or when reviewing changes."
---

# BetterGI 代码与改动规范

来源：仓库根目录 `AGENTS.md`（以及 `.agents/code-review.md`）。以下为硬性约定，违反会被要求返工。

## 1. 基础

- 使用 Windows 环境，使用简体中文沟通。
- C# 文件必须是 **UTF-8 无 BOM**。
- 保留已有注释，可修改或补充，不要随意删除。
- 无冲突时不要对类使用全路径。

## 2. 设计原则

- 先明确各层职责、边界和依赖方向，保持分层清晰，避免跨层耦合。
- 核心代码简洁易懂，直接表达业务意图，避免不必要的抽象和复杂度。
- 首次实现聚焦主流程与已明确需求，不为细微边界过度设计；暂不处理的场景用注释记录。
- UI 层可为交互体验承载必要复杂度，但仍须遵守 MVVM 与分层边界；UI/UX 直观易用。

## 3. 代码规范

- 新增类、属性、字段、方法必须有注释；核心逻辑、执行步骤、逻辑分块也要说明。
- 重要 C# 文件原则上只放一个类；枚举或用途单一的小类可合并存放。
- 可空类型用 `?` 标注。
- 私有字段 `_camelCase`，公共属性 `PascalCase`。
- **禁止新增 `BetterGenshinImpact/Assets` 目录**。资源由 `BetterGI.Assets.*` 外部包提供，新增资源需人工修改对应 NuGet 包。

## 4. 框架与 MVVM

主要依赖：WPF-UI 4.0.2、gong-wpf-dragdrop 3.2.1、CommunityToolkit.Mvvm 8.2.2、Microsoft.Xaml.Behaviors.Wpf 1.1.122。

- ViewModel 必须直接或间接继承 `ObservableObject`（项目 `ViewModel` 基类已满足）。
- 用 `[ObservableProperty]` 生成属性，用 `[RelayCommand]` 生成命令；异步命令返回 `Task`。
- View 通过构造函数注入 ViewModel，沿用所在页面的 `DataContext` 约定，XAML 绑定路径必须一致。
- **XAML 绑定只读属性、计算属性或纯展示文本时必须显式 `Mode=OneWay`**。`Run.Text` 默认双向绑定，绑只读属性会在加载 XAML 时抛异常。示例：`<Run Text="{Binding TriggerDirectory, Mode=OneWay}" />`。
- 只有需要回写可写属性的绑定才用 `Mode=TwoWay`；改动含 `Run.Text` 的视图时检查所有展示用绑定方向。
- 子视图构造时尚未加入父控件资源树：`StaticResource` 必须能在本视图或明确合并的字典中解析，禁止依赖稍后挂接的父视图资源。新增类别模板须验证实际实例化与布局，不能只以编译通过为准。
- 控件局部样式用 `BasedOn` 继承 WPF-UI 默认样式；承载类别视图的 `ContentControl` 须明确内容拉伸。
- 交互优先用 Behaviors，避免在代码后置写不符合 MVVM 的交互逻辑。
- 在 `App.xaml.cs` 注册依赖：页面用 `services.AddView<ExamplePage, ExampleViewModel>()`，单例用 `services.AddSingleton<IExampleService, ExampleService>()`。
- 新增窗口必须启用主题背景；简单对话框优先 `ThemedMessageBox`，不要用 WPF 自带 `MessageBox`。
- JSON 序列化优先 Newtonsoft.Json；模型若已由 System.Text.Json 序列化，则用 System.Text.Json 反序列化。

## 5. 识别与模拟操作

- 键鼠操作后再识图必须适当延时：游戏响应通常 30～60 ms，截图来源也有延迟。
- 键鼠操作之间也要有合理间隔，避免 30 fps 游戏丢输入。

## 6. 编译验证（唯一允许的验证方式）

**禁止直接运行主程序进行测试或截图**（包括启动 exe、`dotnet run`、通过 IDE 启动）。主程序要求管理员权限，harness 无法通过启动 exe 完成模拟测试与截图感知。

在仓库根目录执行：

```powershell
dotnet msbuild BetterGenshinImpact.sln -restore -p:Configuration=Debug -nologo -tl:off -clp:ErrorsOnly
```

- 退出码 0 = 成功，非 0 = 失败；只输出错误。
- 编译通过即可，无需运行程序；若因程序占用导致失败，停止验证并说明，不要反复重试。

## 7. 代码审查

仅在执行代码审查时，读取并遵循 `.agents/code-review.md`。
