/**
 * 追踪栏监听器（QuestWatch）。
 *
 * 以 1Hz 采样小地图下方的任务目标文本，做归一化指纹与连续帧确认，
 * 只在“目标真的变化”时发出事件。不进入逐帧回路，也不调用模型。
 *
 * 依赖 BGI JS 运行时全局：captureGameRegion / RecognitionObject / file / log / sleep / genshin。
 * 坐标系固定为 setGameMetrics 后的 1920×1080 逻辑坐标。
 */

import { isDistanceFragment, parseDistance, parseObjective, stripPunctuation } from "./objective-parser.js";

/** 小地图上方派蒙头像模板，用于确认是否在主界面并据此定位任务栏。 */
const PAIMON_TEMPLATE_PATH = "Data/RecognitionObject/paimon_menu.png";

/**
 * 任务栏相对派蒙图标的偏移，来源于内置 AutoTrackTask：
 * ROI = (paimon.X, paimon.Y - 15 + 210, 300, 100)。
 */
const MISSION_ROI_OFFSET = Object.freeze({ x: 0, y: 190, width: 380, height: 130 });

/** 裸数字（去掉单位的距离），如 "85"；允许的最大合理距离。 */
const MAX_DISTANCE = 2000;

/** 任务目标关键字，用于回退采样时剔除地图/对话中的无关文字。 */
const OBJECTIVE_HINT = /前往|到达|移动至|回到|离开|进入|对话|交谈|询问|打听|击败|消灭|清除|讨伐|击退|打倒|收集|采集|拾取|获取|找到|调查|搜寻|查看|开启|触碰|阅读|使用|跟随|陪同|护送|交付|提交|完成/;

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
        // 追踪栏固定在屏幕左上（小地图下方），与派蒙图标匹配结果无关。
        // 派蒙只用来判断“是否在主界面”，不再参与 ROI 计算：
        // 实测模板命中率极低（30 分钟内 3471 次采样仅命中 262 次），
        // 若用它定位 ROI 会长期读偏。
        const roi = { ...MISSION_ROI_OFFSET };
        result.roi = roi;
        const template = getTemplate(PAIMON_TEMPLATE_PATH);
        if (template) {
            const menu = cap.find(RecognitionObject.templateMatch(template, 0, 0, 640, 216));
            result.inMainUi = !menu.isEmpty();
            if (!result.inMainUi) result.reason = "menu-missing";
            menu.dispose();
        }

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
                continue;
            }
            // OCR 常把 "85m" 的 m 丢掉，只剩裸数字；它属于距离，不应进入目标文本，
            // 否则目标键会在 "...|85" 和 "..." 之间反复抖动。
            if (/^\d{1,4}$/.test(text)) {
                const value = Number(text);
                if (result.distance === null && value <= MAX_DISTANCE) result.distance = value;
                continue;
            }
            // 单字/双字残片（如 "冰" "）"），是截断噪声，丢弃。
            if (text.length <= 2 && !OBJECTIVE_HINT.test(text)) continue;
            parts.push(text);
        }
        result.text = parts.join("|");
        result.ok = result.text.length > 0;
        result.reason = result.ok ? "ok" : "ocr-empty";

        // 回退采样（未识别主界面）时，用任务目标关键字过滤地图/对话里的噪声文本。
        if (result.ok && !result.inMainUi) {
            if (!OBJECTIVE_HINT.test(result.text) && result.distance === null) {
                result.ok = false;
                result.text = "";
                result.reason = "fallback-rejected";
            } else {
                result.reason = "fallback";
            }
        }
    } catch (error) {
        result.reason = "exception";
        log.warn("任务栏 OCR 异常: {error}", error.message || error);
    } finally {
        cap.dispose();
    }

    return result;
}

/**
 * OCR 偶尔少认/多认一个字（“解决突然出现的敌人” / “解决突然出现的敌”），
 * 归一化文本只差 1 个字且互为前后缀时按同一目标处理。
 * @param {string} a 归一化文本
 * @param {string} b 归一化文本
 * @returns {boolean}
 */
function isOcrTruncation(a, b) {
    if (!a || !b || a === b) return false;
    const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
    if (longer.length - shorter.length !== 1) return false;
    return longer.startsWith(shorter) || longer.endsWith(shorter);
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
    const stats = { samples: 0, inMainUi: 0, textOk: 0, menuMissing: 0, ocrEmpty: 0, exceptions: 0, fallback: 0, fallbackRejected: 0, lastText: "" };
    let lastDiagLogAt = 0;
    let lastEmptyWarnAt = 0;
    let lastRoi = null;

    function track(sample) {
        stats.samples++;
        if (sample.inMainUi) stats.inMainUi++;
        if (sample.ok) stats.textOk++;
        // reason 在读取阶段会被 ok/ocr-empty 覆盖，不能靠它统计主界面未识别。
        if (!sample.inMainUi) stats.menuMissing++;
        if (sample.reason === "ocr-empty") stats.ocrEmpty++;
        if (sample.reason === "exception") stats.exceptions++;
        if (sample.reason === "fallback") stats.fallback++;
        if (sample.reason === "fallback-rejected") stats.fallbackRejected++;
        if (sample.roi) lastRoi = sample.roi;
        if (sample.ok) stats.lastText = sample.text.length > 60 ? sample.text.slice(0, 60) + "..." : sample.text;

        const now = Date.now();

        // 每 10 秒输出一次汇总：采样约 2Hz，30 秒一次会显得“文本更新不及时”。
        if (now - lastDiagLogAt >= 10000) {
            lastDiagLogAt = now;
            log.info("采样统计 10s: 次数={samples} 主界面={inMainUi} 读到文字={textOk} 未识别主界面={menuMissing} OCR空={ocrEmpty} 回退采纳={fallback} 回退丢弃={fallbackRejected} 异常={exceptions} 当前文本={text}",
                stats.samples, stats.inMainUi, stats.textOk, stats.menuMissing, stats.ocrEmpty,
                stats.fallback, stats.fallbackRejected, stats.exceptions, stats.lastText || "无");
        }

        // 主界面已确认但读不到任务栏文字：ROI 偏移或该目标栏为空。
        if (sample.inMainUi && sample.reason === "ocr-empty" && now - lastEmptyWarnAt >= 30000) {
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

        if (current && (objective.normalized === current.normalized
                || isOcrTruncation(objective.normalized, current.normalized))) {
            // OCR 多认出一个字时，采用更长的写法作为规范文本。
            if (objective.normalized.length > current.normalized.length) {
                current.raw = objective.raw;
                current.core = objective.core;
                current.normalized = objective.normalized;
                current.type = objective.type;
                current.target = objective.target;
            }
            // 目标未变，仅刷新距离；若目标行文字变了（如进度计数），单独通知订阅者。
            current.distance = objective.distance;
            pending = null;
            pendingCount = 0;
            // 少认一个字属于 OCR 抖动，不重复打印“目标内文字变化”。
            if (sample.text !== current.raw && !isOcrTruncation(objective.core, current.core)) {
                const previousRaw = current.raw;
                // 标题行/状态行不参与比对，所以这里只可能是目标行本身的变化。
                const realVariant = stripPunctuation(objective.core) !== stripPunctuation(current.core);
                current.raw = sample.text;
                current.core = objective.core;
                const now = Date.now();
                if (realVariant && now - lastVariantAt >= minVariantMs) {
                    lastVariantAt = now;
                    const variant = { ...objective, variant: true, previousRaw };
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
