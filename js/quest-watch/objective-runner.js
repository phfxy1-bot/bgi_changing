/**
 * 目标执行器（ObjectiveRunner）。
 *
 * 把“目标类型”翻译成具体键鼠动作：追踪、移动、到点交互、推进对话、远距离传送。
 * 导航逻辑参考 AutoCommissionNova 的 autoNavigateToTalk 与内置 AutoTrackTask，
 * 但改为单线程顺序循环，避免多任务并发时的状态竞争。
 *
 * 依赖 BGI JS 运行时全局：captureGameRegion / RecognitionObject / file / log / sleep /
 * keyPress / keyDown / keyUp / moveMouseBy / moveMouseTo / middleButtonClick /
 * leftButtonClick / genshin。
 */

import { OBJECTIVE_TYPE } from "./objective-parser.js";
import { readMissionOnce } from "./objective-watch.js";

/** 屏幕中心 X，用于计算图标偏移。 */
const SCREEN_CENTER_X = 960;

/** 图标水平偏移在 ±80 内视为对准，可直行。 */
const ALIGN_TOLERANCE_X = 80;

/** 图标 Y 小于该值视为在镜头前方的可视范围。 */
const FRONT_Y_LIMIT = 540;

/** 距离超过该值（米）先尝试传送；追踪栏距离是直线距离，只作触发条件。 */
const DISTANCE_FOR_TELEPORT = 150;

/** 单个目标允许的传送次数上限，避免“传送→卡住→再传送”死循环。 */
const MAX_TELEPORTS_PER_OBJECTIVE = 2;

/** 轮询窗口：连续该时长距离没有明显缩短，判定卡住。 */
const STALL_WINDOW_MS = 8000;

/** 判定“有进展”的最小距离变化（米）。 */
const MIN_PROGRESS_METERS = 3;

/** 对话选项 OCR 区域（来自 AutoCommissionNova 的 DIALOG_REGIONS.DIALOG_OPTIONS_OCR）。 */
const DIALOG_OPTIONS_ROI = Object.freeze({ x: 1250, y: 250, width: 550, height: 600 });

/** 交互提示与对话气泡的模板。 */
const ICON_TEMPLATE_PATH = "Data/RecognitionObject/IconTaskCommission.png";
const TALK_ICON_PATH = "Data/RecognitionObject/TalkIcon.png";
const TALK_ICON_ROI = Object.freeze({ x: 1260, y: 300, width: 90, height: 550 });

/** 大地图上的传送点图标（从游戏 1920x1080 素材复制到脚本目录）。 */
const MAP_ICON_SPECS = Object.freeze([
    { path: "Data/MapChooseIcon/TeleportWaypoint.png", threshold: 0.70 },
    { path: "Data/MapChooseIcon/StatueOfTheSeven.png", threshold: 0.75 },
    { path: "Data/MapChooseIcon/Domain.png", threshold: 0.75 },
]);

/** 大地图搜索区域，避开右侧面板与底部按钮。 */
const MAP_ICON_ROI = Object.freeze({ x: 60, y: 110, width: 1500, height: 820 });

/** 大地图右下角“切换追踪”按钮的点击点（1920x1080）。 */
const TRACKING_TOGGLE_POINT = Object.freeze({ x: 1795, y: 1050 });

/** 传送后等待主界面出现的上限。 */
const TELEPORT_SETTLE_MS = 20000;

const templateCache = new Map();

/** 已点击过的传送点像素坐标桶，避免同一传送点反复尝试。 */
const usedWaypointKeys = new Set();

/** 上一次执行的目标文本，用于判断是否换目标并清空传送点记忆。 */
let lastObjectiveKey = null;

/**
 * 懒加载模板。
 * @param {string} path 模板路径
 * @returns {Mat|null}
 */
function getTemplate(path) {
    if (templateCache.has(path)) return templateCache.get(path);
    try {
        const template = file.readImageMatSync(path);
        // 文件缺失时宿主返回空 Mat，直接参与匹配会报 !_src.empty()，这里显式判空。
        if (!template || !(template.Width > 0)) {
            log.warn("模板为空，相关识别已跳过: {path}", path);
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

/** @param {object} region @returns {number} */
function regionWidth(region) {
    return region.width !== undefined ? region.width : region.Width;
}

/** @param {object} region @returns {number} */
function regionX(region) {
    return region.x !== undefined ? region.x : region.X;
}

/** @param {object} region @returns {number} */
function regionY(region) {
    return region.y !== undefined ? region.y : region.Y;
}

/**
 * 从宿主返回的列表里取长度（兼容数组、.count、.Count 三种形态）。
 * @param {object} list
 * @returns {number}
 */
function listCount(list) {
    if (!list) return 0;
    if (typeof list.count === "number") return list.count;
    if (typeof list.Count === "number") return list.Count;
    if (typeof list.length === "number") return list.length;
    return 0;
}

/**
 * 按截图实际宽度缩放模板；宿主未暴露 OpenCvSharp 时退回原图。
 * @param {Mat} mat
 * @param {number} capWidth
 * @returns {Mat}
 */
function fitTemplate(mat, capWidth) {
    if (!capWidth || Math.abs(capWidth - 1920) < 4) return mat;
    try {
        const ratio = capWidth / 1920;
        const size = new OpenCvSharp.OpenCvSharp.Size(Math.round(mat.Width * ratio), Math.round(mat.Height * ratio));
        return mat.Resize(size);
    } catch {
        return mat;
    }
}

/**
 * 构造默认的任务图标识别对象（全屏搜索普通委托图标）。
 * @returns {object|null}
 */
function defaultTaskIcon() {
    const template = getTemplate(ICON_TEMPLATE_PATH);
    if (!template) return null;
    return RecognitionObject.templateMatch(template, 0, 0, 1920, 1080);
}

/**
 * 判断是否进入对话界面（右侧出现对话气泡）。
 * @param {object} cap 截图区域
 * @returns {boolean}
 */
function isTalkUi(cap) {
    const template = getTemplate(TALK_ICON_PATH);
    if (!template) return false;
    try {
        const res = cap.find(RecognitionObject.templateMatch(
            template, TALK_ICON_ROI.x, TALK_ICON_ROI.y, TALK_ICON_ROI.width, TALK_ICON_ROI.height
        ));
        return !res.isEmpty();
    } catch (error) {
        log.warn("对话气泡识别失败: {error}", error.message || error);
        return false;
    }
}

/**
 * 读取图标下方的距离文字。
 * @param {object} cap 截图区域
 * @param {{x: number, y: number}} icon 图标位置
 * @returns {number|null}
 */
function readDistanceUnderIcon(cap, icon) {
    let area = null;
    try {
        const x = Math.max(0, Math.round(icon.x - 55));
        const y = Math.max(0, Math.round(icon.y + 32));
        area = cap.deriveCrop(x, y, 130, 45);
        const res = area.find(RecognitionObject.ocrThis);
        const text = (res.text || "").replace(/[oO]/g, "0");
        const match = text.match(/(\d+)\s*(m|米)/i);
        return match ? Number(match[1]) : null;
    } catch {
        return null;
    } finally {
        if (area) area.dispose();
    }
}

/**
 * 读取对话选项；没有选项时返回 null。
 * @param {string} target 目标 NPC 名称，可为空
 * @returns {Promise<object|null>}
 */
async function readTalkOptions(target) {
    let cap = null;
    let area = null;
    try {
        cap = captureGameRegion();
        area = cap.deriveCrop(DIALOG_OPTIONS_ROI.x, DIALOG_OPTIONS_ROI.y,
            DIALOG_OPTIONS_ROI.width, DIALOG_OPTIONS_ROI.height);
        const res = await area.findMulti(RecognitionObject.ocrThis);
        const count = listCount(res);
        if (count === 0) return null;

        let chosen = null;
        for (let i = 0; i < count; i++) {
            const text = (res[i].text || "").trim();
            if (target && text.includes(target)) {
                chosen = res[i];
                break;
            }
        }
        return chosen || res[0];
    } catch (error) {
        log.warn("读取对话选项失败: {error}", error.message || error);
        return null;
    } finally {
        if (area) area.dispose();
        if (cap) cap.dispose();
    }
}

/**
 * 尝试点击与目标名匹配的对话选项；匹配不到时点击第一个选项。
 * @param {string} target 目标 NPC 名称，可为空
 * @returns {Promise<boolean>} 是否点击了选项
 */
async function pickTalkOption(target) {
    const option = await readTalkOptions(target);
    if (!option) return false;
    try {
        log.info("选择对话选项: {text}", option.text);
        if (typeof option.click === "function") {
            option.click();
        } else {
            // 部分版本 OCR 结果不提供 click，退化为移动到区域中心后点击。
            await moveMouseTo(DIALOG_OPTIONS_ROI.x + DIALOG_OPTIONS_ROI.width / 2,
                DIALOG_OPTIONS_ROI.y + DIALOG_OPTIONS_ROI.height / 2);
            await leftButtonClick();
        }
        await sleep(300);
        return true;
    } catch (error) {
        log.warn("点击对话选项失败: {error}", error.message || error);
        return false;
    }
}

/**
 * 在指定坐标点击一次。
 * @param {number} x
 * @param {number} y
 */
async function clickAt(x, y) {
    await moveMouseTo(Math.round(x), Math.round(y));
    await sleep(120);
    await leftButtonClick();
}

/**
 * 等待大地图打开（以能读到玩家地图坐标为准）。
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
async function waitBigMapOpen(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const position = genshin.getPositionFromBigMap();
            if (position) return true;
        } catch {
            // 地图未打开时宿主会抛异常，继续等待。
        }
        await sleep(250);
    }
    return false;
}

/**
 * 等待大地图关闭。
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
async function waitBigMapClosed(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const position = genshin.getPositionFromBigMap();
            if (!position) return true;
        } catch {
            return true;
        }
        await sleep(250);
    }
    return false;
}

/**
 * 关闭大地图并等待回到主界面。
 * @returns {Promise<void>}
 */
async function closeMap() {
    try {
        await keyPress("VK_ESCAPE");
    } catch {
        // 忽略按键异常。
    }
    await sleep(800);
}

/**
 * 等待主界面恢复（派蒙菜单图标可见）。
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
async function waitMainUi(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const status = await readMissionOnce();
        if (status.inMainUi) return true;
        await sleep(800);
    }
    return false;
}

/**
 * 在大地图上找出所有候选传送点。
 * @returns {Promise<Array<{x: number, y: number}>>}
 */
async function findWaypointsOnMap() {
    let cap = null;
    const points = [];
    try {
        cap = captureGameRegion();
        const capWidth = regionWidth(cap);
        for (const spec of MAP_ICON_SPECS) {
            const template = getTemplate(spec.path);
            if (!template) continue;
            let ro = null;
            try {
                ro = RecognitionObject.templateMatch(fitTemplate(template, capWidth),
                    MAP_ICON_ROI.x, MAP_ICON_ROI.y, MAP_ICON_ROI.width, MAP_ICON_ROI.height);
                try {
                    ro.threshold = spec.threshold;
                } catch { /* 阈值不可写时用默认值 */ }
                const res = await cap.findMulti(ro);
                const count = listCount(res);
                for (let i = 0; i < count; i++) {
                    const item = res[i];
                    if (!item) continue;
                    points.push({
                        x: regionX(item) + (regionWidth(item) || 0) / 2,
                        y: regionY(item) + ((item.height !== undefined ? item.height : item.Height) || 0) / 2,
                    });
                }
            } catch (error) {
                log.warn("传送点识别失败: {path} {error}", spec.path, error.message || error);
            } finally {
                if (ro && typeof ro.dispose === "function") ro.dispose();
            }
        }
    } catch (error) {
        log.warn("大地图截图失败: {error}", error.message || error);
    } finally {
        if (cap) cap.dispose();
    }
    return points;
}

/**
 * 传送到任务点附近的传送点。
 *
 * 依赖：任务追踪开启时打开地图会把任务点置于地图中心，因此按到中心的像素距离排序，
 * 取最近的候选依次尝试。距离仍大于阈值时由调用方再走一段或换下一个候选。
 *
 * @param {object} [options]
 * @param {number} [options.maxCandidates=3] 单次最多尝试的候选数量
 * @returns {Promise<{ok: boolean, reason: string}>}
 */
export async function teleportToQuest(options = {}) {
    const maxCandidates = options.maxCandidates || 3;

    const before = await readMissionOnce();
    if (!before.inMainUi) {
        return { ok: false, reason: "not-in-main-ui" };
    }

    try {
        await keyPress("j");
    } catch (error) {
        return { ok: false, reason: "map-key-failed" };
    }
    await sleep(1500);

    if (!await waitBigMapOpen(5000)) {
        await closeMap();
        return { ok: false, reason: "map-not-open" };
    }

    // 切换追踪两次：无论地图此前是否处于追踪态，都回到“任务点居中”。
    await clickAt(TRACKING_TOGGLE_POINT.x, TRACKING_TOGGLE_POINT.y);
    await sleep(250);
    await clickAt(TRACKING_TOGGLE_POINT.x, TRACKING_TOGGLE_POINT.y);
    await sleep(1400);

    const points = await findWaypointsOnMap();
    if (points.length === 0) {
        await closeMap();
        return { ok: false, reason: "no-waypoint" };
    }

    const centerX = 960;
    const centerY = 540;
    points.sort((a, b) =>
        (a.x - centerX) ** 2 + (a.y - centerY) ** 2 - ((b.x - centerX) ** 2 + (b.y - centerY) ** 2));

    let tried = 0;
    for (const point of points) {
        if (tried >= maxCandidates) break;
        const key = `${Math.round(point.x / 40)}:${Math.round(point.y / 40)}`;
        if (usedWaypointKeys.has(key)) continue;
        usedWaypointKeys.add(key);
        tried++;

        for (let attempt = 0; attempt < 2; attempt++) {
            await clickAt(point.x, point.y);
            await sleep(2200);
            if (await waitBigMapClosed(4000)) {
                log.info("已传送，等待主界面恢复");
                const settled = await waitMainUi(TELEPORT_SETTLE_MS);
                return { ok: settled, reason: settled ? "teleported" : "teleport-settle-timeout" };
            }
        }
    }

    await closeMap();
    log.warn("传送未生效：请确认 BGI 设置中已开启「快速传送」，否则点击传送点只会弹出列表");
    return { ok: false, reason: "teleport-click-failed" };
}

/**
 * 清空传送点记忆（换目标或重新开始一轮时调用）。
 */
export function resetWaypointMemory() {
    usedWaypointKeys.clear();
    lastObjectiveKey = null;
}

/**
 * 远距离预处理：距离大于阈值时先传送，传送后仍远则再试一次。
 * @returns {Promise<{ok: boolean, reason: string}>}
 */
async function ensureReachable() {
    for (let teleports = 0; teleports <= MAX_TELEPORTS_PER_OBJECTIVE; teleports++) {
        const status = await readMissionOnce();
        if (!status.ok) return { ok: true, reason: "tracker-unreadable" };
        if (status.distance === null || status.distance <= DISTANCE_FOR_TELEPORT) {
            return { ok: true, reason: "walkable" };
        }
        if (teleports === MAX_TELEPORTS_PER_OBJECTIVE) break;

        log.info("距离 {distance}m，尝试传送", status.distance);
        const tp = await teleportToQuest();
        if (!tp.ok) return { ok: false, reason: tp.reason };
    }
    return { ok: true, reason: "teleport-limit-reached" };
}

/**
 * 到达目标点后按交互键，直到进入对话或交互次数用尽。
 * @param {string} key 交互键，默认 f
 * @param {number} attempts 尝试次数
 * @returns {Promise<{talk: boolean}>}
 */
async function interactAtTarget(key = "f", attempts = 3) {
    for (let i = 0; i < attempts; i++) {
        keyPress(key);
        await sleep(900);

        let cap = null;
        try {
            cap = captureGameRegion();
            if (isTalkUi(cap)) return { talk: true };
        } finally {
            if (cap) cap.dispose();
        }
    }
    return { talk: false };
}

/**
 * 持续推进对话：有选项就点选项，没有选项就点击空白处继续。
 * @param {string} target 目标 NPC 名称，可为空
 * @param {number} timeoutMs 超时
 * @returns {Promise<{ok: boolean, reason: string}>}
 */
async function advanceDialogue(target, timeoutMs = 90000) {
    const deadline = Date.now() + timeoutMs;
    let absent = 0;

    while (Date.now() < deadline) {
        let cap = null;
        let talking = false;
        try {
            cap = captureGameRegion();
            talking = isTalkUi(cap);
        } finally {
            if (cap) cap.dispose();
        }

        if (!talking) {
            absent++;
            // 连续两次看不到气泡：可能是对话结束，也可能是过场；交给上层再读追踪栏。
            if (absent >= 2) return { ok: true, reason: "dialog-finished" };
            await sleep(800);
            continue;
        }
        absent = 0;

        const option = await readTalkOptions(target);
        if (option) {
            await pickTalkOption(target);
            await sleep(600);
        } else {
            await clickAt(960, 640);
            await sleep(700);
        }
    }
    return { ok: false, reason: "dialog-timeout" };
}

/**
 * 等待对话结束（不点击）。用于把对话推进交给 BGI 内置「自动剧情」的场景：
 * 两边同时点击会抢操作、选项选择也会互相矛盾，因此这里只做观察。
 * @param {number} timeoutMs 超时
 * @returns {Promise<{ok: boolean, reason: string}>}
 */
async function waitDialogueEnd(timeoutMs = 120000) {
    const deadline = Date.now() + timeoutMs;
    let absent = 0;

    while (Date.now() < deadline) {
        let cap = null;
        let talking = false;
        try {
            cap = captureGameRegion();
            talking = isTalkUi(cap);
        } finally {
            if (cap) cap.dispose();
        }

        if (!talking) {
            absent++;
            // 过场黑屏也会短暂看不到对话气泡，连续 3 次再判定结束。
            if (absent >= 3) return { ok: true, reason: "dialog-delegated" };
        } else {
            absent = 0;
        }
        await sleep(800);
    }
    return { ok: false, reason: "dialog-timeout" };
}

/**
 * 追踪并移动到目标图标，带卡死检测与侧移恢复。
 * @param {object} iconRo 图标识别对象
 * @param {object} [options]
 * @param {number} [options.timeoutMs=180000] 超时
 * @param {number} [options.arriveDistance=3] 到达判定距离（米）
 * @param {boolean} [options.follow=false] 跟随模式：低速、不跳
 * @param {boolean} [options.requireTalk=false] 出现对话气泡即视为到达
 * @returns {Promise<{ok: boolean, reason: string, talk: boolean}>}
 */
export async function navigateToIcon(iconRo, options = {}) {
    const {
        timeoutMs = 180000,
        arriveDistance = 3,
        follow = false,
        requireTalk = false,
    } = options;

    keyPress("v");
    await sleep(300);

    const startedAt = Date.now();
    let missingCount = 0;
    let step = 0;
    let stallCount = 0;
    let lastDistance = null;
    let lastProgressAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
        let cap = null;
        try {
            cap = captureGameRegion();

            if (requireTalk && isTalkUi(cap)) {
                return { ok: true, reason: "talk-ui", talk: true };
            }

            const icon = cap.find(iconRo);
            if (icon.isEmpty()) {
                missingCount++;
                if (missingCount >= 8) {
                    keyUp("w");
                    return { ok: false, reason: "icon-lost", talk: false };
                }
                keyPress("v");
                await sleep(200);
                continue;
            }
            missingCount = 0;

            const distance = readDistanceUnderIcon(cap, icon);
            if (distance !== null) {
                if (lastDistance === null || distance < lastDistance - MIN_PROGRESS_METERS) {
                    lastDistance = distance;
                    lastProgressAt = Date.now();
                }
            }
            if (distance !== null && distance <= arriveDistance) {
                keyUp("w");
                return { ok: true, reason: "arrived", talk: false };
            }

            if (Date.now() - lastProgressAt > STALL_WINDOW_MS) {
                // 距离长时间没有缩短：先侧移绕开地形/障碍，再交给上层换传送点。
                keyUp("w");
                stallCount++;
                if (stallCount > 3) {
                    return { ok: false, reason: "stalled", talk: false };
                }
                log.warn("导航卡住，侧移尝试 {count}", stallCount);
                await moveMouseBy(stallCount % 2 === 0 ? -220 : 220, 0);
                await sleep(200);
                keyDown("w");
                await sleep(1400);
                keyUp("w");
                lastProgressAt = Date.now();
                continue;
            }

            const offsetX = Math.round(icon.x - SCREEN_CENTER_X);
            if (Math.abs(offsetX) <= ALIGN_TOLERANCE_X && icon.y < FRONT_Y_LIMIT) {
                // 已对准，直接前进；跟随模式降低单步时长。
                keyDown("w");
                await sleep(follow ? 500 : (step % 2 === 0 ? 800 : 600));
                keyUp("w");
                step++;
            } else {
                // 未对准：先回中再转镜头，避免转头过程中持续位移。
                keyUp("w");
                middleButtonClick();
                await sleep(100);
                const deltaX = Math.max(-120, Math.min(120, Math.round(offsetX * 0.35)));
                moveMouseBy(deltaX, 0);
                await sleep(250);

                keyDown("w");
                await sleep(follow ? 400 : 700);
                keyUp("w");
                step++;

                if (!follow && step % 2 === 0 && distance !== null && distance > 15) {
                    // 距离较远时隔步跳跃，节省时间；跟随与护送不跳。
                    keyPress("VK_SPACE");
                    await sleep(250);
                }
            }
        } finally {
            if (cap) cap.dispose();
        }
    }

    keyUp("w");
    return { ok: false, reason: "timeout", talk: false };
}

/**
 * 执行一个已解析的目标。
 * @param {object} objective parseObjective 的返回值
 * @param {object} [options]
 * @param {object} [options.iconRo] 自定义图标识别对象
 * @param {object} [options.runCombat] 战斗回调（由上层注入，默认不支持）
 * @param {string} [options.interactKey="f"]
 * @param {boolean} [options.allowTeleport=true] 是否允许远距离传送
 * @param {boolean} [options.delegateDialogue=true] 对话是否交给 BGI「自动剧情」，本脚本只等待结束
 * @param {number} [options.dialogTimeoutMs] 对话等待超时
 * @returns {Promise<{ok: boolean, reason: string, talk: boolean}>}
 */
export async function runObjective(objective, options = {}) {
    const iconRo = options.iconRo || defaultTaskIcon();
    if (!iconRo) {
        return { ok: false, reason: "icon-template-missing", talk: false };
    }

    const key = objective.normalized || objective.raw || "";
    if (key !== lastObjectiveKey) {
        lastObjectiveKey = key;
        usedWaypointKeys.clear();
    }

    const interactKey = options.interactKey || "f";
    const allowTeleport = options.allowTeleport !== false;
    // 对话默认交给 BGI 内置「自动剧情」推进，本脚本只等待其结束，避免双方抢点击。
    const delegateDialogue = options.delegateDialogue !== false;
    const runDialog = (target) => (delegateDialogue
        ? waitDialogueEnd(options.dialogTimeoutMs)
        : advanceDialogue(target, options.dialogTimeoutMs));

    switch (objective.type) {
        case OBJECTIVE_TYPE.TALK: {
            if (allowTeleport) {
                const reach = await ensureReachable();
                if (!reach.ok) return { ok: false, reason: reach.reason, talk: false };
            }
            const nav = await navigateToIcon(iconRo, {
                requireTalk: true,
                follow: false,
                timeoutMs: options.timeoutMs,
            });
            if (!nav.ok) return nav;
            const dialog = await runDialog(objective.target);
            return { ok: dialog.ok, reason: dialog.reason, talk: true };
        }

        case OBJECTIVE_TYPE.FOLLOW:
        case OBJECTIVE_TYPE.ESCORT: {
            // 跟随/护送不能传送，否则会直接脱队；低速跟随，出现对话即视为达成。
            return await navigateToIcon(iconRo, {
                follow: true,
                requireTalk: true,
                timeoutMs: options.followTimeoutMs || 300000,
            });
        }

        case OBJECTIVE_TYPE.COMBAT: {
            if (typeof options.runCombat !== "function") {
                return { ok: false, reason: "combat-runner-unsupported", talk: false };
            }
            return await options.runCombat(objective);
        }

        case OBJECTIVE_TYPE.COLLECT:
        case OBJECTIVE_TYPE.INTERACT:
        case OBJECTIVE_TYPE.NAVIGATE: {
            if (allowTeleport) {
                const reach = await ensureReachable();
                if (!reach.ok) return { ok: false, reason: reach.reason, talk: false };
            }
            const nav = await navigateToIcon(iconRo, { timeoutMs: options.timeoutMs });
            if (!nav.ok) return nav;
            const interaction = await interactAtTarget(interactKey);
            if (interaction.talk) {
                const dialog = await runDialog(objective.target);
                return { ok: dialog.ok, reason: dialog.reason, talk: true };
            }
            return { ok: true, reason: "interacted", talk: false };
        }

        default:
            return { ok: false, reason: "unsupported-type", talk: false };
    }
}
