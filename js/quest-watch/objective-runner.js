/**
 * 目标执行器（ObjectiveRunner）。
 *
 * 把“目标类型”翻译成具体键鼠动作：追踪、移动、到点交互、对话选项。
 * 导航逻辑参考 AutoCommissionNova 的 autoNavigateToTalk 与内置 AutoTrackTask，
 * 但改为单线程顺序循环，避免多任务并发时的状态竞争。
 *
 * 依赖 BGI JS 运行时全局：captureGameRegion / RecognitionObject / file / log / sleep /
 * keyPress / keyDown / keyUp / moveMouseBy / middleButtonClick / leftButtonClick。
 */

import { OBJECTIVE_TYPE } from "./objective-parser.js";

/** 屏幕中心 X，用于计算图标偏移。 */
const SCREEN_CENTER_X = 960;

/** 图标水平偏移在 ±80 内视为对准，可直行。 */
const ALIGN_TOLERANCE_X = 80;

/** 图标 Y 小于该值视为在镜头前方的可视范围。 */
const FRONT_Y_LIMIT = 540;

/** 对话选项 OCR 区域（来自 AutoCommissionNova 的 DIALOG_REGIONS.DIALOG_OPTIONS_OCR）。 */
const DIALOG_OPTIONS_ROI = Object.freeze({ x: 1250, y: 250, width: 550, height: 600 });

/** 交互提示区域参考值，仅用于避免误触，实际以按键反馈为准。 */
const ICON_TEMPLATE_PATH = "Data/RecognitionObject/IconTaskCommission.png";
const TALK_ICON_PATH = "Data/RecognitionObject/TalkIcon.png";
const TALK_ICON_ROI = Object.freeze({ x: 1260, y: 300, width: 90, height: 550 });

const templateCache = new Map();

/**
 * 懒加载模板。
 * @param {string} path 模板路径
 * @returns {Mat|null}
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
 * 构造默认的任务图标识别对象（全屏搜索普通委托图标）。
 * @returns {object|null}
 */
function defaultTaskIcon() {
    const template = getTemplate(ICON_TEMPLATE_PATH);
    if (!template) return null;
    return RecognitionObject.TemplateMatch(template, 0, 0, 1920, 1080);
}

/**
 * 判断是否进入对话界面（右侧出现对话气泡）。
 * @param {object} cap 截图区域
 * @returns {boolean}
 */
function isTalkUi(cap) {
    const template = getTemplate(TALK_ICON_PATH);
    if (!template) return false;
    const res = cap.Find(RecognitionObject.TemplateMatch(
        template, TALK_ICON_ROI.x, TALK_ICON_ROI.y, TALK_ICON_ROI.width, TALK_ICON_ROI.height
    ));
    return !res.isEmpty();
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
        area = cap.DeriveCrop(x, y, 130, 45);
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
 * 尝试点击与目标名匹配的对话选项；匹配不到时点击第一个选项。
 * @param {string} target 目标 NPC 名称，可为空
 * @returns {Promise<boolean>} 是否点击了选项
 */
async function pickTalkOption(target) {
    let cap = null;
    let area = null;
    try {
        cap = captureGameRegion();
        area = cap.DeriveCrop(DIALOG_OPTIONS_ROI.x, DIALOG_OPTIONS_ROI.y,
            DIALOG_OPTIONS_ROI.width, DIALOG_OPTIONS_ROI.height);
        const res = area.findMulti(RecognitionObject.ocrThis);
        if (res.count === 0) return false;

        let chosen = null;
        for (let i = 0; i < res.count; i++) {
            const text = (res[i].text || "").trim();
            if (target && text.includes(target)) {
                chosen = res[i];
                break;
            }
        }
        if (!chosen) chosen = res[0];

        log.info("选择对话选项: {text}", chosen.text);
        if (typeof chosen.click === "function") {
            chosen.click();
        } else {
            // 部分版本 OCR 结果不提供 click，退化为移动到区域中心后点击。
            moveMouseTo(DIALOG_OPTIONS_ROI.x + DIALOG_OPTIONS_ROI.width / 2,
                DIALOG_OPTIONS_ROI.y + DIALOG_OPTIONS_ROI.height / 2);
            leftButtonClick();
        }
        await sleep(200);
        return true;
    } catch (error) {
        log.warn("选择对话选项失败: {error}", error.message || error);
        return false;
    } finally {
        if (area) area.dispose();
        if (cap) cap.dispose();
    }
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
 * 追踪并移动到目标图标。
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

    while (Date.now() - startedAt < timeoutMs) {
        let cap = null;
        try {
            cap = captureGameRegion();

            if (requireTalk && isTalkUi(cap)) {
                return { ok: true, reason: "talk-ui", talk: true };
            }

            const icon = cap.Find(iconRo);
            if (icon.isEmpty()) {
                missingCount++;
                if (missingCount >= 8) {
                    return { ok: false, reason: "icon-lost", talk: false };
                }
                keyPress("v");
                await sleep(200);
                continue;
            }
            missingCount = 0;

            const distance = readDistanceUnderIcon(cap, icon);
            if (distance !== null && distance <= arriveDistance) {
                return { ok: true, reason: "arrived", talk: false };
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
 * @returns {Promise<{ok: boolean, reason: string, talk: boolean}>}
 */
export async function runObjective(objective, options = {}) {
    const iconRo = options.iconRo || defaultTaskIcon();
    if (!iconRo) {
        return { ok: false, reason: "icon-template-missing", talk: false };
    }

    const interactKey = options.interactKey || "f";

    switch (objective.type) {
        case OBJECTIVE_TYPE.TALK: {
            const nav = await navigateToIcon(iconRo, {
                requireTalk: true,
                follow: false,
                timeoutMs: options.timeoutMs,
            });
            if (!nav.ok) return nav;
            const talked = await pickTalkOption(objective.target);
            return { ok: talked, reason: talked ? "talk-option-clicked" : "no-option", talk: true };
        }

        case OBJECTIVE_TYPE.FOLLOW:
        case OBJECTIVE_TYPE.ESCORT: {
            // 跟随类目标不跳、速度更慢，出现对话即视为达成。
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
            const nav = await navigateToIcon(iconRo, { timeoutMs: options.timeoutMs });
            if (!nav.ok) return nav;
            const interaction = await interactAtTarget(interactKey);
            if (interaction.talk) {
                await pickTalkOption(objective.target);
            }
            return { ok: true, reason: "interacted", talk: interaction.talk };
        }

        default:
            return { ok: false, reason: "unsupported-type", talk: false };
    }
}
