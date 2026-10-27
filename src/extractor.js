/**
 * 规则抽取器（计划书 §6 / §7.2 / §7.3）。
 *
 * 设计取舍：MVP 不依赖外部模型。中文的记忆触发有相当强的句式规律（"记住……"、
 * "我喜欢……"、"我打算……"），规则抽取 + 严格结构校验足以跑通闭环，
 * 而且**可测试、可解释、零成本**。模型抽取留了 `extractWithModel` 适配位，
 * 但当前版本不启用，也不用它兜底 —— 规则抽不出来就进 pending 或丢弃。
 *
 * 置信度语义：`confidence` 只表示"这结构抽得靠不靠"，不代表事实为真。
 * 事实可信度另由 source_type/来源权重表达（见 scoring.SOURCE_TRUST）。
 */

import { classifySensitivity, validateSlots, MEMORY_TYPES } from './models.js';

/** 常见虚词/代词，不能当锚点。 */
const STOPWORDS = new Set([
  '我们', '你们', '他们', '她们', '什么', '怎么', '这个', '那个', '现在', '就是', '还是',
  '可以', '应该', '因为', '所以', '但是', '如果', '然后', '已经', '一个', '一下', '没有',
  '不是', '可能', '觉得', '知道', '时候', '东西', '事情', '问题', '自己', '这样', '那样',
  '真的', '非常', '特别', '有点', '一点', '还有', '而且', '不过', '其实', '感觉', '一直',
]);

const RELATIVE_DAYS = new Map([
  ['今天', 0],
  ['明天', 1],
  ['后天', 2],
  ['大后天', 3],
  ['昨天', -1],
  ['前天', -2],
]);

const WEEKDAY_INDEX = new Map([
  ['一', 1], ['二', 2], ['三', 3], ['四', 4], ['五', 5], ['六', 6], ['日', 0], ['天', 0],
]);

function startOfDay(date) {
  const copy = new Date(date.getTime());
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function isoDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * 把中文相对时间换算成绝对日期。
 * 关键点：**不做推测** —— 换不出来就返回 null，宁可没有 when 也不编一个日期。
 * @param {string} text
 * @param {Date} now
 * @returns {{ value: string, kind: 'date' } | null}
 */
export function resolveRelativeTime(text, now = new Date()) {
  const source = String(text ?? '');
  const explicit = source.match(/(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})/);
  if (explicit) {
    const [, y, m, d] = explicit;
    const date = new Date(Number(y), Number(m) - 1, Number(d));
    if (!Number.isNaN(date.getTime())) return { value: isoDate(date), kind: 'date' };
  }
  const monthDay = source.match(/(\d{1,2})月(\d{1,2})[日号]/);
  if (monthDay) {
    const date = new Date(now.getFullYear(), Number(monthDay[1]) - 1, Number(monthDay[2]));
    if (!Number.isNaN(date.getTime())) return { value: isoDate(date), kind: 'date' };
  }
  for (const [word, offset] of RELATIVE_DAYS) {
    if (source.includes(word)) {
      const date = startOfDay(now);
      date.setDate(date.getDate() + offset);
      return { value: isoDate(date), kind: 'date' };
    }
  }
  const weekMatch = source.match(/(下下?|这)(?:周|星期|礼拜)([一二三四五六日天])/);
  if (weekMatch) {
    const [, which, dayChar] = weekMatch;
    const targetDow = WEEKDAY_INDEX.get(dayChar);
    if (targetDow !== undefined) {
      const date = startOfDay(now);
      const shift = which === '下下' ? 2 : which === '下' ? 1 : 0;
      const currentDow = date.getDay();
      let delta = (targetDow - currentDow + 7) % 7;
      if (delta === 0 && shift === 0) delta = 7; // "这周一"在周一当天指下一周不合理，保守取下一周
      date.setDate(date.getDate() + delta + shift * 7);
      return { value: isoDate(date), kind: 'date' };
    }
  }
  if (source.includes('下周') || source.includes('下个星期')) {
    const date = startOfDay(now);
    date.setDate(date.getDate() + 7);
    return { value: isoDate(date), kind: 'date' };
  }
  if (source.includes('下个月')) {
    const date = startOfDay(now);
    date.setMonth(date.getMonth() + 1);
    return { value: isoDate(date), kind: 'date' };
  }
  return null;
}

/**
 * 抽取锚点词。
 *
 * 只取**短语级**片段（按标点切分，长度 2~12），不做滑动 2 字窗口：
 * 滑窗会产生"三要""都出""我下"这类无意义锚点，既污染召回也让注入的人看不懂。
 * 宽召回交给 FTS，锚点只负责精确命中（计划书 §5.2：优先词组、实体名、主题短语）。
 */
export function extractAnchorTokens(text, { limit = 10 } = {}) {
  const out = [];
  const seen = new Set();
  const push = (token) => {
    if (out.length >= limit) return;
    const value = String(token).trim();
    if (value.length < 2 || value.length > 12) return;
    if (STOPWORDS.has(value)) return;
    if (/^\d+$/.test(value)) return;
    if (seen.has(value)) return;
    seen.add(value);
    out.push(value);
  };
  const source = String(text ?? '');
  const phrases = source.split(/[，。！？、；：,.!?;:\s]+/).filter(Boolean);
  for (const phrase of phrases) {
    // 整段短语（去掉句首的人称/情绪词后）是一个好锚点
    push(phrase);
    const cjkRuns = phrase.match(/[\u4e00-\u9fff]{2,12}/g) ?? [];
    for (const run of cjkRuns) push(run);
    const ascii = phrase.match(/[A-Za-z][A-Za-z0-9_.+-]{1,}/g) ?? [];
    for (const word of ascii) if (word.length >= 2) push(word.toLowerCase());
  }
  return out;
}

const isQuestion = (text) => /[?？]\s*$/.test(text) || /^(吗|是不是|要不要|有没有|能不能)/.test(text);

/**
 * 带日期的计划/任务在计划日之后留出的宽限天数。
 * 为什么需要：计划书 §9.3 要求时间限定记忆在过期后退出"当前状态"查询，
 * 但"10 月 28 日去成都"在 10 月 29 日当天仍可能被问到，所以留 2 天宽限。
 */
const PLAN_VALIDITY_GRACE_DAYS = 2;

/** 长期有效的记忆类型：不因某个日期而失效。 */
const TIMELESS_TYPES = new Set(['preference', 'fact', 'commitment', 'correction']);

/**
 * 计算 valid_from / valid_until。
 * 只对"有时间点的计划/事件/任务"设置失效时间；偏好与事实不设失效。
 */
function computeValidity(when, memoryType) {
  if (!when || TIMELESS_TYPES.has(memoryType)) return { validFrom: null, validUntil: null };
  const dayEnd = new Date(`${when.value}T23:59:59.000Z`);
  if (Number.isNaN(dayEnd.getTime())) return { validFrom: null, validUntil: null };
  return {
    validFrom: `${when.value}T00:00:00.000Z`,
    validUntil: new Date(dayEnd.getTime() + PLAN_VALIDITY_GRACE_DAYS * 86400000).toISOString(),
  };
}

/**
 * 从一条消息里抽记忆候选。
 *
 * @param {string} rawText - 主人（或群友）的原话。**不落库**，只用于本次抽取。
 * @param {object} options
 * @param {Date} [options.now]
 * @param {'user_explicit'|'user_inferred'|'agent_generated'|'imported'} [options.sourceType]
 * @param {string} [options.sourceRef] - 只存消息 ID，不存正文
 * @returns {{ candidates: Array<object>, rejected: Array<{reason: string}> }}
 */
export function extractCandidates(rawText, options = {}) {
  const now = options.now ?? new Date();
  const sourceType = options.sourceType ?? 'user_explicit';
  const text = String(rawText ?? '').trim();
  const candidates = [];
  const rejected = [];

  if (text.length === 0) return { candidates, rejected: [{ reason: 'empty' }] };
  if (text.length > 2000) {
    rejected.push({ reason: 'too_long' });
    return { candidates, rejected };
  }

  const sensitivity = classifySensitivity(text);
  if (sensitivity.forbidden) {
    rejected.push({ reason: 'forbidden_credential' });
    return { candidates, rejected };
  }

  const rememberDirective = /^(?:请|帮我|麻烦你?)?(?:记住|记牢|记下|记一下|别忘了|不要忘记|留存一下)/.test(text);
  const question = isQuestion(text) && !rememberDirective;

  if (question) rejected.push({ reason: 'question_not_a_memory' });

  const when = resolveRelativeTime(text, now);

  // ── 状态判定：优先级 = 取消 > 明确决定 > 犹豫 > 计划 ──
  // 为什么"犹豫"要排在"计划"前面：
  //   "要不要去成都"里含有子串"要去"，若先判 planned 就会把"还在犹豫"误判成"已经计划好"，
  //   而这正好违反计划书 §6「不能把有兴趣考虑抽成已经决定」。
  const cancelled = /(?:不去了|不打算|取消了?|算了|不做了|放弃了|改主意|不想要了)/.test(text);
  const confirmed = /(?:决定|定了|确定|说好了|已经买了|已预订|已订|确认了)/.test(text);
  const considering = /(?:考虑|要不要|也许|可能|有点想|在想要不要|犹豫|不一定|看情况|还没想好|在想要)/.test(text);
  const planned = /(?:打算|计划|准备|要去|想去|会在|准备去)/.test(text);

  let status = 'unknown';
  if (cancelled) status = 'cancelled';
  else if (confirmed) status = 'confirmed';
  else if (considering) status = 'considering';
  else if (planned) status = 'planned';

  const hasPlanShape = /(?:打算|计划|准备|要去|想去|下周|明天|后天|这个月|下个月|出差|旅行|出发|考试|面试|搬家|生日|纪念日)/.test(text);
  const hasPreferenceShape = /(?:喜欢|讨厌|受不了|害怕|最爱|不吃|爱吃|不想吃|过敏|忌口|偏好)/.test(text);
  const hasCommitmentShape = /(?:答应|保证|承诺|说好要|会帮你|一定)/.test(text);
  const hasTaskShape = /(?:待办|要做|得去做|需要完成|提醒我)/.test(text);
  const hasFactShape = /(?:我是|我叫|我住|我在|我养了|我有个|我有只|我的名字|我的生日|今年\d+岁|我读|我上班)/.test(text);

  const base = { now, sourceRef: options.sourceRef ?? null, sourceType, sensitivity: sensitivity.sensitivity };

  if (rememberDirective) {
    // 显式"记住"优先于自动阈值，但仍要做结构校验与安全检查。
    const body = text.replace(/^(?:请|帮我|麻烦你?)?(?:记住|记牢|记下|记一下|别忘了|不要忘记|留存一下)[:：,，\s]*/, '');
    if (body.length === 0) {
      rejected.push({ reason: 'remember_without_content' });
    } else {
      candidates.push(
        buildCandidate({
          ...base,
          text: body,
          memoryType: pickType({ hasPlanShape, hasPreferenceShape, hasCommitmentShape, hasTaskShape, hasFactShape, status }),
          tier: 'core',
          state: 'active',
          confidence: 0.94,
          status: status === 'unknown' ? 'undecided' : status,
          when,
          explicit: true,
        }),
      );
    }
    return { candidates, rejected };
  }

  if (question) return { candidates, rejected };

  // ── 自动抽取：只有明确句式才命中，宁缺毋滥 ──
  let memoryType = null;
  let confidence = 0;
  if (hasPlanShape && status !== 'unknown') {
    memoryType = 'plan';
    confidence = 0.86;
    if (when) confidence = 0.9;
    if (status === 'considering') confidence = 0.72;
  } else if (hasPreferenceShape) {
    memoryType = 'preference';
    confidence = 0.84;
  } else if (hasCommitmentShape) {
    memoryType = 'commitment';
    confidence = 0.78;
  } else if (hasTaskShape) {
    memoryType = 'task';
    confidence = 0.72;
  } else if (hasFactShape) {
    memoryType = 'fact';
    confidence = 0.8;
  } else if (hasPlanShape) {
    memoryType = 'plan';
    confidence = 0.6;
    status = status === 'unknown' ? 'undecided' : status;
  }

  if (!memoryType) {
    rejected.push({ reason: 'no_memory_pattern' });
    return { candidates, rejected };
  }

  // Agent 自己推断出来的内容，置信度封顶到中档 -> 只会进 pending_confirm。
  if (sourceType === 'agent_generated') confidence = Math.min(confidence, 0.49);
  if (sourceType === 'user_inferred') confidence = Math.min(confidence, 0.75);

  const tier = memoryType === 'preference' && confidence >= 0.8 ? 'core' : memoryType === 'event' ? 'edge' : 'normal';

  candidates.push(
    buildCandidate({
      ...base,
      text,
      memoryType,
      tier,
      state: null, // 由 writer 按阈值路由
      confidence,
      status: status === 'unknown' ? 'undecided' : status,
      when,
      explicit: false,
    }),
  );
  return { candidates, rejected };
}

function pickType(shapes) {
  if (shapes.hasPlanShape) return 'plan';
  if (shapes.hasPreferenceShape) return 'preference';
  if (shapes.hasCommitmentShape) return 'commitment';
  if (shapes.hasTaskShape) return 'task';
  return 'fact';
}

/** 组装一个候选：校验槽位、截断长度、生成 canonical/summary。不写库。 */
function buildCandidate(input) {
  const maxCanonical = 400;
  const maxSummary = 160;
  const canonical = String(input.text).trim().slice(0, maxCanonical);
  const payloadRaw = {
    subject: input.subject ?? (/(?:我|主人)/.test(input.text) ? '主人' : undefined),
    action: input.memoryType,
    object: input.object ?? extractObject(input.text, input.memoryType),
    when: input.when ? input.when.value : null,
    status: input.status,
    source_type: input.sourceType,
  };
  const slotCheck = validateSlots(payloadRaw, { maxPayloadBytes: 2048 });
  const summary = canonical.length > maxSummary ? `${canonical.slice(0, maxSummary - 1)}…` : canonical;
  const validity = computeValidity(input.when, input.memoryType);
  return {
    memoryType: input.memoryType,
    tier: input.tier,
    requestedState: input.state,
    confidence: Number(input.confidence.toFixed(3)),
    sourceType: input.sourceType,
    sourceRef: input.sourceRef,
    sensitivity: input.sensitivity,
    canonicalText: canonical,
    summary,
    payload: slotCheck.payload ?? payloadRaw,
    payloadErrors: slotCheck.ok ? [] : slotCheck.errors,
    validFrom: validity.validFrom,
    validUntil: validity.validUntil,
    status: input.status,
    when: input.when ? input.when.value : null,
    explicit: Boolean(input.explicit),
    createdAt: input.now.toISOString(),
  };
}

/** 粗粒度宾语抽取：取第一个有意义的短语，而不是整句话。
 *
 * 为什么重要：object 会直接进入锚点与注入文本。把"我下周三要去成都出差，计划十月
 * 二十五号出发"整句当 object，锚点就变成整句、注入也读不出重点。
 */
function extractObject(text, memoryType) {
  const source = String(text).replace(/[。！？\s]+$/, '');
  const firstClause = source.split(/[，。！？、；：,.!?;:]/).map((part) => part.trim()).filter(Boolean)[0] ?? source;

  const after = (patterns) => {
    for (const pattern of patterns) {
      const match = firstClause.match(pattern);
      if (match && match[1]) return match[1].trim();
    }
    return null;
  };

  if (memoryType === 'plan' || memoryType === 'task') {
    const place = after([/(?:去|到|在)([\u4e00-\u9fffA-Za-z0-9]{2,12})/]);
    if (place) {
      const trimmed = place
        .replace(/(?:出差|旅行|旅游|玩|一趟|一趟吧|办事|看看)$/, '')
        .replace(/[了吧啊呀呢哦嘛的啦]+$/, '');
      return trimmed || place;
    }
    const thing = after([/(?:打算|计划|准备|要)([\u4e00-\u9fffA-Za-z0-9]{2,16})/]);
    if (thing) return thing.replace(/[了吧啊呀呢哦嘛的啦]+$/, '');
  }
  if (memoryType === 'preference') {
    const liked = after([/(?:喜欢|讨厌|爱吃|不吃|受不了|害怕|最爱|忌口)([\u4e00-\u9fffA-Za-z0-9]{2,16})/]);
    if (liked) return liked;
  }
  if (memoryType === 'commitment') {
    const promised = after([/(?:答应|保证|承诺|说好)([\u4e00-\u9fffA-Za-z0-9]{2,20})/]);
    if (promised) return promised;
  }
  if (memoryType === 'fact') {
    const fact = after([/(?:叫|住在|住|在|养了|有个|有只|是)([\u4e00-\u9fffA-Za-z0-9]{2,16})/]);
    if (fact) return fact;
  }
  const cleaned = firstClause
    .replace(/^(?:请|帮我|麻烦你?)?(?:记住|记牢|记下|记一下|别忘了|不要忘记)/, '')
    .replace(/^(?:我|主人)?(?:真的|挺|特别|非常|有点|很)?/, '')
    .replace(/^[，。、：:！？\s]+/, '');
  return cleaned.length > 0 ? cleaned.slice(0, 40) : undefined;
}

/**
 * 实体类锚点的补充切片。
 *
 * 为什么需要：object 槽位常抽成"一只叫豆豆的猫""成都的潮湿天气"这种长短语，
 * 而用户真正会用"豆豆""成都"来问。只把长短语当锚点会让实体查不到（实测召回掉到 0.61）。
 * 所以对 object 额外切出 2~4 字子串作为**低权重**锚点；范围只限 object，
 * 不像整句滑窗那样产生"三要""都出"这类噪声。
 */
function entitySlices(text, { min = 2, max = 4, limit = 8 } = {}) {
  const value = String(text ?? '');
  const runs = value.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  const out = [];
  const seen = new Set();
  for (const run of runs) {
    if (run.length <= max) {
      if (!seen.has(run)) {
        seen.add(run);
        out.push(run);
      }
      continue;
    }
    for (let len = min; len <= max && out.length < limit; len += 1) {
      for (let start = 0; start + len <= run.length && out.length < limit; start += 1) {
        const slice = run.slice(start, start + len);
        if (STOPWORDS.has(slice) || seen.has(slice)) continue;
        seen.add(slice);
        out.push(slice);
      }
    }
    if (out.length >= limit) break;
  }
  return out.slice(0, limit);
}

/** 依据候选内容生成锚点（token/role/权重）。 */
export function anchorsForCandidate(candidate) {
  const out = [];
  const seen = new Set();
  const push = (token, type, role, weight) => {
    const value = String(token ?? '').trim();
    if (value.length < 2) return;
    if (STOPWORDS.has(value)) return;
    const key = value.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ token: value, type, role, weight });
  };

  const payload = candidate.payload ?? {};
  push(payload.subject, 'entity', 'subject', 1.0);
  push(payload.object, 'topic', 'object', 1.0);
  if (candidate.when) push(candidate.when, 'time', 'time', 0.4);

  // object 的实体切片（低权重）：让"豆豆""成都"这类简称也能命中。
  for (const slice of entitySlices(payload.object)) push(slice, 'entity', 'object', 0.35);

  // 全文里的动作/主题词切片（更低权重，最多 4 个）：让"出差""小面"这类词也能当锚点。
  // 只取少量 + 低权重 + IDF 抑制，避免退化成"整句滑窗"的噪声（对比数据见 TEST-REPORT）。
  for (const slice of entitySlices(candidate.canonicalText, { max: 3, limit: 4 })) {
    push(slice, 'topic', 'topic', 0.2);
  }

  // 槽位抽不到的细节靠短语锚点补，权重低于槽位锚点。
  // 注意：不把 payload.action（= memory_type，如 "plan"）当锚点 —— 那是分类标签不是词。
  for (const token of extractAnchorTokens(candidate.canonicalText, { limit: 8 })) {
    if (token === candidate.memoryType) continue;
    push(token, 'topic', 'topic', 0.5);
  }
  return out;
}

/**
 * 校验候选是否允许持久化（隐私闸门）。
 * @returns {{ allow: boolean, reason: string|null, sensitivity: string }}
 */
export function privacyGate(candidate, cfg) {
  const sensitivity = candidate.sensitivity ?? 'normal';
  if (sensitivity === 'restricted') return { allow: false, reason: 'restricted_content', sensitivity };
  if (sensitivity === 'sensitive' && !cfg.privacy.storeSensitiveByDefault) {
    return { allow: false, reason: 'sensitive_requires_opt_in', sensitivity };
  }
  return { allow: true, reason: null, sensitivity };
}

export function isMemoryType(value) {
  return MEMORY_TYPES.includes(value);
}
