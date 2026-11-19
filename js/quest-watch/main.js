/**
 * QuestWatch 原型入口。
 *
 * 运行方式：把整个 quest-watch 目录复制到 BGI 的 User/JsScript/QuestWatch 后，
 * 在脚本列表中选择本脚本启动。直接放在仓库里不会被执行。
 *
 * 模式（settings.mode，缺省 listen）：
 * - listen：只监听并记录目标变化，不操作键鼠，用于 T1 验收；
 * - run：由导演层接管未编排目标，自动追踪、导航、交互，用于 T2/T3 验收。
 *
 * 设置项（settings.json，均可省略）：
 * - mode：listen / run；
 * - duration_min：运行时长（分钟，默认 30）；
 * - max_failures：同一目标连续失败上限（默认 2）；
 * - delegate_dialogue：对话是否交给 BGI「自动剧情」推进（默认 true）。
 *   为 true 时本脚本只等待对话结束，不点击选项，避免和自动剧情抢操作；
 *   为 false 时由脚本自己点击推进（需关闭自动剧情）。
 */

import { createObjectiveWatch } from "./objective-watch.js";
import { createDirector } from "./director.js";
import { runObjective } from "./objective-runner.js";

(async function () {
    setGameMetrics(1920, 1080, genshin.screenDpiScale);

    const config = typeof settings !== "undefined" && settings ? settings : {};
    const mode = config.mode === "run" ? "run" : "listen";
    const durationMin = Number(config.duration_min) > 0 ? Number(config.duration_min) : 30;
    const durationSec = durationMin * 60;
    const maxFailures = Number(config.max_failures) > 0 ? Number(config.max_failures) : 2;

    log.info("QuestWatch 启动，模式={mode}，时长={duration}s", mode, durationSec);

    /**
     * 战斗回调：复用 BGI 内置 AutoFight 任务。
     * @returns {Promise<{ok: boolean, reason: string, talk: boolean}>}
     */
    async function runCombat() {
        log.info("目标类型为战斗，调用 AutoFight");
        await dispatcher.runTask(new SoloTask("AutoFight"));
        return { ok: true, reason: "combat-done", talk: false };
    }

    // 采样节奏由监听器内部的默认值决定：500ms 轮询 + 2 帧确认 + 1s 最小间隔。
    const watch = createObjectiveWatch();

    const director = createDirector({
        watch,
        runner: { runObjective },
        // 监听模式只落样本，不执行任何键鼠动作。
        dryRun: mode === "listen",
        maxFailures,
        runOptions: { runCombat, delegateDialogue: config.delegate_dialogue !== false },
        onGiveUp: (objective) => log.warn("放弃目标，需要人工处理: {raw}", objective.raw),
    });

    director.start();

    const until = Date.now() + durationSec * 1000;
    while (Date.now() < until) {
        await sleep(1000);
    }

    // 必须等待停止完成：残留的在途采样会在 V8 引擎销毁后访问宿主对象，
    // 触发 ObjectDisposedException（日志里的“非致命异常”即由此而来）。
    await director.stop();
    log.info("QuestWatch 结束，已输出样本日志: Logs/quest-watch/objectives.log");
})();
