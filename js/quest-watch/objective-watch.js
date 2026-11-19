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

/**
 * 主界面右下角的“停止追踪”按钮区域，用于判断当前是否有追踪目标。
 * 来源于 AutoCommissionNova 的 COMMISSION_TRACKING 常量。
 */
const STOP_TRACKING_REGION = Object.freeze({ x: 1626, y: 987, width: 127, height: 40 });

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
 * @returns {{ok: boolean, text: string, distance: number|null, inMainUi: boolean, hasTracking: boolean}}
 */
export function readMissionOnce() {
    const result = { ok: false, text: "", distance: null, inMainUi: false, hasTracking: false };

    const cap = captureGameRegion();
    try {
        let roi = { ...MISSION_ROI_OFFSET };
        const template = getTemplate(PAIMON_TEMPLATE_PATH);
        if (template) {
            const menu = cap.Find(RecognitionObject.TemplateMatch(template, 0, 0, 640, 216));
            if (menu.isEmpty()) {
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

        // 右下角“停止追踪”按钮存在，说明当前有追踪目标；模板缺失时跳过该判断。
        const stopTemplate = getTemplate("Data/RecognitionObject/TrackButton.png");
        if (stopTemplate) {
            const stopButton = cap.Find(RecognitionObject.TemplateMatch(
                stopTemplate,
                STOP_TRACKING_REGION.x, STOP_TRACKING_REGION.y,
                STOP_TRACKING_REGION.width, STOP_TRACKING_REGION.height
            ));
            result.hasTracking = !stopButton.isEmpty();
        }

        const ocrRo = RecognitionObject.Ocr(roi.x, roi.y, roi.width, roi.height);
        const texts = cap.findMulti(ocrRo);
        const parts = [];
        for (let i = 0; i < texts.count; i++) {
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
    } catch (error) {
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
        pollInterval = 1000,
        confirmFrames = 2,
        minDwellMs = 2000,
    } = options;

    const listeners = [];
    let timer = null;
    let running = false;

    /** 当前已确认的目标 */
    let current = null;
    /** 等待确认的候选目标 */
    let pending = null;
    let pendingCount = 0;
    let lastEmitAt = 0;

    /**
     * 处理一次采样结果。
     * @param {{ok: boolean, text: string, distance: number|null}} sample
     */
    function consume(sample) {
        if (!sample.ok) {
            // 对话/菜单/加载中读不到任务栏，保持当前状态等待恢复。
            return;
        }

        const objective = parseObjective(sample.text, sample.distance);
        if (!objective.normalized) return;

        if (current && objective.normalized === current.normalized) {
            // 文本未变，仅刷新距离，不视为变化。
            current.distance = objective.distance;
            pending = null;
            pendingCount = 0;
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
     * @returns {object|null} 当前目标
     */
    function poll() {
        consume(readMissionOnce());
        return current;
    }

    return {
        /** 订阅目标变化。 */
        onChange(listener) {
            listeners.push(listener);
        },
        /** 启动轮询。 */
        start() {
            if (running) return;
            running = true;
            poll();
            timer = setInterval(() => {
                if (!running) return;
                try {
                    poll();
                } catch (error) {
                    log.error("任务栏轮询异常: {error}", error.message || error);
                }
            }, pollInterval);
        },
        /** 停止轮询。 */
        stop() {
            running = false;
            if (timer) clearInterval(timer);
            timer = null;
        },
        /** 当前目标（可能为 null）。 */
        getCurrent() {
            return current;
        },
        /** 立即读取一次，忽略确认与驻留限制，便于手工排查。 */
        readNow() {
            const sample = readMissionOnce();
            return sample.ok ? parseObjective(sample.text, sample.distance) : null;
        },
    };
}
