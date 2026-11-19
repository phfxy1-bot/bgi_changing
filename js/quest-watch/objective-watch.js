/**
 * 追踪栏监听器（QuestWatch）。
 *
 * 以 1Hz 采样小地图下方的任务目标文本，做归一化指纹与连续帧确认，
 * 只在“目标真的变化”时发出事件。不进入逐帧回路，也不调用模型。
 *
 * 依赖 BGI JS 运行时全局：captureGameRegion / RecognitionObject / file / log / sleep / genshin。
 * 坐标系固定为 setGameMetrics 后的 1920×1080 逻辑坐标。
 */

import { isDistanceFragment, normalizeObjective, parseDistance, parseObjective } from "./objective-parser.js";

/** 小地图上方派蒙头像模板，用于确认是否在主界面并据此定位任务栏。 */
const PAIMON_TEMPLATE_PATH = "Data/RecognitionObject/paimon_menu.png";

/**
 * 任务栏相对派蒙图标的偏移，来源于内置 AutoTrackTask：
 * ROI = (paimon.X, paimon.Y - 15 + 210, 300, 100)。
 */
const MISSION_ROI_OFFSET = Object.freeze({ x: 0, y: 195, width: 300, height: 100 });

/** 模板缓存，避免每轮都读取图片造成句柄泄漏。 */
const templateCache = new Map();

/**
 * 懒加载模板图片。
 * @param {string} path 模板路径
 * @returns {Mat|null} 模板图片，读取失败返回 null
 */
function getTemplate(path) {
    if (templateCache.has(path)) return templateCache.get(path);
    try {
        const template = file.ReadImageMatSync(path);
        // 文件不存在时 BGI 返回空 Mat 而不抛异常，必须显式判空，否则后续匹配会报 !_src.empty()。
        if (!template || !(template.Width > 0)) {
            log.warn("模板为空，跳过该判断: {path}", path);
            templateCache.set(path, null);
            return null;
        }
        templateCache.set(path, template);
        return template;
    } catch (error) {
        log.warn("读取模板失败: {path} {error}", path, error.message || error);
        templateCache.set(path, null);
        return null;
    }
}

/**
 * 读取一次追踪栏文本。
 * @returns {Promise<{ok: boolean, text: string, distance: number|null, inMainUi: boolean}>}
 */
export async function readMissionOnce() {
    const result = { ok: false, text: "", distance: null, inMainUi: false, reason: "unknown", roi: null };

    const cap = captureGameRegion();
    try {
        let roi = { ...MISSION_ROI_OFFSET };
        const template = getTemplate(PAIMON_TEMPLATE_PATH);
        if (template) {
            const menu = cap.find(RecognitionObject.templateMatch(template, 0, 0, 640, 216));
            if (menu.isEmpty()) {
                // 主界面之外（对话/地图/加载）读不到任务栏，属预期；但必须留痕，否则无法区分“没在跑”和“一直在跳过”。
                result.reason = "menu-missing";
                return result;
            }
            result.inMainUi = true;
            roi = {
                x: Math.round(menu.x + MISSION_ROI_OFFSET.x),
                y: Math.round(menu.y + MISSION_ROI_OFFSET.y),
                width: MISSION_ROI_OFFSET.width,
                height: MISSION_ROI_OFFSET.height,
            };
        }
        result.roi = roi;

        const ocrRo = RecognitionObject.ocr(roi.x, roi.y, roi.width, roi.height);
        // findMulti 在 BGI 宿主里返回可等待的列表对象，必须 await，否则拿到的是 Promise。
        const texts = await cap.findMulti(ocrRo);
        const count = texts && texts.count !== undefined ? texts.count : (texts ? texts.length : 0);
        const parts = [];
        for (let i = 0; i < count; i++) {
            const text = (texts[i].text || "").trim();
            if (!text) continue;
            if (isDistanceFragment(text)) {
                result.distance = parseDistance(text);
            } else {
                parts.push(text);
            }
        }
        result.text = parts.join("|");
        result.ok = result.text.length > 0;
        result.reason = result.ok ? "ok" : "ocr-empty";
    } catch (error) {
        result.reason = "exception";
        log.warn("任务栏 OCR 异常: {error}", error.message || error);
    } finally {
        cap.dispose();
    }

    return result;
}

/**
 * 创建任务变更监听器。
 * @param {object} [options]
 * @param {number} [options.pollInterval=1000] 采样间隔（毫秒）
 * @param {number} [options.confirmFrames=2] 连续确认帧数，过滤 OCR 抖动
 * @param {number} [options.minDwellMs=2000] 两次变化事件的最小间隔
 * @returns {{start: Function, stop: Function, getCurrent: Function, onChange: Function, readNow: Function}}
 */
export function createObjectiveWatch(options = {}) {
    const {
        // 追踪栏文字在对话推进时变化很快，1Hz 容易漏掉短暂目标。
        pollInterval = 500,
        confirmFrames = 2,
        minDwellMs = 1000,
    } = options;

    const listeners = [];
    /** 仅用于“同一目标内文字细节变化”（如进度 0/3 -> 1/3）的订阅者 */
    const variantListeners = [];
    /** 轮询代次，stop 后令旧循环自然退出（V8 运行时没有 setInterval）。 */
    let loopToken = 0;
    let running = false;
    /**
     * 正在进行的采样 Promise。
     * 脚本结束时若仍有采样在途，V8 引擎销毁后访问宿主对象会抛 ObjectDisposedException，
     * 因此 stop 必须等待它在途完成再返回。
     */
    let inFlight = null;

    /** 当前已确认的目标 */
    let current = null;
    /** 等待确认的候选目标 */
    let pending = null;
    let pendingCount = 0;
    let lastEmitAt = 0;
    let lastVariantAt = 0;
    const minVariantMs = options.minVariantMs || 1000;

    /**
     * 采样诊断统计。
     * 目的：把“脚本没跑”“一直在跳过采样”“OCR 读空”三种沉默区分开，
     * 否则主日志里除了启动/结束什么都没有，无法定位问题。
     */
    const stats = { samples: 0, inMainUi: 0, textOk: 0, menuMissing: 0, ocrEmpty: 0, exceptions: 0 };
    let lastDiagLogAt = 0;
    let lastMissWarnAt = 0;
    let lastEmptyWarnAt = 0;
    let lastRoi = null;

    function track(sample) {
        stats.samples++;
        if (sample.inMainUi) stats.inMainUi++;
        if (sample.ok) stats.textOk++;
        if (sample.reason === "menu-missing") stats.menuMissing++;
        if (sample.reason === "ocr-empty") stats.ocrEmpty++;
        if (sample.reason === "exception") stats.exceptions++;
        if (sample.roi) lastRoi = sample.roi;

        const now = Date.now();

        // 每 30 秒输出一次汇总，即使零事件也能看出采样是否在工作。
        if (now - lastDiagLogAt >= 30000) {
            lastDiagLogAt = now;
            log.info("采样统计 30s: 次数={samples} 主界面={inMainUi} 读到文字={textOk} 未识别主界面={menuMissing} OCR空={ocrEmpty} 异常={exceptions}",
                stats.samples, stats.inMainUi, stats.textOk, stats.menuMissing, stats.ocrEmpty, stats.exceptions);
        }

        // 连续未识别主界面：多半是分辨率/缩放与模板不匹配，或一直停在对话/地图。
        if (sample.reason === "menu-missing" && now - lastMissWarnAt >= 30000) {
            lastMissWarnAt = now;
            log.warn("未识别到主界面（派蒙图标未匹配），已跳过采样；若持续出现请检查游戏分辨率与 Data/RecognitionObject/paimon_menu.png");
        }

        // 主界面已确认但读不到任务栏文字：ROI 偏移或该目标栏为空。
        if (sample.reason === "ocr-empty" && now - lastEmptyWarnAt >= 30000) {
            lastEmptyWarnAt = now;
            const roi = lastRoi || MISSION_ROI_OFFSET;
            log.warn("主界面已识别但任务栏 OCR 为空，ROI=({x},{y},{w},{h})",
                roi.x, roi.y, roi.width, roi.height);
        }
    }

    /**
     * 处理一次采样结果。
     * @param {{ok: boolean, text: string, distance: number|null}} sample
     */
    function consume(sample) {
        // 已停止后不再回调与写日志，避免脚本销毁后再访问宿主对象。
        if (!running) return;
        if (!sample.ok) {
            // 对话/菜单/加载中读不到任务栏，保持当前状态等待恢复。
            return;
        }

        const objective = parseObjective(sample.text, sample.distance);
        if (!objective.normalized) return;

        if (current && objective.normalized === current.normalized) {
            // 目标未变，仅刷新距离；若原始文字变了（如进度计数），单独通知订阅者。
            current.distance = objective.distance;
            pending = null;
            pendingCount = 0;
            if (sample.text !== current.raw) {
                const variant = { ...objective, variant: true, previousRaw: current.raw };
                current.raw = sample.text;
                const now = Date.now();
                if (now - lastVariantAt >= minVariantMs) {
                    lastVariantAt = now;
                    log.info("目标内文字变化: [{from}] -> [{to}]", variant.previousRaw, variant.raw);
                    for (const listener of variantListeners) {
                        try {
                            listener(variant, current);
                        } catch (error) {
                            log.error("目标内文字回调异常: {error}", error.message || error);
                        }
                    }
                }
            }
            return;
        }

        if (pending && objective.normalized === pending.normalized) {
            pendingCount++;
            pending.distance = objective.distance;
        } else {
            pending = objective;
            pendingCount = 1;
        }

        if (pendingCount < confirmFrames) return;

        const now = Date.now();
        if (now - lastEmitAt < minDwellMs) return;

        const previous = current;
        current = pending;
        pending = null;
        pendingCount = 0;
        lastEmitAt = now;

        log.info("目标变化: [{from}] -> [{to}] 类型={type} 距离={distance}",
            previous ? previous.raw : "无",
            current.raw,
            current.type,
            current.distance);
        for (const listener of listeners) {
            try {
                listener(current, previous);
            } catch (error) {
                log.error("目标变化回调异常: {error}", error.message || error);
            }
        }
    }

    /**
     * 执行一次采样。
     * @returns {Promise<object|null>} 当前目标
     */
    async function poll() {
        const sample = await readMissionOnce();
        track(sample);
        consume(sample);
        return current;
    }

    return {
        /** 订阅目标变化。 */
        onChange(listener) {
            listeners.push(listener);
        },
        /** 订阅“目标未变但文字细节变了”（进度、计数等）。 */
        onVariant(listener) {
            variantListeners.push(listener);
        },
        /** 启动轮询。 */
        start() {
            if (running) return;
            running = true;
            const token = ++loopToken;
            // BGI 的 V8 宿主没有 setInterval，用 sleep 驱动的异步循环替代。
            (async () => {
                inFlight = poll();
                try {
                    await inFlight;
                } catch (error) {
                    if (running) log.error("任务栏首次采样异常: {error}", error.message || error);
                } finally {
                    inFlight = null;
                }
                while (running && token === loopToken) {
                    await sleep(pollInterval);
                    if (!running || token !== loopToken) break;
                    inFlight = poll();
                    try {
                        await inFlight;
                    } catch (error) {
                        if (running) log.error("任务栏轮询异常: {error}", error.message || error);
                    } finally {
                        inFlight = null;
                    }
                }
            })();
        },
        /**
         * 停止轮询。
         * 等待在途采样结束，确保脚本返回前不再访问宿主对象。
         */
        async stop() {
            running = false;
            loopToken++;
            if (inFlight) {
                try {
                    await inFlight;
                } catch (error) {
                    // 停止阶段的异常无需上报，调用方只关心是否已静默。
                }
            }
        },
        /** 采样诊断统计，供结束日志汇总。 */
        getStats() {
            return { ...stats };
        },
        /** 当前目标（可能为 null）。 */
        getCurrent() {
            return current;
        },
        /** 立即读取一次，忽略确认与驻留限制，便于手工排查。 */
        async readNow() {
            const sample = await readMissionOnce();
            return sample.ok ? parseObjective(sample.text, sample.distance) : null;
        },
    };
}
