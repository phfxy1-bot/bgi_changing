/**
 * 导演层（Director）。
 *
 * 把监听器与执行器串起来，并落实计划第 11 节的接管规则：
 * 1. 内容库已编排的目标由上层接管，本层不重复执行；
 * 2. 未编排的新目标交给通用执行器；
 * 3. 同一目标连续失败达到上限后放弃，并把样本落盘；
 * 4. 任何时候只允许一个目标在执行，避免并发抢键鼠。
 */

import { isRunnerSupported } from "./objective-parser.js";

/** 目标样本日志路径，T5 的落盘产物，可直接作为 P0 语料。 */
const SAMPLE_LOG_PATH = "Logs/quest-watch/objectives.log";

/**
 * 追加一条目标样本到日志文件。
 * @param {object} objective 目标对象
 * @param {string} outcome 结果（skipped / success / failed / give-up）
 */
function appendSample(objective, outcome) {
    try {
        const line = JSON.stringify({
            time: new Date().toISOString(),
            outcome,
            raw: objective.raw,
            normalized: objective.normalized,
            type: objective.type,
            target: objective.target,
            distance: objective.distance,
        });
        file.WriteTextSync(SAMPLE_LOG_PATH, line + "\n", true);
    } catch (error) {
        log.warn("写入目标样本失败: {error}", error.message || error);
    }
}

/**
 * 创建导演层。
 * @param {object} deps
 * @param {object} deps.watch createObjectiveWatch 的返回值
 * @param {object} deps.runner 执行器模块，需提供 runObjective
 * @param {Function} [deps.isKnownObjective] 判断目标是否已被内容库编排
 * @param {Function} [deps.onGiveUp] 放弃回调，参数为目标与失败次数
 * @param {number} [deps.maxFailures=2] 同一目标允许的连续失败次数
 * @param {object} [deps.runOptions] 透传给执行器的选项
 * @returns {{start: Function, stop: Function, isBusy: Function}}
 */
export function createDirector(deps) {
    const {
        watch,
        runner,
        isKnownObjective = () => false,
        onGiveUp = null,
        maxFailures = 2,
        runOptions = {},
    } = deps;

    /** 同一目标的连续失败计数 */
    const failures = new Map();
    let busy = false;
    let running = true;

    /**
     * 处理一次目标变化事件。
     * @param {object} objective 当前目标
     * @param {object|null} previous 上一目标
     */
    async function handle(objective, previous) {
        if (!running) return;

        if (isKnownObjective(objective)) {
            appendSample(objective, "skipped");
            log.info("目标被跳过，仅记录样本: {raw}", objective.raw);
            return;
        }

        if (!isRunnerSupported(objective.type)) {
            appendSample(objective, "failed");
            log.warn("目标类型无法由通用执行器处理: {type} {raw}", objective.type, objective.raw);
            return;
        }

        if (busy) {
            // 上一目标仍在执行，本轮变化只记录不抢执行权。
            log.warn("执行器忙，忽略新目标: {raw}", objective.raw);
            return;
        }

        busy = true;
        try {
            log.info("QuestWatch 接管: {raw}", objective.raw);
            const result = await runner.runObjective(objective, runOptions);
            const count = (failures.get(objective.normalized) || 0) + 1;

            if (result.ok) {
                failures.delete(objective.normalized);
                appendSample(objective, "success");
                log.info("目标执行完成: {raw} ({reason})", objective.raw, result.reason);
                return;
            }

            failures.set(objective.normalized, count);
            log.warn("目标执行失败: {raw} ({reason})，连续失败 {count}/{max}",
                objective.raw, result.reason, count, maxFailures);

            if (count >= maxFailures) {
                failures.delete(objective.normalized);
                appendSample(objective, "give-up");
                if (typeof onGiveUp === "function") {
                    onGiveUp(objective, count);
                }
            }
        } catch (error) {
            log.error("目标执行异常: {error}", error.message || error);
        } finally {
            busy = false;
        }

        // 防止上一目标的异步收尾与新目标交错。
        if (previous) await sleep(0);
    }

    watch.onChange((objective, previous) => {
        // 事件回调不等待：执行在后台完成，期间新事件按 busy 规则丢弃。
        handle(objective, previous);
    });

    return {
        /** 开始接管。 */
        start() {
            running = true;
            watch.start();
        },
        /** 停止接管并释放轮询。 */
        stop() {
            running = false;
            watch.stop();
        },
        /** 是否有目标正在执行。 */
        isBusy() {
            return busy;
        },
    };
}
