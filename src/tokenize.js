/**
 * 文本规范化、检索分词与 token 预算估算。
 *
 * 为什么自己分词：SQLite 的 `unicode61` 把一整串连续汉字当一个 token，
 * `trigram` 又要至少 3 个字符才命中，两者都无法覆盖"成都""香菜"这类 2 字查询
 * （实测证据见 docs/ENV-REPORT.md §4）。所以写入侧和查询侧都走同一个
 * CJK bigram 分词器，保证任何长度 ≥1 的查询都能命中。
 */

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const ASCII_WORD = /[A-Za-z0-9_]/;

/** 归一化：NFKC + 小写 + 折叠空白。不改变语义，只消除排版差异。 */
export function normalizeText(input) {
  const text = String(input ?? '');
  let out = '';
  try {
    out = text.normalize('NFKC');
  } catch {
    out = text;
  }
  return out.toLowerCase().replace(/[\s\u3000]+/g, ' ').trim();
}

/**
 * 生成检索 token。中文连续片段切成 bigram **并额外保留首尾单字**，
 * ASCII 字母数字按词切；其余标点只作分隔。
 *
 * 为什么要保留单字：只切 bigram 时，5 字"我喜欢吃蒜"会得到 我喜/喜欢/欢吃/吃蒜，
 * 尾字"蒜"根本不在索引里，于是 1 字查询"蒜"永远召不回（实测踩过）。
 * 代价是每个中文片段多 1~2 个 token，换来任意单字可检索。
 * @param {string} input - 原文
 * @returns {string[]} token 列表（保持出现顺序，允许重复）
 */
export function tokenize(input) {
  const text = normalizeText(input);
  const tokens = [];
  let run = '';
  const flush = () => {
    if (run.length === 0) return;
    if (run.length === 1) {
      tokens.push(run);
    } else {
      for (let i = 0; i < run.length - 1; i += 1) tokens.push(run.slice(i, i + 2));
      // 尾字单独入索引，保证单字查询可命中
      tokens.push(run.slice(-1));
    }
    run = '';
  };
  let word = '';
  const flushWord = () => {
    if (word.length > 0) tokens.push(word);
    word = '';
  };
  for (const ch of text) {
    if (CJK.test(ch)) {
      flushWord();
      run += ch;
      continue;
    }
    flush();
    if (ASCII_WORD.test(ch)) {
      word += ch;
      continue;
    }
    flushWord();
  }
  flush();
  flushWord();
  return tokens;
}

/** 去重后的 token 串，写入 FTS 的 `toks` 列。 */
export function tokenText(input) {
  return [...new Set(tokenize(input))].join(' ');
}

/**
 * 构造 FTS5 MATCH 表达式。
 * 每个 token 用双引号包裹以避开 FTS5 语法字符，词间用 OR（宽召回，排序交给 bm25+评分）。
 * @returns {string} MATCH 表达式；无有效 token 时返回空串
 */
export function ftsExpression(input) {
  const tokens = [...new Set(tokenize(input))].filter((token) => token.length > 0);
  if (tokens.length === 0) return '';
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(' OR ');
}

/**
 * 生成用于**锚点精确匹配**的候选词。
 *
 * 与检索分词不同：锚点必须是词/短语级（计划书 §5.2 明确禁止单个常见汉字当唯一锚点），
 * 所以这里只产出长度 >= 2 的片段：中文连续片段的所有 2..max 字子串 + ASCII 词。
 * 上限保护避免长文本爆炸（一条 200 字消息最多取 160 个候选）。
 *
 * @param {string} input
 * @param {{ min?: number, max?: number, limit?: number }} [options]
 * @returns {string[]}
 */
export function anchorCandidates(input, options = {}) {
  const min = options.min ?? 2;
  const max = options.max ?? 8;
  const limit = options.limit ?? 160;
  const text = normalizeText(input);
  const out = [];
  const seen = new Set();
  const push = (token) => {
    if (out.length >= limit) return;
    if (token.length < min) return;
    if (seen.has(token)) return;
    seen.add(token);
    out.push(token);
  };
  let run = '';
  let word = '';
  const flushWord = () => {
    if (word.length >= min) push(word);
    word = '';
  };
  const flushRun = () => {
    if (run.length < min) {
      run = '';
      return;
    }
    for (let len = min; len <= Math.min(max, run.length); len += 1) {
      for (let start = 0; start + len <= run.length; start += 1) {
        if (out.length >= limit) break;
        push(run.slice(start, start + len));
      }
    }
    run = '';
  };
  for (const ch of text) {
    if (CJK.test(ch)) {
      flushWord();
      run += ch;
      continue;
    }
    flushRun();
    if (ASCII_WORD.test(ch)) {
      word += ch;
      continue;
    }
    flushWord();
  }
  flushRun();
  flushWord();
  return out;
}

/**
 * 估算一段文本消耗的 token 数。
 *
 * 这是**估算**，不是真实分词器结果：CJK 每字约 1 token，ASCII 约 4 字符 1 token，
 * 标点与空白各计 1。用于预算裁剪时偏保守（宁可少注入），具体数值在
 * docs/TEST-REPORT.md 里报告了与实测文本长度的偏差。
 */
export function estimateTokens(input) {
  const text = String(input ?? '');
  let total = 0;
  let word = 0;
  const flushWord = () => {
    if (word > 0) total += Math.ceil(word / 4);
    word = 0;
  };
  for (const ch of text) {
    if (CJK.test(ch)) {
      flushWord();
      total += 1;
      continue;
    }
    if (ASCII_WORD.test(ch)) {
      word += 1;
      continue;
    }
    flushWord();
    total += 1;
  }
  flushWord();
  return total;
}

/**
 * 生成用于去重的主题指纹。
 * 注意：这只是"发现候选"的线索，不能据此自动合并（计划书 §7.4）。
 * @param {string[]} parts - 参与指纹的字段
 */
export function topicFingerprint(parts) {
  const tokens = [];
  for (const part of parts) {
    for (const token of tokenize(part ?? '')) {
      if (!tokens.includes(token)) tokens.push(token);
    }
  }
  tokens.sort();
  return tokens.slice(0, 24).join('|');
}
