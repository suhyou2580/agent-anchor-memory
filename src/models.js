/**
 * 数据模型：枚举、ID 生成、槽位校验、敏感度判定、指纹。
 *
 * 这一层是**纯函数**，不碰数据库，便于单测。
 * 计划书 §6 要求抽取输出必须结构校验：字段类型、枚举、时间规范化、长度限制、空值处理。
 */

import crypto from 'node:crypto';

export const MEMORY_TYPES = Object.freeze([
  'preference', // 偏好/禁忌
  'fact', // 事实
  'plan', // 计划
  'commitment', // 承诺
  'task', // 任务/待办
  'correction', // 纠错后的新值
  'event', // 发生过的具体事件
]);

export const TIERS = Object.freeze(['core', 'normal', 'edge']);
export const STAGES = Object.freeze(['full', 'summary', 'keyword', 'anchor']);
export const STATES = Object.freeze(['active', 'pending_confirm', 'superseded', 'cancelled', 'expired', 'deleted']);
export const SOURCE_TYPES = Object.freeze(['user_explicit', 'user_inferred', 'agent_generated', 'imported']);
export const SENSITIVITY = Object.freeze(['normal', 'sensitive', 'restricted']);
export const RELATIONS = Object.freeze(['same_topic', 'previous_version', 'supersedes', 'depends_on', 'related_event']);
export const ANCHOR_TYPES = Object.freeze(['topic', 'entity', 'action', 'time', 'slot']);

/**
 * 业务状态。`considering` / `planned` / `confirmed` 必须能区分：
 * "有兴趣考虑去成都" 不能抽成 "已经决定去成都"（计划书 §6）。
 */
export const STATUS_VALUES = Object.freeze([
  'considering',
  'planned',
  'confirmed',
  'completed',
  'cancelled',
  'undecided',
  'unknown',
]);

/** 普通查询中允许注入的状态；superseded/cancelled/expired/deleted 一律排除。 */
export const RECALLABLE_STATES = Object.freeze(['active']);

const SLOT_KEYS = Object.freeze(['subject', 'action', 'object', 'when', 'valence', 'status', 'source_type', 'quantity', 'place']);

const ID_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

/**
 * 生成不可猜测的随机 ID。用 CSPRNG，不用时间戳/自增，避免枚举。
 * @param {string} prefix
 * @param {number} bytes
 */
export function randomId(prefix, bytes = 16) {
  const buf = crypto.randomBytes(bytes);
  let out = '';
  for (const byte of buf) out += ID_ALPHABET[byte % ID_ALPHABET.length];
  return `${prefix}_${out}`;
}

export const newNodeId = () => randomId('M', 16);
export const newAnchorId = () => randomId('A', 12);
export const newEdgeId = () => randomId('E', 12);
export const newEventId = () => randomId('X', 12);
export const newRunId = () => randomId('R', 12);
export const newStatId = () => randomId('S', 10);

/** 归一化到 ISO-8601（毫秒精度，UTC）。非法时间返回 null。 */
export function toIso(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

/** 只能是日期（YYYY-MM-DD）或 ISO 时间；其他形态视为非法。 */
export function normalizeWhen(value, now = new Date()) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const date = new Date(`${text}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime())) return null;
    return { kind: 'date', value: text };
  }
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(text)) {
    const iso = toIso(text.replace(' ', 'T'));
    return iso ? { kind: 'datetime', value: iso } : null;
  }
  // 相对时间（下周/明天等）由抽取层换算成绝对日期；这里不接受原始相对表达。
  return null;
}

function clip(text, max) {
  const value = String(text ?? '');
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * 校验并归一化槽位 payload。
 * 未知字段被丢弃（而不是报错），因为抽取模型常带上多余键；
 * 但类型/枚举/长度错误必须报错，不能把未校验文本写库。
 * @param {object} payload
 * @param {{ maxPayloadBytes: number }} options
 * @returns {{ ok: boolean, errors: string[], payload: object|null }}
 */
export function validateSlots(payload, options = {}) {
  const maxPayloadBytes = options.maxPayloadBytes ?? 2048;
  const errors = [];
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, errors: ['payload 必须是对象'], payload: null };
  }
  const out = {};
  for (const key of SLOT_KEYS) {
    const value = payload[key];
    if (value === undefined || value === null) continue;
    if (key === 'when') {
      const when = normalizeWhen(value);
      if (!when) {
        errors.push(`when 不是可用的绝对时间：${clip(String(value), 40)}`);
        continue;
      }
      out.when = when.value;
      out.when_kind = when.kind;
      continue;
    }
    if (key === 'status') {
      const normalized = String(value).trim().toLowerCase();
      if (!STATUS_VALUES.includes(normalized)) {
        errors.push(`status 不在允许枚举内：${clip(normalized, 24)}`);
        continue;
      }
      out.status = normalized;
      continue;
    }
    if (key === 'source_type') {
      const normalized = String(value).trim().toLowerCase();
      if (!SOURCE_TYPES.includes(normalized)) {
        errors.push(`payload.source_type 不在允许枚举内：${clip(normalized, 24)}`);
        continue;
      }
      out.source_type = normalized;
      continue;
    }
    if (key === 'valence') {
      const normalized = String(value).trim().toLowerCase();
      const allowed = ['positive', 'negative', 'neutral', 'mixed'];
      if (!allowed.includes(normalized)) {
        errors.push(`valence 不在允许枚举内：${clip(normalized, 24)}`);
        continue;
      }
      out.valence = normalized;
      continue;
    }
    if (typeof value !== 'string' && typeof value !== 'number') {
      errors.push(`${key} 必须是字符串或数字`);
      continue;
    }
    const text = String(value).trim();
    if (text.length === 0) continue;
    if (text.length > 200) {
      errors.push(`${key} 超过 200 字符`);
      continue;
    }
    out[key] = text;
  }

  if (Object.keys(out).length === 0) errors.push('payload 没有任何有效槽位');

  let json = '';
  try {
    json = JSON.stringify(out);
  } catch (error) {
    errors.push(`payload 无法序列化：${error.message}`);
  }
  if (json && Buffer.byteLength(json, 'utf8') > maxPayloadBytes) {
    errors.push(`payload 超过 ${maxPayloadBytes} 字节`);
  }

  return { ok: errors.length === 0, errors, payload: errors.length === 0 ? out : null };
}

// ── 敏感信息策略（计划书 §13.3）──────────────────────────────────────────────

/** 凭据类：一律禁止进入长期记忆。 */
const FORBIDDEN_PATTERNS = [
  /(?:密码|口令|password|passwd|pwd)\s*(?:是|为|:|=)\s*\S+/i,
  /\b(?:api[_\s-]?key|secret|client[_\s-]?secret|access[_\s-]?token|bearer)\b\s*(?:是|为|:|=)?\s*[A-Za-z0-9_\-.]{12,}/i,
  /\bsk-[A-Za-z0-9]{16,}\b/,
  /\b\d{17}[\dXx]\b/, // 身份证
  /\b(?:\d[ -]?){15,19}\b/, // 银行卡
  /\b\d{6}\b(?=.*(?:验证码|校验码|动态码))/,
];

/** 敏感类别：默认不长期保存（健康 / 精确位置 / 财务）。 */
const SENSITIVE_PATTERNS = [
  /(?:住址|家庭地址|我家在|门牌号)/,
  /(?:病历|诊断|病情|吃什么药|抑郁症|焦虑症|血糖|血压|体检报告)/,
  /(?:工资|存款|余额|房贷|信用卡账单|流水|借了.*元|欠了.*元)/,
  /(?:身份证号|护照号|社保号)/,
];

/**
 * 判定一段待写入内容的敏感级别。
 * @param {string} text
 * @returns {{ sensitivity: 'normal'|'sensitive'|'restricted', reason: string|null, forbidden: boolean }}
 */
export function classifySensitivity(text) {
  const value = String(text ?? '');
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(value)) {
      return { sensitivity: 'restricted', reason: 'credential_or_identifier', forbidden: true };
    }
  }
  for (const pattern of SENSITIVE_PATTERNS) {
    if (pattern.test(value)) {
      return { sensitivity: 'sensitive', reason: 'private_category', forbidden: false };
    }
  }
  return { sensitivity: 'normal', reason: null, forbidden: false };
}

/**
 * 带密钥的 HMAC 指纹。用于 forget_markers 抑制"同一来源被重新导入"，
 * 不用普通哈希（可被字典攻击还原正文）。
 * @param {string} secret
 * @param {string} value
 */
export function fingerprint(secret, value) {
  if (!secret || typeof secret !== 'string') {
    throw new Error('fingerprint 需要一个非空密钥（config.hmacKey 或环境变量 ANCHOR_MEMORY_HMAC_KEY）');
  }
  return crypto.createHmac('sha256', secret).update(String(value)).digest('hex');
}

/** 校验枚举值，不合法时抛错（写库前的最后一道闸）。 */
export function assertEnum(value, allowed, field) {
  if (!allowed.includes(value)) throw new Error(`${field} 非法：${JSON.stringify(value)}（允许：${allowed.join('/')}）`);
  return value;
}
