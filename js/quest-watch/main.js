/**
 * QuestWatch 原型入口。
 *
 * 运行方式：把整个 quest-watch 目录复制到 BGI 的 User/JsScript/QuestWatch 后，
 * 在脚本列表中选择本脚本启动。直接放在仓库里不会被执行。
 *
 * 模式（settings.mode，缺省 listen）：
 * - listen：只监听并记录目标变化，不操作键鼠，用于 T1 验收；
 * - run：由导演层接管未编排目标，自动追踪、导航、交互，用于 T2/T3 验收。
 */

import { createObjectiveWatch } from "./objective-watch.js";
import { createDirector } from "./director.js";
import { runObjective } from "./objective-runner.js";

(async function () {
    setGameMetrics(1920, 1080, genshin.ScreenDpiScale);

    const config = typeof settings !== "undefined" && settings ? settings : {};
    const mode = config.mode === "run" ? "run" : "listen";
    const durationSec = Number(config.duration_sec) > 0 ? Number(config.duration_sec) : 1800;
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

    const watch = createObjectiveWatch({
        pollInterval: config.poll_interval_ms || 1000,
        confirmFrames: config.confirm_frames || 2,
        minDwellMs: config.min_dwell_ms || 2000,
    });

    const director = createDirector({
        watch,
        runner: { runObjective },
        // 监听模式把一切目标视为“已编排”，只记录不执行。
        isKnownObjective: () => mode === "listen",
        maxFailures,
        runOptions: { runCombat },
        onGiveUp: (objective) => log.warn("放弃目标，需要人工处理: {raw}", objective.raw),
    });

    director.start();

    const until = Date.now() + durationSec * 1000;
    while (Date.now() < until) {
        await sleep(1000);
    }

    director.stop();
    log.info("QuestWatch 结束，已输出样本日志: Logs/quest-watch/objectives.jsonl");
})();
