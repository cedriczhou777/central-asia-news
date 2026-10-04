/**
 * 国家相关性判据 —— **唯一的一份实现**。
 *
 * ## 为什么合并（2026-10-05）
 *
 * 用户报「阿塞拜疆频道出现和土耳其完全没关系的土耳其新闻」。查下来是这样：
 *
 *   采集侧 `fetch-news` 的 `FOREIGN_COUNTRY_KEYWORDS` 里**有** `turkey` / `turkish` /
 *   `ankara` / `турци` / `土耳其`；推送侧 `article-format` 的 `FOREIGN_KEYWORDS`
 *   里**一个都没有**。于是一条土耳其稿子哪怕标题里明写「土耳其」，
 *   在推送侧也会走到「什么国家都没提到 → 放行」的兜底，**照推**。
 *
 * 而这已经是同一个判据「两处各写一份」造成的**第五次**事故
 * （前四次见 `article-format.ts` 的 `pushExclusionReason` 注释）。
 * 两份清单各 327 条 / 119 条，靠人肉同步必然再次分叉 —— 所以这次不再「补齐」，
 * 而是**合成一份**，并把「两侧必须同时具有同一概念的汉字形态」变成**可测的不变量**。
 *
 * ## 两侧**确实**不一样的地方（这是语言差异，不是分叉）
 *
 * 两个调用点读的文本不是同一种语言：
 *   · **推送侧**读 `title + summary`，它们是**翻译后的中文**；
 *   · **采集侧**读原始标题/描述，是俄语 / 吉尔吉斯语 / 哈萨克语 / 阿塞拜疆语 / 英语。
 *
 * 所以词表按「**这个词在哪种文本里看得见**」分成两层：
 *
 *   1. {@link SELF_KEYWORDS} / {@link FOREIGN_KEYWORDS} / {@link REGION_KEYWORDS}
 *      —— **汉字 + 拉丁**。两侧都用（推送侧读中文；采集侧的英文源也读得到）。
 *      ⚠️ 例外：会撞词的拉丁短词（`usa` 会撞 `usage`、`eu ` 会撞 `Europe`）
 *      留在采集侧专用表 —— 见 {@link FOREIGN_KEYWORDS_INGEST_ONLY}。
 *   2. `*_SOURCE_SCRIPT` / `*_INGEST_ONLY` —— **西里尔/中亚语形态**，只有采集侧用得上。
 *      带在推送侧也没用（读的是中文），反而让「哪条判据负责什么」变模糊。
 *
 * ## 不变量（由 `scripts/test-country-relevance.ts` 钉住）
 *
 * ① **每个外国概念都必须有汉字形态**（`FOREIGN_CONCEPT_CHECKLIST`）。
 *    这一条直接让土耳其那种 bug 不可能再出现：只要一个概念被写进清单，
 *    测试就会要求它在 `FOREIGN_KEYWORDS` 里有汉字词 ——
 *    而汉字词是推送侧唯一读得到的东西。
 * ② **每个本国都必须有汉字词**，否则这个国家在推送侧等于不可检测。
 */

import type { CountryCode } from './data/types';

/** 判据在哪一侧运行。**只有兜底那一步不同**，见 `isCountryRelevant`。 */
export type RelevanceSide = 'ingest' | 'push';

// ---------------------------------------------------------------------------
// 一、本国词
// ---------------------------------------------------------------------------

/**
 * 本国关键词：国名 + 首都 + 主要城市/地区 + 国家级公司。**汉字 + 拉丁**，两侧共用。
 *
 * ⚠️ 城市/地区名不是可选项 —— 只写国名会**误杀本国的地方新闻**。
 * 2026-09-21 离线实测踩到的真实案例：
 *   `[uz] 中国投资者在卡拉卡尔帕克斯坦发现4吨黄金储量`
 * 卡拉卡尔帕克斯坦（Karakalpakstan）是乌兹别克斯坦的一个自治共和国，
 * 标题里没出现「乌兹别克斯坦」，却出现了「中国」→ 被判成外国新闻直接丢掉。
 * 这是一条**真·乌兹别克投资新闻**，丢掉它比放进来一条外国新闻更糟。
 *
 * ⚠️ 这张表同时被 `proper-nouns.ts` 的货币闸当作**前置条件**
 * （「这篇稿子确实是这个国家的吗」）。往这里加词等于同时放宽货币闸 —— 两处一起想。
 */
export const SELF_KEYWORDS: Record<CountryCode, string[]> = {
  kz: [
    'kazakhstan', 'kazakh', 'kazakhstani', '哈萨克斯坦', '哈萨克', 'astana', '阿斯塔纳', 'almaty', '阿拉木图',
    '努尔苏丹', '奇姆肯特', 'shymkent', '卡拉干达', 'karaganda', 'tengiz', '田吉兹',
    'kashagan', '卡沙甘', 'kazatomprom', 'kazmunaigas',
    '阿特劳', 'atyrau', '阿克套', 'aktau', '曼格斯套', 'mangystau',
    '阿克托别', 'aktobe', '克孜勒奥尔达', 'kyzylorda', '塔拉兹', 'taraz',
    '厄斯克门', 'oskemen', '巴甫洛达尔', 'pavlodar', '科斯塔奈', 'kostanay',
    '突厥斯坦', 'turkistan', '杰兹卡兹甘', 'jezkazgan', '巴尔喀什', 'balkhash',
  ],
  uz: [
    'uzbekistan', 'uzbek', 'uzbekistani', '乌兹别克斯坦', '乌兹别克', 'tashkent', '塔什干',
    'samarkand', '撒马尔罕', 'bukhara', '布哈拉', 'navoi', '纳沃伊',
    'andijan', '安集延', 'fergana', '费尔干纳', 'namangan', '纳曼干',
    '卡拉卡尔帕克斯坦', 'karakalpakstan', '努库斯', 'nukus',
    '花拉子模', 'khorezm', '乌尔根奇', 'urgench', '铁尔梅兹', 'termez',
    '吉扎克', 'jizzakh', '苏尔汉河', 'surkhandarya', '纳沃伊州',
  ],
  kg: [
    'kyrgyzstan', 'kyrgyz', 'kyrgyzstani', '吉尔吉斯斯坦', '吉尔吉斯', 'bishkek', '比什凯克',
    'osh', '奥什', 'jalal-abad', '贾拉拉巴德', 'issyk-kul', '伊塞克湖', 'kumtor', '库姆托尔',
    '塔拉斯', 'talas', '纳伦', 'naryn', '巴特肯', 'batken', '楚河', 'chuy', '卡拉科尔', 'karakol',
  ],
  az: [
    'azerbaijan', 'azeri', 'azerbaijani', '阿塞拜疆', 'baku', '巴库',
    'ganja', '甘贾', 'sumqayit', '苏姆盖特', 'nakhchivan', '纳希切万', 'socar',
    '连科兰', 'lankaran', '舍基', 'sheki', '明盖恰乌尔', 'mingachevir',
    '舒沙', 'shusha', '卡巴拉', 'qabala', '占贾',
  ],
  tj: [
    'tajikistan', 'tajik', '塔吉克斯坦', '塔吉克', 'dushanbe', '杜尚别',
    'khujand', '苦盏', 'khatlon', '哈特隆', 'roghun', '罗贡', 'tursunzoda',
    '库利亚布', 'kulob', '博赫塔尔', 'bokhtar', '伊斯法拉', 'isfara',
    '彭吉肯特', 'panjakent', '瓦赫达特', 'vahdat', '戈尔诺-巴达赫尚', 'gorno-badakhshan',
  ],
};

/**
 * 本国词的**西里尔 / 中亚语**形态。**只有采集侧用**（推送侧读的是中文）。
 *
 * ⚠️ 别按「反正是同一件事」把它们并进 `SELF_KEYWORDS`：那样推送侧的清单里会躺着一堆
 * 在中文里永远匹配不上的词，下次有人读代码就得重新推一遍「这些词到底有没有用」。
 * 分开的代价只是多一个函数调用。
 *
 * `tm` 也在这里 —— 它**不是推送目标国**，但采集侧拿它判「这是讲土库曼斯坦的稿子」。
 */
export const SELF_KEYWORDS_SOURCE_SCRIPT: Record<string, string[]> = {
  kz: ['казахстан', 'астана', 'алматы', 'қазақстан'],
  uz: ['узбекистан', 'ташкент'],
  kg: ['киргиз', 'бишкек', 'кыргызстан'],
  az: ['азербайджан', 'баку'],
  tj: ['таджикистан', 'душанбе'],
  tm: ['туркменистан'],
};

// ---------------------------------------------------------------------------
// 二、区域 / 合作框架信号
// ---------------------------------------------------------------------------

/**
 * 区域/合作框架信号：命中即放行。**必须在本国判断之后、外国判断之前检查** ——
 * `中国—中亚天然气管道` 同时含「中国」和「中亚」，先判外国就会误杀。
 *
 * ⚠️ 刻意**不收**「欧洲」「欧盟」「南高加索」：
 * 用户 2026-09-21 反馈的正是阿塞拜疆频道里出现欧洲新闻，
 * 把「欧洲」当放行信号会把这类新闻全放进来。
 *
 * ⚠️ 2026-10-05 起**两侧都会查这一段**（原来只有推送侧查）。这会让采集侧
 * **多留**一批「本国 + 外国合作框架」的稿子（此前它们在采集侧就被外国词判死了，
 * 推送侧那条区域规则根本没机会生效）。这是本轮唯一一处让采集侧放宽的改动，
 * 实测影响面很小：区域词在**俄语原文**里几乎不出现（主要是 `cis` / `caspian`
 * 这类拉丁形态），所以起作用的主要是英文源与中文标题。
 */
export const REGION_KEYWORDS: string[] = [
  '中亚', '中亚地区', '中亚五国', '中亚国家', 'central asia',
  '欧亚经济联盟', 'eaeu', 'eurasian economic union',
  '独联体', 'cis', '里海', 'caspian',
  '丝绸之路', 'silk road', '一带一路', 'belt and road',
  '中国—中亚', '中国-中亚', '中国中亚',
];

/** 区域词的采集侧专用形态。理由同 `SELF_KEYWORDS_SOURCE_SCRIPT`。 */
export const REGION_KEYWORDS_INGEST_ONLY: string[] = [
  'каспий',
  // ` BRI` 前导空格是**故意的**：不这么写会命中 `brief`。推送侧读中文，用不上。
  ' BRI',
  'shanghai cooperation',
  // ⚠️ 「南高加索」刻意**不进**共享表（见 `REGION_KEYWORDS` 的注释）。
  // 采集侧留着它，是因为「南高加索」对 az 是**本国所在区域**，
  // 而推送侧的放行口径被用户明确要求收窄过 —— 两个口径不同，不能硬合并。
  'south caucasus',
];

// ---------------------------------------------------------------------------
// 三、外国词
// ---------------------------------------------------------------------------

/**
 * 「讲的是别国」信号。命中即排除（除非本国或区域信号先命中）。
 *
 * 2026-09-20 实测：旧实现只列了 5 个目标国，导致 9/20 那批有 11 篇纯外国新闻
 * 全部走到「均未提及具体国家 → 放行」的兜底：
 *   蒙古 4 篇（吉尔吉斯频道）、格鲁吉亚 3 篇 / 土耳其 2 篇 / 俄罗斯 2 篇（阿塞拜疆频道）。
 * 用户原话：「与本国无任何关联」。
 *
 * ⚠️ 那批里**就有土耳其**（阿塞拜疆频道 2 篇）—— 而下面这张表当时没收土耳其，
 * 2026-10-05 用户又报了一遍同样的事。所以别只看这张表有多长，
 * 要看 `FOREIGN_CONCEPT_CHECKLIST` 有没有覆盖。
 *
 * 全部小写；文本比对前统一小写。**故意不收 `us`/`eu`/`uk` 这类两字母缩写** ——
 * 它们会命中 `Europe`、`reunion`、`Ukraine` 等词的内部，误杀率远高于收益。
 * （`usa` 是三个字母、本可收，但它会命中 `usage`/`USAID`，同样留在采集侧专用表。）
 */
export const FOREIGN_KEYWORDS: string[] = [
  // 亚洲
  '蒙古', 'mongolia', 'mongol', '乌兰巴托', 'ulaanbaatar',
  '日本', 'japan', '东京', 'tokyo',
  '韩国', 'south korea', 'korea', 'seoul', '首尔',
  '朝鲜', 'north korea', 'pyongyang',
  '越南', 'vietnam', '河内',
  '泰国', 'thailand', 'bangkok',
  '马来西亚', 'malaysia', '印度尼西亚', 'indonesia', '新加坡', 'singapore',
  '菲律宾', 'philippines', '缅甸', 'myanmar', '尼泊尔', 'nepal',
  '孟加拉', 'bangladesh', '斯里兰卡', 'sri lanka',
  '印度', 'india', 'indian', '新德里', 'new delhi',
  '巴基斯坦', 'pakistan', 'islamabad', '伊斯兰堡',
  '阿富汗', 'afghanistan', 'kabul', '喀布尔',
  '中国', 'china', 'chinese', '北京', 'beijing', '上海', 'shanghai',
  '中国香港', '中国台湾', '中国澳门',
  // 中东
  '伊朗', 'iran', 'iranian', '德黑兰', 'tehran',
  '伊拉克', 'iraq', 'baghdad', '巴格达',
  '叙利亚', 'syria', '黎巴嫩', 'lebanon', '约旦', 'jordan',
  '以色列', 'israel', '特拉维夫', '巴勒斯坦', 'palestine', '加沙', 'gaza',
  '沙特', 'saudi', '利雅得', 'riyadh',
  '阿联酋', 'uae', 'emirates', '迪拜', 'dubai', '阿布扎比', 'abu dhabi',
  '卡塔尔', 'qatar', 'doha', '多哈', '科威特', 'kuwait', '阿曼', 'oman', '巴林', 'bahrain',
  '也门', 'yemen', '埃及', 'egypt', 'cairo', '开罗',
  // 欧洲
  '欧洲', 'europe', 'european', '欧盟', 'european union', 'eurozone', '欧元区', '布鲁塞尔',
  '德国', 'germany', 'german', '柏林', 'berlin', '慕尼黑', '法兰克福',
  '法国', 'france', 'french', '巴黎', 'paris',
  '英国', 'britain', 'british', 'england', 'london', '伦敦',
  '意大利', 'italy', 'italian', '罗马', 'rome',
  '西班牙', 'spain', 'spanish', '马德里', 'madrid', '葡萄牙', 'portugal', 'lisbon',
  '荷兰', 'netherlands', 'dutch', 'amsterdam', '阿姆斯特丹',
  '比利时', 'belgium', '卢森堡', 'luxembourg',
  '瑞士', 'switzerland', 'geneva', '日内瓦', 'zurich',
  '奥地利', 'austria', '维也纳', 'vienna',
  '瑞典', 'sweden', 'stockholm', '挪威', 'norway', 'oslo',
  '芬兰', 'finland', 'helsinki', '丹麦', 'denmark', 'copenhagen',
  '冰岛', 'iceland', '爱尔兰', 'ireland', 'dublin',
  '波兰', 'poland', 'warsaw', '华沙',
  '捷克', 'czech', 'prague', '布拉格', '斯洛伐克', 'slovakia',
  '匈牙利', 'hungary', 'budapest', '布达佩斯',
  '罗马尼亚', 'romania', 'bucharest', '布加勒斯特',
  '保加利亚', 'bulgaria', 'sofia', '希腊', 'greece', 'athens', '雅典',
  '塞尔维亚', 'serbia', 'belgrade', '贝尔格莱德',
  '克罗地亚', 'croatia', '斯洛文尼亚', 'slovenia',
  '波黑', 'bosnia', '黑山', 'montenegro', '北马其顿', 'macedonia', 'albania', '阿尔巴尼亚',
  '摩尔多瓦', 'moldova',
  '爱沙尼亚', 'estonia', '拉脱维亚', 'latvia', '立陶宛', 'lithuania',
  '格鲁吉亚', 'georgia', 'georgian', '第比利斯', 'tbilisi', '巴统', 'batumi',
  '亚美尼亚', 'armenia', 'armenian', '埃里温', 'yerevan',
  '俄罗斯', 'russia', 'russian', '莫斯科', 'moscow', '西伯利亚', 'siberia',
  '白俄罗斯', 'belarus', 'minsk', '明斯克',
  '乌克兰', 'ukraine', 'ukrainian', '基辅', 'kyiv', 'kiev', '敖德萨', 'odesa',
  // 美洲
  '美国', 'united states', 'america', 'american', '华盛顿', 'washington',
  '纽约', 'new york', '白宫', '特朗普', 'trump', '拜登', 'biden',
  '加拿大', 'canada', 'ottawa', '墨西哥', 'mexico',
  '巴西', 'brazil', '阿根廷', 'argentina', '智利', 'chile', '秘鲁', 'peru',
  '哥伦比亚', 'colombia', '委内瑞拉', 'venezuela', '古巴', 'cuba',
  // 非洲 / 大洋洲
  '南非', 'south africa', '尼日利亚', 'nigeria', '肯尼亚', 'kenya',
  '埃塞俄比亚', 'ethiopia', '摩洛哥', 'morocco', '阿尔及利亚', 'algeria',
  '突尼斯', 'tunisia', '利比亚', 'libya', '苏丹', 'sudan', '索马里', 'somalia',
  '坦桑尼亚', 'tanzania', '加纳', 'ghana',
  '澳大利亚', 'australia', '悉尼', 'sydney', '新西兰', 'new zealand',

  // —— 2026-10-05：补齐「采集侧有、推送侧没有」的概念（用户报的土耳其那条）——
  //
  // 这一组不是随手加的，是**逐条对着采集侧的清单算出来的差集**，只取
  // 「推送侧也读得到的形态」（汉字 + 拉丁）。差集里的西里尔形态留在
  // `FOREIGN_KEYWORDS_INGEST_ONLY`，会撞词的拉丁短词（`usa`/`eu `）同理。
  '土耳其', 'türkiye', 'turkey', 'turkish', '安卡拉', 'ankara',
  // ⚠️ ` nato` 的**前导空格是故意的**（沿用采集侧原本的写法）：裸 `nato` 会命中
  // `Renato` / `Donato` 这类人名内部。代价是它在中文里也匹配不上「北约（NATO）」，
  // 所以汉字形态 `北约` 必须同时留着 —— 推送侧真正生效的是那一条。
  '北约', ' nato',
  '土库曼斯坦', 'turkmenistan', 'turkmen', '阿什哈巴德', 'ashgabat',
  '克里姆林宫', 'kremlin', '普京', 'putin',
];

/**
 * 外国词的**采集侧专用**形态。
 *
 * 两类，理由不同，别混为一谈：
 *
 * ① **西里尔 / 中亚语词干**：推送侧读的是中文，这些词在中文里不可能出现，
 *    带过去只会让清单看起来更全、实际更难维护。
 *    ⚠️ 选词干时避开会撞车的：`газа` 同时是「天然气的二格」（能源新闻会误伤）、
 *    `анкер` 是「建筑锚栓」（基建新闻会误伤）、`инди` 会撞上 `индикатор`。
 *    这些宁可漏放（后面还有 LLM 的 `investorRelevant` 把关），也不能误杀本国新闻。
 *
 * ② **会撞词的拉丁短词**：`usa` 会命中 `usage` / `USAID`；`eu ` 会命中 `Europe`。
 *    推送侧读的中文里根本不会出现它们，所以「留在采集侧」既保证了不误杀，
 *    也没有丢任何检出能力。
 */
export const FOREIGN_KEYWORDS_INGEST_ONLY: string[] = [
  // ① 俄语（词干）
  'росси', 'москв', 'кремл', 'путин',
  'кита', 'пекин',
  'сша', 'америк', 'вашингтон',
  'украин', 'киев',
  'нигери', 'индия', 'индии', 'индию', 'иран', 'ирак', 'израил', 'палестин',
  'турци', 'пакистан', 'афганистан',
  'германи', 'франци', 'британ', 'лондон',
  'япони', 'токио', 'коре', 'сеул', 'вьетнам', 'таиланд',
  'саудов', 'эмират', 'катар', 'египет', 'бразил', 'мексик', 'аргентин',
  'евросоюз', 'европейск',
  'туркменистан',
  // 哈萨克语/吉尔吉斯语常用国名
  'қытай', 'ресей',
  // ② 会撞词的拉丁短词
  'usa', 'eu ',
];

/**
 * **外国概念的检查清单** —— 存在的唯一目的是让「漏一个概念」变成**可测的失败**。
 *
 * ## 为什么要这样一个东西
 *
 * 用户 2026-09-20 报过一次「阿塞拜疆频道出现土耳其新闻」，2026-10-04 **又报了一次**
 * —— 因为补清单时补的是采集侧，推送侧没跟上。清单本身有 340 条，
 * 靠人眼比对两个数组**根本不可能发现少了一条**。
 *
 * 所以：**清单里每一条都必须有一个汉字形态**（`zh`），并且
 * `scripts/test-country-relevance.ts` 会断言它在 `FOREIGN_KEYWORDS` 里。
 * 汉字形态是**推送侧唯一读得到的东西** —— 有了这条断言，
 * 「某个概念只在采集侧存在」这种状态就不可能悄悄上线。
 *
 * ⚠️ 加新概念时**两件事一起做**：往 `FOREIGN_KEYWORDS` 加词，往这里加一行。
 * 只加词不加行 → 断言不会保护它；只加行不加词 → 测试立刻红（这正是我们要的）。
 */
export const FOREIGN_CONCEPT_CHECKLIST: Array<{
  /** 概念名（中文，只用于日志与失败信息） */
  label: string;
  /** **必须**出现在 `FOREIGN_KEYWORDS` 里的汉字形态 */
  zh: string;
}> = [
  { label: '土耳其', zh: '土耳其' },
  { label: '土库曼斯坦', zh: '土库曼斯坦' },
  { label: '俄罗斯', zh: '俄罗斯' },
  { label: '中国', zh: '中国' },
  { label: '美国', zh: '美国' },
  { label: '欧盟', zh: '欧盟' },
  { label: '英国', zh: '英国' },
  { label: '德国', zh: '德国' },
  { label: '法国', zh: '法国' },
  { label: '意大利', zh: '意大利' },
  { label: '伊朗', zh: '伊朗' },
  { label: '伊拉克', zh: '伊拉克' },
  { label: '以色列', zh: '以色列' },
  { label: '巴勒斯坦', zh: '巴勒斯坦' },
  { label: '沙特', zh: '沙特' },
  { label: '阿联酋', zh: '阿联酋' },
  { label: '卡塔尔', zh: '卡塔尔' },
  { label: '阿曼', zh: '阿曼' },
  { label: '印度', zh: '印度' },
  { label: '巴基斯坦', zh: '巴基斯坦' },
  { label: '阿富汗', zh: '阿富汗' },
  { label: '日本', zh: '日本' },
  { label: '韩国', zh: '韩国' },
  { label: '朝鲜', zh: '朝鲜' },
  { label: '越南', zh: '越南' },
  { label: '泰国', zh: '泰国' },
  { label: '马来西亚', zh: '马来西亚' },
  { label: '印度尼西亚', zh: '印度尼西亚' },
  { label: '新加坡', zh: '新加坡' },
  { label: '蒙古', zh: '蒙古' },
  { label: '格鲁吉亚', zh: '格鲁吉亚' },
  { label: '亚美尼亚', zh: '亚美尼亚' },
  { label: '乌克兰', zh: '乌克兰' },
  { label: '白俄罗斯', zh: '白俄罗斯' },
  { label: '波兰', zh: '波兰' },
  { label: '罗马尼亚', zh: '罗马尼亚' },
  { label: '保加利亚', zh: '保加利亚' },
  { label: '希腊', zh: '希腊' },
  { label: '塞尔维亚', zh: '塞尔维亚' },
  { label: '匈牙利', zh: '匈牙利' },
  { label: '捷克', zh: '捷克' },
  { label: '奥地利', zh: '奥地利' },
  { label: '瑞士', zh: '瑞士' },
  { label: '荷兰', zh: '荷兰' },
  { label: '比利时', zh: '比利时' },
  { label: '西班牙', zh: '西班牙' },
  { label: '葡萄牙', zh: '葡萄牙' },
  { label: '瑞典', zh: '瑞典' },
  { label: '挪威', zh: '挪威' },
  { label: '芬兰', zh: '芬兰' },
  { label: '丹麦', zh: '丹麦' },
  { label: '爱尔兰', zh: '爱尔兰' },
  { label: '加拿大', zh: '加拿大' },
  { label: '墨西哥', zh: '墨西哥' },
  { label: '巴西', zh: '巴西' },
  { label: '阿根廷', zh: '阿根廷' },
  { label: '智利', zh: '智利' },
  { label: '秘鲁', zh: '秘鲁' },
  { label: '古巴', zh: '古巴' },
  { label: '埃及', zh: '埃及' },
  { label: '南非', zh: '南非' },
  { label: '尼日利亚', zh: '尼日利亚' },
  { label: '肯尼亚', zh: '肯尼亚' },
  { label: '摩洛哥', zh: '摩洛哥' },
  { label: '苏丹', zh: '苏丹' },
  { label: '索马里', zh: '索马里' },
  { label: '澳大利亚', zh: '澳大利亚' },
  { label: '新西兰', zh: '新西兰' },
];

// ---------------------------------------------------------------------------
// 四、取词（按侧）
// ---------------------------------------------------------------------------

/** 本国词（按侧）。`countryCode` 是 `'intl'` 或未知时返回空 —— 由区域词接手。 */
export function selfKeywordsFor(countryCode: string, side: RelevanceSide): string[] {
  if (side === 'push') return SELF_KEYWORDS[countryCode as CountryCode] || [];
  return [
    ...(SELF_KEYWORDS[countryCode as CountryCode] || []),
    ...(SELF_KEYWORDS_SOURCE_SCRIPT[countryCode] || []),
  ];
}

/** 区域词（按侧）。 */
export function regionKeywordsFor(side: RelevanceSide): string[] {
  return side === 'push'
    ? REGION_KEYWORDS
    : [...REGION_KEYWORDS, ...REGION_KEYWORDS_INGEST_ONLY];
}

/** 外国词（按侧）。 */
export function foreignKeywordsFor(side: RelevanceSide): string[] {
  return side === 'push'
    ? FOREIGN_KEYWORDS
    : [...FOREIGN_KEYWORDS, ...FOREIGN_KEYWORDS_INGEST_ONLY];
}

/**
 * 把**另外几个目标国**的关键词也算作「别国」。
 *
 * 这是 2026-09-21 截图复核时抓出来的漏网：吉尔吉斯频道头条是
 * `哈萨克斯坦8月通胀率达12.5%，主要受燃料价格飙升推动`，乌兹别克频道里有
 * `哈萨克斯坦推进公共卫生系统现代化`。实测 200 篇里有 16 篇是这种「入库国别 ≠
 * 标题所指国别」（kg→kz 9 篇、uz→kz 4 篇等）。
 *
 * 为什么会漏：`FOREIGN_KEYWORDS` 只列了**非目标国**。一篇讲哈萨克斯坦的新闻
 * 落在吉尔吉斯频道里时，既不在吉尔吉斯的本国词表里，也不在任何「外国」词表里，
 * 于是命中兜底「什么国家都没提到 → 放行」。
 *
 * 只在**本国词表都没命中之后**才查这里，所以不会误杀
 * `哈萨克斯坦与土耳其签署协议` 这种「本国 + 别国」的正常新闻。
 *
 * ⚠️ 不再需要显式跳过 `'intl'`：`SELF_KEYWORDS` 的键就是 5 个国家，没有 `intl`。
 * `tm` 也不再需要在这里单列 —— 它已经进了 `FOREIGN_KEYWORDS`。
 */
export function otherCountryKeywords(countryCode: string, side: RelevanceSide): string[] {
  return (Object.keys(SELF_KEYWORDS) as CountryCode[])
    .filter((code) => code !== countryCode)
    .flatMap((code) => selfKeywordsFor(code, side));
}

// ---------------------------------------------------------------------------
// 五、判据本体
// ---------------------------------------------------------------------------

export interface RelevanceInput {
  title: string;
  /** 采集侧传 RSS 的 description，推送侧传 `article.summary` */
  summary: string;
  /** 归属国代码（采集侧是 `resolveArticleCountry` 的结果；推送侧是 `country_code`） */
  countryCode: string;
  /**
   * 稿子的来源国（源配置里的 `country`）。**只有采集侧传**。
   *
   * 它同时是「这是哪一侧」的开关 —— 因为**两侧唯一真正的差别就是兜底那一句**：
   *   · 采集侧：谁都没提 → 只有当稿子来自该国**自己的媒体**时才算相关
   *     （intl 综合源没有「本国」可兜底）；
   *   · 推送侧：谁都没提 → 放行。此时 `country_code` 是**采集侧已经判过的结论**，
   *     再拿源国重判一次只会把结论推翻。
   *
   * ⚠️ 用「参数有没有传」来表达侧别，是**故意的**：这样调用点各自只需要写自己知道的
   * 东西，「忘了传 sourceCountry」在推送侧是正确行为、在采集侧一眼能看出来
   * （因为 `isCountryRelevant` 只有一个名字，参数表就是文档）。
   */
  sourceCountry?: string;
}

/**
 * 判断一篇新闻是否真的与目标国家相关。
 *
 * 判定顺序（**顺序本身就是规则，不要重排**）：
 *   1. 命中**本国** → 相关（哪怕同时提到别国：`哈萨克斯坦与土耳其签署协议` 必须留）；
 *   2. 命中**区域/合作框架** → 相关（`中国—中亚天然气管道`）；
 *   3. 命中**任何别国**（含另外四个目标国）→ 不相关；
 *   4. 命中**任何外国** → 不相关；
 *   5. 兜底（**两侧不同**，见 `RelevanceInput.sourceCountry` 的说明）。
 */
export function isCountryRelevant(input: RelevanceInput): boolean {
  const { title, summary, countryCode, sourceCountry } = input;
  const text = `${title} ${summary}`.toLowerCase();
  const side: RelevanceSide = sourceCountry === undefined ? 'push' : 'ingest';

  if (selfKeywordsFor(countryCode, side).some((kw) => text.includes(kw.toLowerCase()))) return true;

  if (regionKeywordsFor(side).some((kw) => text.includes(kw.toLowerCase()))) return true;

  if (otherCountryKeywords(countryCode, side).some((kw) => text.includes(kw.toLowerCase()))) {
    return false;
  }

  if (foreignKeywordsFor(side).some((kw) => text.includes(kw.toLowerCase()))) return false;

  if (side === 'push') return true;
  return sourceCountry === countryCode && countryCode !== 'intl';
}
