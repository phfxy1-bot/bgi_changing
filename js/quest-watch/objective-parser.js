/**
 * 任务目标文本解析（纯函数，不依赖游戏运行时）。
 *
 * 输入：追踪栏 OCR 得到的原始文本（可能包含多段文字与距离）。
 * 输出：{ raw, normalized, type, target, distance }。
 *
 * 类型是封闭枚举，未知文本返回 unknown，由上层决定是否交给模型或放弃。
 */

/** 目标类型枚举，与计划第 11 节保持一致。 */
export const OBJECTIVE_TYPE = Object.freeze({
    /** 前往某地，需要移动 */
    NAVIGATE: "navigate",
    /** 与某人对话 */
    TALK: "talk",
    /** 跟随目标 */
    FOLLOW: "follow",
    /** 战斗 */
    COMBAT: "combat",
    /** 采集 / 拾取 */
    COLLECT: "collect",
    /** 调查 / 开启 / 阅读等单次交互 */
    INTERACT: "interact",
    /** 护送 */
    ESCORT: "escort",
    /** 无法识别 */
    UNKNOWN: "unknown",
});

/**
 * 关键词规则表。
 * 顺序即优先级：更具体的动作放在前面，避免“跟随”被“前往”抢先匹配。
 */
const RULES = [
    { type: OBJECTIVE_TYPE.ESCORT, patterns: [/护送/] },
    { type: OBJECTIVE_TYPE.FOLLOW, patterns: [/跟随/, /陪同/, /跟上/] },
    { type: OBJECTIVE_TYPE.COMBAT, patterns: [/击败/, /消灭/, /清除/, /讨伐/, /击退/, /打倒/, /敌人/, /敌袭/, /对抗/] },
    { type: OBJECTIVE_TYPE.COLLECT, patterns: [/收集/, /采集/, /拾取/, /获取/, /找到/] },
    { type: OBJECTIVE_TYPE.INTERACT, patterns: [/调查/, /搜寻/, /查看/, /开启/, /触碰/, /阅读/, /使用/, /观察/, /召唤/, /补给/] },
    { type: OBJECTIVE_TYPE.TALK, patterns: [/对话/, /交谈/, /询问/, /打听/, /说明/, /联络/, /告知/, /汇报/] },
    { type: OBJECTIVE_TYPE.NAVIGATE, patterns: [/前往/, /到达/, /移动至/, /回到/, /离开/, /进入/, /寻找/, /找寻/, /返回/, /飞向/, /赶赴/] },
];

/**
 * 去掉空白与标点，保留数字。
 * 用于判断两条文本是否只是 OCR 标点抖动（如「」/」/】、逗号、分段竖线）。
 * @param {string} text 原始文本
 * @returns {string} 去标点后的文本
 */
export function stripPunctuation(text) {
    if (!text) return "";
    return String(text)
        .replace(/[\s\u3000]/g, "")
        .replace(/[^\u4e00-\u9fa5a-zA-Z0-9+#]/g, "")
        .trim();
}

/**
 * 归一化目标文本：去掉空白与标点，把连续数字折叠为 #。
 * 这样“收集 3 个苹果”和“收集 5 个苹果”会得到同一个指纹，避免数字变化引起误报。
 * @param {string} text 原始文本
 * @returns {string} 归一化文本
 */
export function normalizeObjective(text) {
    if (!text) return "";
    return stripPunctuation(text).replace(/\d+/g, "#");
}

/**
 * 距离上限（米）。
 * 追踪栏 OCR 偶发把相邻数字拼进来；样本里出现过 10345 这类不合理值，
 * 超过上限按“距离未知”处理（null），避免触发错误的传送决策。
 */
export const MAX_PLAUSIBLE_DISTANCE = 5000;

/**
 * 从文本中解析距离（米）。
 * @param {string} text 原始文本
 * @returns {number|null} 距离，无法解析或数值不合理时为 null
 */
export function parseDistance(text) {
    if (!text) return null;
    const normalized = String(text).replace(/[oO]/g, "0");
    const match = normalized.match(/(\d+)\s*(m|米)/i);
    if (!match) return null;
    const value = Number(match[1]);
    if (!Number.isFinite(value) || value <= 0 || value > MAX_PLAUSIBLE_DISTANCE) return null;
    return value;
}

/**
 * 判断文本是否是“距离片段”（如 “123m”），用于从多段 OCR 结果中挑出距离。
 * @param {string} text
 * @returns {boolean}
 */
export function isDistanceFragment(text) {
    if (!text) return false;
    const trimmed = text.trim();
    return trimmed.length < 8 && /(m|米)/i.test(trimmed) && parseDistance(trimmed) !== null;
}

/**
 * 从“与XX对话”一类文本中提取目标名。
 * @param {string} text 归一化前的原始文本
 * @param {string} type 目标类型
 * @returns {string} 目标名，提取失败返回空串
 */
export function extractTarget(text, type) {
    if (!text) return "";
    const source = String(text).replace(/[\s\u3000]/g, "");
    if (type === OBJECTIVE_TYPE.TALK) {
        const match = source.match(/(?:与|和|向)(.+?)(?:对话|交谈|询问|打听)/);
        return match ? match[1] : "";
    }
    return "";
}

/**
 * 追踪栏里的附加行：状态提示与任务标题标签，不是目标本身。
 * 它们会时有时无（“已到达任务区域”出现/消失、OCR 把它切成“已到达|任务区域”），
 * 不能参与目标比对。
 */
const STATUS_PART = /^(?:已到达|到达任务区域|位于其它|任务区域|任务完成|任务达成|任务专注模式|\[?[Vv]\]?\s*查看任务线索)/;

/**
 * 覆盖在追踪栏上的提示条（新任务/新章节），整条都不是目标。
 */
const BANNER_PART = /^(新任务|新章节|任务专注模式|第.+[幕章])$/;

/**
 * 任务完成提示：此时追踪栏只剩任务标题，不能把标题当成新目标，
 * 等待下一帧出现真正的后续目标。
 */
const COMPLETED_PART = /^任务(完成|达成)$/;

/**
 * 按关键词规则判断目标类型。
 * @param {string} text 归一化文本
 * @returns {string}
 */
function classify(text) {
    for (const rule of RULES) {
        if (rule.patterns.some(pattern => pattern.test(text))) return rule.type;
    }
    return OBJECTIVE_TYPE.UNKNOWN;
}

/**
 * 从多段 OCR 文本中挑出真正的目标行。
 * 实测追踪栏形如 “任务标题|目标|状态”，目标是最后一个非状态段。
 * 若整条只有一个状态段（如只读到 “已到达任务区域”），返回空串表示“本次没有新目标”。
 * @param {string[]} parts 按 | 切开的文本段
 * @returns {string}
 */
function pickObjectivePart(parts) {
    if (parts.some(part => BANNER_PART.test(part))) return "";
    // 任务完成时追踪栏只剩任务标题，不把标题当成新目标。
    if (parts.some(part => COMPLETED_PART.test(part))) return "";
    let index = parts.length - 1;
    let core = "";
    for (; index >= 0; index--) {
        const part = parts[index].trim();
        if (part && !STATUS_PART.test(part)) {
            core = part;
            break;
        }
    }
    if (!core || classify(normalizeObjective(core)) !== OBJECTIVE_TYPE.UNKNOWN) return core;
    // 目标折行时会被切成多段（“解决月台另|边的敌人”），向左合并到能识别出动作为止；
    // 合并后仍识别不出动作就保持原样，避免把任务标题拼进目标。
    let candidate = core;
    for (let left = index - 1; left >= 0; left--) {
        const part = parts[left].trim();
        if (!part || STATUS_PART.test(part)) break;
        candidate = part + candidate;
        if (classify(normalizeObjective(candidate)) !== OBJECTIVE_TYPE.UNKNOWN) return candidate;
    }
    return core;
}

/**
 * 解析一条任务目标。
 * @param {string} rawText 追踪栏 OCR 拼接后的文本
 * @param {number|null} [distance] 单独识别出的距离，优先于文本内距离
 * @returns {{raw: string, core: string, normalized: string, fullNormalized: string, type: string, target: string, distance: number|null}}
 */
export function parseObjective(rawText, distance = null) {
    const raw = String(rawText || "").trim();
    const parts = raw.split("|").map(part => part.trim()).filter(Boolean);
    // 只对目标行做归一化与分类：任务标题每天都会 OCR 抖（饿/饯），状态行时有时无，
    // 它们参与比对会把同一个目标误判成变化。
    const core = pickObjectivePart(parts);
    const normalized = normalizeObjective(core);
    // 整条文本的指纹：同一目标被 OCR 折行成 “利用相位之门，|前往天云”
    // 与单段 “利用相位之门，前往天云” 时，core 不同但整条相同，用它兜底。
    const fullNormalized = normalizeObjective(parts.join(""));
    const type = classify(normalized);

    return {
        raw,
        core,
        normalized,
        fullNormalized,
        type,
        target: extractTarget(core, type),
        distance: distance !== null && distance !== undefined ? distance : parseDistance(raw),
    };
}

/**
 * 该目标类型是否可由通用执行器处理。
 * @param {string} type
 * @returns {boolean}
 */
export function isRunnerSupported(type) {
    return [
        OBJECTIVE_TYPE.NAVIGATE,
        OBJECTIVE_TYPE.TALK,
        OBJECTIVE_TYPE.FOLLOW,
        OBJECTIVE_TYPE.ESCORT,
        OBJECTIVE_TYPE.COLLECT,
        OBJECTIVE_TYPE.INTERACT,
    ].includes(type);
}
