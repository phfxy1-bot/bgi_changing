---
name: "bettergi-github-pr-workflow"
description: "Standard GitHub fork/branch/commit/PR workflow for babalae/better-genshin-impact, including its PR template and default branch rules. Invoke when the user asks how to contribute, submit a PR, sync upstream, or prepare a change for review."
---

# BetterGI GitHub 贡献流程

适用于仓库 `babalae/better-genshin-impact`（GPL-3.0，无 CLA）。任何 GitHub 账号都可直接提 Issue / PR，不存在"申请加入开发者社区"的审批。

## 0. 每次动手前先确认默认分支

本项目**默认分支不是 `main`**（曾为 `refactor/20260930` 这类重构分支）。分支会变，必须先查：

```bash
gh repo view babalae/better-genshin-impact --json defaultBranchRef
# 或已有克隆时：
git remote show upstream | grep "HEAD branch"
```

后续命令中的 `<BASE>` 一律替换为查到的默认分支。

## 1. 先 Issue、后代码

- Issue 模板固定 5 种：`bug.yml` / `feature.yml` / `suggestion.yml` / `question.yml` / `normal.yml`，必须选模板填写，否则 repo-bot 可能直接关闭。
- **新功能必须先开 `feature` Issue 讨论**，得到维护者认可再写代码；直接提交大型 PR 被拒概率很高。
- 即时沟通渠道：README 中的 QQ 群 `1130033946`。

## 2. Fork → Clone → Upstream

```bash
# 1) 网页点 Fork
git clone https://github.com/<username>/better-genshin-impact.git
cd better-genshin-impact
git remote add upstream https://github.com/babalae/better-genshin-impact.git
```

## 3. 切工作分支

```bash
git fetch upstream
git checkout -b feat/<topic> upstream/<BASE>
```

命名沿用仓库风格：`feat/xxx`、`fix/xxx`、`refactor/xxx`。**不要**直接在上游默认分支上改。

## 4. 改动与编译验证

- 环境：Windows + .NET 10 SDK + Windows 10 SDK 22621（`net10.0-windows10.0.22621.0`，WPF）。
- 编译：`dotnet build BetterGenshinImpact.sln -c Debug`（PR 模板写死的验收命令）。
- 编码、MVVM、XAML 等硬性规范见另一个 skill **bettergi-code-conventions**，动手前必须加载。
- 一次改动只做一件事，不混入无关的大规模重构。

## 5. Commit

```bash
git add <具体文件>          # 不要 git add .
git commit -m "$(cat <<'EOF'
<一句话说明为什么改>

<补充背景：原行为、问题场景、预期结果>
EOF
)"
```

说明写"为什么"，不是"改了什么文件"。

## 6. Push 与发起 PR

```bash
git push origin feat/<topic>
```

网页点 "Compare & pull request"，**base 仓库选 `babalae/better-genshin-impact`，base 分支选 `<BASE>`**；head 选你自己的分支。base 选错会让 PR 混入大量无关提交。

## 7. PR 模板必填项（缺项会被直接关闭）

1. **解决的需求**：什么场景下需要它，而不是改了哪些代码。
2. **是否在游戏内实际运行**：二选一；若已运行需填游戏版本、分辨率与窗口模式、验证功能、验证次数与时长、结果。
3. **代码来源声明**：纯手工 / 部分 AI / 全 AI，并**列出具体模型名称**；须声明已逐行理解并能解释每一行。
4. **影响范围与风险**：涉及模块、兼容性、行为变化。
5. 勾选"已搜索重复 Issue""可通过 Debug 编译""改动聚焦"。

## 8. 同步上游（PR 挂起期间）

```bash
git fetch upstream
git rebase upstream/<BASE>
git push --force-with-lease origin feat/<topic>   # 仅在自己的分支上可用
```

小步提交、尽早提 PR，避免长期冲突。

## 9. 禁止与常见坑

- 不提交本地配置、日志、`User/` 目录、`bin/`、`obj/`。
- 不新增 `BetterGenshinImpact/Assets` 目录（资源由 `BetterGI.Assets.*` 外部包提供）。
- 不要用启动主程序（exe / `dotnet run`）做验证，见 bettergi-code-conventions。
- 涉及游戏内行为的改动，维护者会要求截图/录屏/日志证据。
- GPL-3.0：提交即按 GPL 授权，不能把本项目代码搬入闭源项目。

## 10. 首次贡献的建议顺序

1. 观察：Star / Watch 仓库，读若干已合并 PR。
2. 提一个带日志与复现步骤的 Issue。
3. 文档、文案、翻译（`Docs/i18n`）等低风险改动。
4. 单文件小 bug 修复。
5. 新功能：先 Issue 对齐，再实现。
