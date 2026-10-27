/**
 * 人工标注的「查询—记忆」测试集（计划书 §14.1）。
 *
 * 结构：每个用例声明一组操作（write / correct / forget / scope）与一条查询，
 * 并标注**应该召回**与**不得召回**的操作序号。评测脚本按序号解析出真实 node_id。
 *
 * 覆盖类别：
 *   core_preference     核心偏好/禁忌
 *   historical_fact     历史事实
 *   plan_status         计划与状态变更
 *   correction          纠错后的正确值
 *   chit_chat           普通闲聊（应空召回）
 *   ambiguous           歧义查询
 *   similar_events      相似但不同的事件（不得串味）
 *   deleted            已删除记忆（不得召回）
 *   isolation          跨用户隔离
 *
 * 标注原则：expect 里只放"这条查询若被问到，真人会期望想起的东西"；
 * 任何搭边的都算 over-recall，所以 expect 尽量小、forbid 明确。
 */

/**
 * 12 个主题簇：每个主题 3 条记忆 + 3 种问法。
 *
 * `expectFor` 是"这条记忆应当被哪些问法召回"的**人工标注提示**，故意写得具体：
 * 早期版本用过 `'成都'` 这种宽泛提示，结果同一实体下的天气/小面记忆全被标成"应召回"，
 * 标注本身就把误注入洗白了 —— 标注必须比检索更严格才有意义。
 */
const TOPICS = [
  {
    key: 'chengdu',
    scope: 'iso:chengdu',
    memories: [
      { text: '我下周三要去成都出差，计划十月二十八号出发', expectFor: ['成都出差的事', '下周三的行程安排', '出差安排'] },
      { text: '我讨厌成都的潮湿天气', expectFor: ['成都天气怎么样', '潮湿', '天气'] },
      { text: '我在成都吃过一家很好吃的小面，店在春熙路', expectFor: ['成都那家小面', '春熙路那家店', '小面'] },
    ],
    queries: ['成都出差的事', '成都天气怎么样', '成都那家小面'],
  },
  {
    key: 'cat',
    scope: 'iso:cat',
    memories: [
      { text: '我养了一只叫豆豆的猫，是橘猫', expectFor: ['豆豆', '我的猫', '橘猫'] },
      { text: '豆豆最近不爱吃饭，我有点担心', expectFor: ['豆豆不吃饭', '猫的胃口'] },
      { text: '我打算下周带豆豆去宠物医院检查', expectFor: ['带猫去医院', '豆豆检查'] },
    ],
    queries: ['豆豆怎么了', '我的猫叫什么', '带猫去医院的事'],
  },
  {
    key: 'coffee',
    scope: 'iso:coffee',
    memories: [
      { text: '我喜欢喝美式咖啡，不加糖', expectFor: ['美式咖啡', '咖啡口味'] },
      { text: '我讨厌香菜，闻到就皱眉头', expectFor: ['香菜', '忌口'] },
      { text: '我最近在戒咖啡因，改成喝无咖啡因的', expectFor: ['戒咖啡因', '无咖啡因'] },
    ],
    queries: ['我喝咖啡的习惯', '香菜', '咖啡因'],
  },
  {
    key: 'job',
    scope: 'iso:job',
    memories: [
      { text: '我在杭州上班，做后端开发', expectFor: ['杭州上班', '我的工作'] },
      { text: '我打算年底换工作，想去上海', expectFor: ['换工作', '去上海'] },
      { text: '我下个月有一次面试，准备得有点紧张', expectFor: ['面试', '紧张'] },
    ],
    queries: ['我在哪上班', '换工作的计划', '面试准备'],
  },
  {
    key: 'health',
    scope: 'iso:health',
    memories: [
      { text: '我最近在健身，一周去三次健身房', expectFor: ['健身', '健身房'] },
      { text: '我膝盖有旧伤，跑步不能太久', expectFor: ['膝盖', '跑步'] },
      { text: '我打算报名下个月的半程马拉松', expectFor: ['马拉松', '半马'] },
    ],
    queries: ['我的健身安排', '膝盖的伤', '马拉松'],
  },
  {
    key: 'trip',
    scope: 'iso:trip',
    memories: [
      { text: '我明年春天想去日本看樱花', expectFor: ['日本', '樱花'] },
      { text: '我护照还有两年过期，得提前换', expectFor: ['护照', '换护照'] },
      { text: '我讨厌坐长途飞机，超过八小时就很难受', expectFor: ['长途飞机', '坐飞机'] },
    ],
    queries: ['日本的计划', '护照什么时候过期', '坐长途飞机'],
  },
  {
    key: 'study',
    scope: 'iso:study',
    memories: [
      { text: '我在学 Rust，主要想写点命令行工具', expectFor: ['Rust', '学 Rust'] },
      { text: '我买了本《深入理解计算机系统》，一直没看完', expectFor: ['计算机系统', '那本书'] },
      { text: '我每周六上午有英语课', expectFor: ['英语课', '周六上午'] },
    ],
    queries: ['我在学什么语言', '那本书看完没', '英语课什么时候'],
  },
  {
    key: 'game',
    scope: 'iso:game',
    memories: [
      { text: '我在玩战双帕弥什，最喜欢露西亚这个角色', expectFor: ['战双', '露西亚'] },
      { text: '我讨厌抽卡抽歪，上次抽了一百二十发才出', expectFor: ['抽卡', '抽歪'] },
      { text: '我打算这个版本把主线打完', expectFor: ['主线', '这个版本'] },
    ],
    queries: ['我在玩什么游戏', '抽卡运气', '主线打完了吗'],
  },
  {
    key: 'family',
    scope: 'iso:family',
    memories: [
      { text: '我妈住在老家，身体还算好', expectFor: ['我妈', '老家'] },
      { text: '我妹妹今年上大学，学的是设计', expectFor: ['我妹妹', '上大学'] },
      { text: '我打算过年回家待两周', expectFor: ['过年回家', '回家'] },
    ],
    queries: ['我妈的情况', '我妹妹学什么', '过年的安排'],
  },
  {
    key: 'music',
    scope: 'iso:music',
    memories: [
      { text: '我喜欢听陈奕迅，尤其是早期的专辑', expectFor: ['陈奕迅', '粤语歌'] },
      { text: '我讨厌太吵的重金属，听着头疼', expectFor: ['重金属', '太吵的音乐'] },
      { text: '我学过两年吉他，现在基本不弹了', expectFor: ['吉他', '弹吉他'] },
    ],
    queries: ['我喜欢听谁的歌', '重金属', '吉他还弹吗'],
  },
  {
    key: 'sleep',
    scope: 'iso:sleep',
    memories: [
      { text: '我经常熬夜到两点，早上起不来', expectFor: ['熬夜', '作息'] },
      { text: '我打算从下周开始十一点前睡觉', expectFor: ['早睡', '十一点睡'] },
      { text: '我睡前习惯喝一杯热牛奶', expectFor: ['热牛奶', '睡前习惯'] },
    ],
    queries: ['我的作息', '早睡计划', '睡前喝什么'],
  },
  {
    key: 'money',
    scope: 'iso:money',
    memories: [
      { text: '我在攒钱买一台新笔记本，目标是两万', expectFor: ['攒钱', '笔记本'] },
      { text: '我讨厌订阅制会员，能买断就买断', expectFor: ['订阅制', '会员'] },
      { text: '我每个月固定存三千块', expectFor: ['存钱', '每月存款'] },
    ],
    queries: ['攒钱买什么', '订阅制', '每个月存多少'],
  },
];

/** 纯闲聊：应当空召回。 */
const CHIT_CHAT = [
  '今天天气不错啊',
  '哈哈哈哈笑死',
  '在吗',
  '刚吃完饭',
  '晚安',
  '你说话真好玩',
  '有点困了',
  '这个点还有人吗',
  '我回来了',
  '早',
];

/** 相似但不同的事件：不得串味。 */
const SIMILAR = [
  { scope: 'iso:similar-a', texts: ['我上个月去了成都出差', '我下个月要去重庆出差'], query: '重庆出差的事', expect: [1], forbid: [0] },
  { scope: 'iso:similar-b', texts: ['我喜欢喝美式咖啡', '我喜欢喝拿铁'], query: '拿铁', expect: [1], forbid: [] },
  { scope: 'iso:similar-c', texts: ['我讨厌香菜', '我喜欢吃蒜'], query: '蒜', expect: [1], forbid: [0] },
  { scope: 'iso:similar-d', texts: ['我养了一只叫豆豆的猫', '我朋友养了一只叫豆豆的狗'], query: '我的猫豆豆', expect: [0], forbid: [] },
  { scope: 'iso:similar-e', texts: ['我下周三要去成都出差', '我明年春天想去成都看朋友'], query: '明年春天的计划', expect: [1], forbid: [] },
  { scope: 'iso:similar-f', texts: ['我在学 Rust', '我在学日语'], query: '日语学得怎么样', expect: [1], forbid: [0] },
];

/** 纠错：普通查询不得返回旧值。 */
const CORRECTIONS = [
  { scope: 'iso:corr-a', texts: ['我下周三要去成都出差'], correctTo: '我改成下周去重庆出差', query: '下周出差的安排', forbidText: '成都' },
  { scope: 'iso:corr-b', texts: ['我喜欢喝美式咖啡'], correctTo: '我不喜欢美式了，现在喝拿铁', query: '我现在喝什么咖啡', forbidText: '美式咖啡' },
  { scope: 'iso:corr-c', texts: ['我养了一只猫'], correctTo: '我养的是狗不是猫', query: '我养的宠物', forbidText: '养了一只猫' },
];

/** 删除：不得召回。 */
const DELETIONS = [
  { scope: 'iso:del-a', text: '我讨厌香菜', query: '香菜' },
  { scope: 'iso:del-b', text: '我下周三要去成都出差', query: '成都出差' },
  { scope: 'iso:del-c', text: '我养了一只叫豆豆的猫', query: '豆豆' },
];

/** 跨用户隔离。 */
const ISOLATION = [
  { aScope: 'iso:user-a', bScope: 'iso:user-b', text: '我讨厌香菜', query: '香菜' },
  { aScope: 'iso:user-c', bScope: 'iso:user-d', text: '我下周三要去成都出差', query: '成都' },
  { aScope: 'iso:user-e', bScope: 'iso:user-f', text: '我养了一只叫豆豆的猫', query: '豆豆' },
];

/**
 * 生成完整用例集。
 * @returns {Array<object>} 每个用例含 ops / query / scope / expect / forbid / expectEmpty
 */
export function buildCases() {
  const cases = [];

  // 1) 主题簇：每条记忆 × 每种问法，只有对应主题的那条应被召回
  for (const topic of TOPICS) {
    topic.memories.forEach((memory, memoryIndex) => {
      topic.queries.forEach((query, queryIndex) => {
        const id = `${topic.key}-${memoryIndex}-${queryIndex}`;
        cases.push({
          id,
          category: 'topic_recall',
          topic: topic.key,
          scope: topic.scope,
          ops: topic.memories.map((item) => ({ op: 'write', text: item.text })),
          query,
          // 该问法是否是这条记忆的"预期问法"
          expect: memory.expectFor.some((hint) => query.includes(hint) || hint.includes(query)) ? [memoryIndex] : [],
          forbid: [],
          expectEmpty: false,
          // 标记：这条 query 与这条 memory 是否语义相关（用于人工核对标注）
          labelledRelevant: memory.expectFor.some((hint) => query.includes(hint) || hint.includes(query)),
        });
      });
    });
  }

  // 2) 闲聊：应空召回
  CHIT_CHAT.forEach((text, index) => {
    cases.push({
      id: `chit-${index}`,
      category: 'chit_chat',
      scope: `iso:chit-${index}`,
      ops: [{ op: 'write', text: '我讨厌香菜' }],
      query: text,
      expect: [],
      forbid: [0],
      expectEmpty: true,
    });
  });

  // 3) 相似但不同的事件
  for (const group of SIMILAR) {
    cases.push({
      id: `similar-${group.scope}`,
      category: 'similar_events',
      scope: group.scope,
      ops: group.texts.map((text) => ({ op: 'write', text })),
      query: group.query,
      expect: group.expect,
      forbid: group.forbid,
      expectEmpty: false,
    });
  }

  // 4) 纠错
  for (const group of CORRECTIONS) {
    cases.push({
      id: `correction-${group.scope}`,
      category: 'correction',
      scope: group.scope,
      ops: [{ op: 'write', text: group.texts[0] }, { op: 'correct', target: 0, text: group.correctTo }],
      query: group.query,
      expect: [1],
      forbid: [0],
      expectEmpty: false,
      forbidText: group.forbidText,
    });
  }

  // 5) 删除
  for (const group of DELETIONS) {
    cases.push({
      id: `deleted-${group.scope}`,
      category: 'deleted',
      scope: group.scope,
      ops: [{ op: 'write', text: group.text }, { op: 'forget', target: 0 }],
      query: group.query,
      expect: [],
      forbid: [0],
      expectEmpty: true,
    });
  }

  // 6) 跨用户隔离：A 写入，B 查询必须为空
  for (const group of ISOLATION) {
    cases.push({
      id: `isolation-${group.aScope}`,
      category: 'isolation',
      scope: group.aScope,
      queryScope: group.bScope,
      ops: [{ op: 'write', text: group.text }],
      query: group.query,
      expect: [],
      forbid: [0],
      expectEmpty: true,
    });
  }

  return cases;
}

export const CATEGORIES = [
  'topic_recall',
  'chit_chat',
  'similar_events',
  'correction',
  'deleted',
  'isolation',
];
