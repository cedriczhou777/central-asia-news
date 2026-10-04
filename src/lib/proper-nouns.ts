/**
 * 术语表 + 术语闸：**国家 → 货币**、已知错译写法黑名单、元首称谓。
 *
 * ## 存在的理由（2026-10-05）
 *
 * 用户 2026-10-04 一次列出六处术语错（他把这些叫「低级错误」，并且强调「说过多次了」）：
 *   · 阿塞拜疆的工资 / 黄金 / 投资额写成**坚戈**（应为马纳特）
 *   · 吉尔吉斯斯坦的汇率写成**坚戈**（应为索姆）
 *   · 吉尔吉斯斯坦的稿子里出现**苏姆**（那是乌兹别克斯坦的货币）
 *   · Almaty 被译成「阿利穆特」/「阿利穆拉特」
 *   · 吉尔吉斯斯坦楚河州的 **Alamedin** 区被译成「阿拉木图区」
 *   · 阿曼的 Sultan（国家元首）被译成「苏丹国王」
 *
 * 而**此前代码里对这些一条保障都没有**（2026-10-05 全仓核实）：
 *   · 搜 `KZT` / `AZN` / `KGS` / `UZS` / `TJS` / `tenge` / `manat` → **零命中**，
 *     即「国家 → 货币」这张表**不存在**；`countries.ts` 每国只有 code/name/nameEn/capital/color/flag。
 *   · 翻译提示词里只有一句平铺列举「坚戈、马纳特、苏姆、美元」（`translate.ts` 第 6 条末），
 *     **从未写过「哪国用哪个」** —— 而且那句里**连「索姆」「索莫尼」都没有**，
 *     模型当然会把吉尔吉斯斯坦的货币写成它唯一见过的那个（苏姆）。
 *   · 地名没有代码级校验（提示词里有硬编码对照，但对照错了没人拦）。
 *   · 人名只有提示词第 6 条 + 只读体检脚本 `analyze-proper-nouns.ts` 的清单，**无生产闸**。
 *
 * ## 为什么必须做成「闸」而不是继续往提示词里加字
 *
 * 同项目已经量出过结论（`translate.ts` 的 `mixedScriptTokensLatin` 注释）：
 * 提示词第 6 条**早就逐字写着** `斯皮塔梅en` / `霍贾and` 是禁止反例，
 * 而口径改完之后的新产出里它们**照样出现** ——
 * ⇒ **对这类系统性错误，提示词是无效的承载体，只有闸门能兜住。**
 * 术语错是同一类：模型不是随机手滑，而是「只见过一个货币名就到处用」。
 *
 * ## 与提示词「共用一条判据」的做法（项目既有纪律：一处定义、多处调用）
 *
 * 货币那句提示词**由本文件的表生成**（`currencyPromptTable()`，经 `{CURRENCIES}` 注入），
 * 闸门（`checkCurrencyCountryFit`）读**同一张表**。所以「提示词说哪国用哪个」
 * 与「闸门按哪国判」不可能分叉 —— 想改口径只能改这里一处。
 *
 * ⚠️ **但黑名单（`WRONG_PROPER_NOUN_FORMS`）刻意不进提示词。** 理由是本项目
 * 已经实测过的污染：提示词里当示例写出来的专名会被模型**搬去当正文主语**
 * （见 `translate.ts` 第 6 条的 ⚠️，一篇吉尔吉斯公路稿因为提示词里有某国总统名，
 * 标题就被写成了「〈某国总统〉政府完成…」）。把「阿利穆特」写进提示词，
 * 最可能的后果是**让模型开始使用这个词**。所以：**正确写法进提示词（阿拉木图/阿拉梅金），
 * 错误写法只进闸门**。这条区分是有意的，别「顺手统一」掉。
 */

import type { CountryCode } from './data/types';
import { countries, countryList } from './data/countries';
import { SELF_KEYWORDS } from './country-relevance';

/**
 * 术语表版本号。
 *
 * **任何表格改动（加一国、改一个译名、动黑名单）都必须动它** ——
 * 线上复核靠它确认「这一版真的部署了」。理由与 `EDITOR_GATE_VERSION` 完全相同：
 * 提示词一个字没改时，老指纹（`translatePromptVersion`）是个**常量**，
 * 拿它证明不了任何事（旧代码也输出同一个值）。版本号是**旧代码不可能产出**的值。
 */
export const PROPER_NOUN_VERSION = 'pn1';

// ---------------------------------------------------------------------------
// 一、国家 → 货币
// ---------------------------------------------------------------------------

/** 一个国家的法定货币。`aliases` 是**两向共用**的：判「本国货币出现了吗」也用它。 */
export interface CurrencySpec {
  /** 中文写法（提示词与闸门共用这一份） */
  zh: string;
  /** ISO 4217 */
  code: string;
  /**
   * 该货币的其它可接受写法（匹配前统一小写）。
   *
   * ⚠️ 加别名的方向性：对**本国货币**而言别名越多越安全（多一个就少一次误判）；
   * 对**别国货币**而言别名越多越容易误杀。所以这里**只收确实通行**的异写
   * （`腾格` = tenge 的另一译法、`玛纳特` = manat 的另一译法），
   * 不收「看起来也像」的猜法。
   */
  aliases: string[];
}

/**
 * 本项目 5 个目标国的法定货币。
 *
 * ⚠️ **阿塞拜疆与土库曼斯坦的货币中文名都是「马纳特」** ——
 * `tm` 不在 `CountryCode` 里（它不是推送目标国，只作为「外国」关键词存在），
 * 所以这张表里不需要为它单列；但写代码时要知道「马纳特」这个词**天然不唯一**，
 * 别把它当成阿塞拜疆的专属标记（详见 `checkCurrencyCountryFit` 的注释）。
 */
export const COUNTRY_CURRENCY: Record<CountryCode, CurrencySpec> = {
  kz: { zh: '坚戈', code: 'KZT', aliases: ['坚戈', '腾格', 'kzt'] },
  uz: { zh: '苏姆', code: 'UZS', aliases: ['苏姆', 'uzs'] },
  kg: { zh: '索姆', code: 'KGS', aliases: ['索姆', 'kgs'] },
  // ⚠️ `苏姆尼` 是实测到的**通行度不足但确实指向塔吉克货币**的异写
  // （id=9175「平均月薪约 3,500 苏姆尼」）。把它收成别名是**有意的**：
  // 不收的话那篇会被判成「塔吉克斯坦的稿子里写了乌兹别克货币」，
  // 而重试带去的修正指令是「改成索莫尼」—— 模型答不答得上看运气，答不上就丢稿。
  // 判据要管的是「**哪国用哪个货币**」，「同一个货币写成哪个音译更好」是另一件事，
  // 不该由这条闸承担。**宁可留着这个不理想的译名（看得见），不要丢稿（看不见）。**
  tj: { zh: '索莫尼', code: 'TJS', aliases: ['索莫尼', '苏姆尼', 'tjs'] },
  az: { zh: '马纳特', code: 'AZN', aliases: ['马纳特', '玛纳特', 'azn'] },
};

/**
 * 「整词里含货币名、可它根本不是货币」的词 —— 匹配前先抹掉。
 *
 * 每一条都对应一个**在真实语料上实测到**的假阳性，不是想象的
 * （2026-10-05 实测 2812 篇，见 `pnpm analyze:currency`）：
 *
 * - **`苏姆盖特` / `苏姆盖蒂`**（Sumqayit / Sumqayıt，阿塞拜疆第三大城市）
 *   整词包含「苏姆」。而「苏姆盖特」正躺在 `SELF_KEYWORDS.az` 里 ——
 *   阿塞拜疆的地方新闻提到这座城市是**常态**。
 *
 *   ⚠️ **必须用正则，不能写成两个固定词** —— 第一版就是一个 `苏姆盖特` 字符串，
 *   实测当场漏掉一条：`az` 栏目里那篇土-阿足球赛稿写的是「吉尔吉斯斯坦**苏姆盖蒂**的
 *   Mehti Guseinzade 体育场」（`id=9804`），**换了个尾字就绕过了排除**，
 *   于是被误判成「阿塞拜疆的稿子里写了乌兹别克货币」。
 *   这类「同一地名多种音译尾字」在语料里是常态（`盖特/盖蒂/盖德`），
 *   所以判据要写成 `苏姆盖[特蒂德]`，而不是列举。
 * - **`索姆河`**（Somme，法国河流 / 一战战场）整词包含「索姆」。
 *   中亚新闻里出现它概率极低，但它是**唯一**一个真实的、含「索姆」的非货币词，
 *   排除它的成本是零。
 *
 * ⚠️ 抹掉是**无条件**的（不区分国家）：`苏姆盖特` 在任何稿子里都不是货币。
 */
const CURRENCY_FALSE_FRIENDS: RegExp[] = [
  /苏姆盖[特蒂德]/g, // Sumqayit —— 阿塞拜疆城市，不是乌兹别克货币
  /索姆河/g, // Somme —— 法国河流，不是吉尔吉斯货币
];

/** 把假朋友整词从文本里抹掉，剩下的才参与货币匹配。 */
function maskFalseFriends(text: string): string {
  let out = text;
  for (const re of CURRENCY_FALSE_FRIENDS) out = out.replace(re, '　');
  return out;
}

/**
 * **前置条件**：这篇稿子的文本里得先有「它确实是这个国家」的证据。
 *
 * ## 为什么非有不可（2026-10-05 实测出来的，不是想出来的）
 *
 * 第一版判据没有这一条，直接在 2812 篇上跑，结果 68 篇命中 —— 逐条读下来发现，
 * 命中里有相当一部分是**「稿子被归错了国」**，而不是「货币写错了」：
 *   · `uz` 栏目里的《哈萨克斯坦向 61,548 户安装太阳能的家庭发放 105.4 亿坚戈补贴》
 *   · `kg` 栏目里的《总统令，批准 2025 年国家预算草案…收入预计为 390 亿马纳特》
 *     （那是土库曼斯坦的预算，石油天然气收入）
 * 这些稿子里「坚戈」「马纳特」**本来就是对的**，错的是入库国别。
 *
 * 如果没有这条前置条件，闸门会拿它们去触发重试，而重试带的修正指令是
 * 「本条是乌兹别克斯坦的稿子，货币必须是苏姆」—— 模型会**照做**，
 * 于是把一篇正确的哈萨克斯坦稿子**改成**乌兹别克斯坦的货币写进 `uz` 栏目。
 * 那不是修复，那是把「国别放错」升级成「正文也编了」。
 *
 * 加了这条之后，这类稿子**原样穿过**翻译阶段，交给 `article-format.ts` 的
 * `isCountryRelevant`（推送侧，读的是中文标题）去丢 —— 那才是能真正解决它的层。
 * **问题的修复权应该落在能修它的那一层。**
 *
 * ## 已知代价
 *
 * 会漏掉「正文里没提本国名、但确实是本国稿」的错币种稿（如某篇只讲黄金价格的
 * 阿塞拜疆稿）。按项目纪律「下游是丢弃的判据宁漏不误杀」，这是有意的取舍。
 */
function ownCountryMentioned(countryCode: CountryCode, text: string): boolean {
  const own = SELF_KEYWORDS[countryCode];
  if (!own || own.length === 0) return false;
  const t = text.toLowerCase();
  return own.some((kw) => t.includes(kw.toLowerCase()));
}

/**
 * 货币与所属国不符。
 *
 * 判据（**顺序即规则，不要重排** —— 与 `article-format.ts` 的 `isCountryRelevant` 同一纪律）：
 *   0. **前置条件：文本里得有「它确实是这个国家」的证据**（`ownCountryMentioned`）。
 *      没有就直接放行 —— 理由见那个函数的注释，这是实测出来的、最容易被忽略的一条。
 *   1. **本国货币出现过 → 放行。** 哪怕同时出现别国货币：
 *      「阿塞拜疆与哈萨克斯坦贸易额以马纳特与坚戈结算」是正常新闻，必须留。
 *   2. 本国货币没出现，但出现了别国货币 → **命中**。
 *   3. 什么货币都没出现（绝大多数稿子） → 放行。
 */
export interface CurrencyMismatch {
  /** 本条所属国家的法定货币（中文） */
  own: string;
  ownCode: string;
  /** 命中的别国货币 */
  foreign: Array<{ word: string; country: CountryCode; zh: string; code: string }>;
  /** 给日志和重试修正指令用的说明 */
  reason: string;
}

/**
 * 判断「这篇稿子里的货币写对了国家没有」。
 *
 * ## 为什么这条判据在结构上是安全的（不靠阈值）
 *
 * 「某个国家自己的货币一次都没出现、出现的全是别国的货币」——
 * 这不是「像不像」的概率判断，而是**两个事实的合取**。
 * 唯一能反驳它的情形是「一篇 X 国新闻通篇只用别国货币计价」，
 * 而那在业务上不成立：稿子讲的是 X 国的工资/物价/投资额，X 国自己的货币必然要出现。
 * 真出现「只提别国货币」的合法稿子（例如「土库曼斯坦以马纳特结算」落在 kg 栏目，
 * 且通篇不提索姆），代价是重试一次 —— 而不是直接丢稿（见下面的说明）。
 *
 * ## 已知盲区（**有意保留**，别当 bug 修）
 *
 * 判据扫的是 `title + summary + content` 的**合并文本**。
 * 于是「标题写错币种、正文里出现了正确币种」这种**局部错**抓不到。
 * 为什么不改成「逐字段各判一次」：那样「哈萨克斯坦与乌兹别克斯坦贸易额以苏姆计价」
 * 这类**合法**的 kz 标题（本国货币真的不必出现）会被误杀。
 * 两害相权，按项目纪律「下游是丢弃的判据宁漏不误杀」选了合并文本。
 * 用户报的六处全是**整篇系统性**写错（一整篇的金额都是坚戈），合并文本抓得到。
 */
export function checkCurrencyCountryFit(
  countryCode: CountryCode,
  text: string,
): CurrencyMismatch | null {
  const own = COUNTRY_CURRENCY[countryCode];
  if (!own) return null;

  const masked = maskFalseFriends(text);
  // 0. 前置条件：先证「这篇稿子确实是这个国家的」（见 ownCountryMentioned 的注释）
  if (!ownCountryMentioned(countryCode, masked)) return null;

  const t = masked.toLowerCase();

  // 1. 本国货币出现 → 放行
  if (own.aliases.some((w) => t.includes(w))) return null;

  // 2. 别国货币
  const foreign: CurrencyMismatch['foreign'] = [];
  for (const [code, spec] of Object.entries(COUNTRY_CURRENCY) as Array<[CountryCode, CurrencySpec]>) {
    if (code === countryCode) continue;
    const word = spec.aliases.find((w) => t.includes(w));
    if (word) foreign.push({ word, country: code, zh: spec.zh, code: spec.code });
  }
  if (foreign.length === 0) return null;

  const listed = foreign
    .map((f) => {
      // ⚠️ 「马纳特」这个名字**天然不唯一**：阿塞拜疆与土库曼斯坦的货币中文名相同。
      // 只写「马纳特（阿塞拜疆）」会让读日志的人以为判据认错了国 —— 土库曼斯坦的
      // 稿子是**该**被判「不是本国的货币」的。把这一点写在提示里，别让人去猜。
      const also = f.zh === '马纳特' ? '（土库曼斯坦的货币中文名相同）' : '';
      return `${f.zh}（${countries[f.country].name}${also}）`;
    })
    .join('、');
  return {
    own: own.zh,
    ownCode: own.code,
    foreign,
    reason:
      `货币与所属国不符：本条是**${countries[countryCode].name}**的稿子，` +
      `但通篇没有出现${own.zh}（${own.code}），出现的全是 ${listed}`,
  };
}

// ---------------------------------------------------------------------------
// 二、已知错译写法黑名单
// ---------------------------------------------------------------------------

/** 一条「这种写法是错的」的记录。 */
export interface WrongForm {
  /** 错误写法（逐字包含匹配） */
  wrong: string;
  /** 正确写法 */
  right: string;
  /** 只在哪个国家的稿子里算错？不填 = 任何国家的稿子里都算错 */
  onlyCountry?: CountryCode;
  /** 为什么错 —— 会进日志和重试修正指令，必须写成人话 */
  why: string;
}

/**
 * 已知错译写法。**这是黑名单，不是通用转写校验器** —— 通用校验做不到确定性，
 * 而这里每一条都是「这个词在中文里没有别的意思」，所以包含匹配就是**零误判**。
 *
 * 加条目的门槛：**必须能说清「这个字符串在中文语境下只可能是那个错误」**。
 * 拿不准的一律不加（宁可漏，因为下游是丢稿）。
 */
export const WRONG_PROPER_NOUN_FORMS: WrongForm[] = [
  {
    wrong: '阿利穆特',
    right: '阿拉木图',
    why: 'Almaty（哈萨克斯坦最大城市、前首都）的通行译名是「阿拉木图」，「阿利穆特」不是任何地名',
  },
  {
    wrong: '阿利穆拉特',
    right: '阿拉木图',
    why: '同上 —— 2026-10-04 用户报上来的第二种错写法',
  },
  {
    wrong: '阿拉木图区',
    right: '阿拉梅金区',
    onlyCountry: 'kg',
    why:
      'Аламедин / Alamedin 是吉尔吉斯斯坦楚河州的区，通行译名「阿拉梅金（区）」；' +
      '哈萨克斯坦的阿拉木图是直辖市，没有叫「阿拉木图区」的下辖区',
  },
  {
    wrong: '苏丹国王',
    right: '阿曼苏丹',
    why:
      '「苏丹」（Sultan）本身就是国家元首称号 —— 阿曼、文莱等国的元首就叫苏丹；' +
      '再叠一个「国王」是把称号当成了国名（2026-10-04 用户报的「低级错误」）',
  },
  {
    wrong: '国王苏丹',
    right: '阿曼苏丹',
    why: '同上，另一种语序',
  },
];

/** 命中的错译写法。 */
export interface WrongNounHit {
  wrong: string;
  right: string;
  why: string;
}

/**
 * 扫出稿子里的已知错译写法。**与货币闸相互独立**（两者可以同时命中）。
 *
 * `countryCode` 只用来判 `onlyCountry` 限定的条目；不传就只查不限国家的条目。
 */
export function checkWrongProperNouns(
  countryCode: CountryCode | null | undefined,
  text: string,
): WrongNounHit[] {
  const hits: WrongNounHit[] = [];
  for (const f of WRONG_PROPER_NOUN_FORMS) {
    if (f.onlyCountry && f.onlyCountry !== countryCode) continue;
    if (text.includes(f.wrong)) hits.push({ wrong: f.wrong, right: f.right, why: f.why });
  }
  return hits;
}

// ---------------------------------------------------------------------------
// 三、元首 / 国家称号（只用来说明，不作硬判据）
// ---------------------------------------------------------------------------

/**
 * 「同一个人 / 同一个称号在不同语言里的写法」提示。
 *
 * ⚠️ 这一节**刻意不做闸**，理由同人名：这类词的同义写法太多，
 * 硬判据必然误杀「阿曼苏丹海赛姆」这种正确写法。它只进提示词。
 * （真正会出事的那两种错误语序已经进了上面的黑名单。）
 */
export const HEAD_OF_STATE_NOTES = ['阿曼的国家元首称号是「苏丹」（Sultan），不是「国王」'];

// ---------------------------------------------------------------------------
// 四、提示词注入（与闸门共用同一张表）
// ---------------------------------------------------------------------------

/**
 * 渲染货币对照表，注入翻译提示词的 `{CURRENCIES}` 占位符。
 *
 * **必须是生成式的**：手写在提示词里的表迟早会与 `COUNTRY_CURRENCY` 分叉，
 * 而分叉的后果是「模型按 A 写、闸门按 B 判」—— 每篇都错、每篇都重试。
 * 导出是为了让离线回归能断言「表在提示词里出现且逐国正确」。
 */
export function currencyPromptTable(): string {
  return countryList
    .map((c) => `${c.name} → ${COUNTRY_CURRENCY[c.code].zh}（${COUNTRY_CURRENCY[c.code].code}）`)
    .join('；');
}

/**
 * 中文国名 → 国家代码。
 *
 * 存在的理由：`translateNews` 收的是**中文国名**（提示词里那句硬事实），
 * 而闸门要的是代码。两侧必须来自**同一个输入**，否则「提示词说的是阿塞拜疆、
 * 闸门按哈萨克斯坦判」这种分叉会静默地把好稿子判死。
 */
export function countryCodeByName(name: string): CountryCode | null {
  const hit = countryList.find((c) => c.name === name || c.code === name);
  return hit ? hit.code : null;
}

// ---------------------------------------------------------------------------
// 五、活体探针
// ---------------------------------------------------------------------------

/**
 * 术语闸的**活体探针**：拿固定样例跑**真实判据**，返回一行可读的结论。
 *
 * ## 为什么必须带上它（2026-10-05）
 *
 * 这一版**同时改了提示词和一个新闸门**，而两者都没有「旧代码不可能产出的老指纹」：
 *   · 提示词改动：`translatePromptVersion` 那类常量在老代码里也是同一个值，
 *     拿它证明不了任何事（见 `EDITOR_GATE_VERSION` 的同类说明）；
 *   · 闸门是新加的：老代码**根本不会报**这一项 ⇒ 只要响应里出现它就是新的。
 * 所以指纹用 `PROPER_NOUN_VERSION` + 这个探针一起表达。
 *
 * ## 为什么是「双向」的
 *
 * 只测「错的会被拦」证明不了闸门可用 —— 它完全可以靠「什么都拦」做到。
 * 反过来只测「对的会放行」也不行。下面六条里**三条必须命中、三条必须放行**，
 * 而且三条「必须放行」各自对应一个**实测过的假阳性陷阱**（不是凑数）：
 *   · C 苏姆盖特 —— 城市名里含「苏姆」（实测误报过）
 *   · D 归错国的稿子 —— 哈萨克斯坦的稿子落在 uz 栏目里（实测 27 篇这一类）
 *   · B 正确写法 —— 吉尔吉斯斯坦真的用「索姆」
 *
 * ⚠️ 探针**必须调用真判据**，不许手写 `true` —— 那样测的是探针自己。
 * `scripts/test-zh-gate.ts` 有断言钉住这一点（要求本函数体内出现
 * `checkCurrencyCountryFit(` 与 `checkWrongProperNouns(`）。
 */
export function termGateProbe(): string {
  const cur = (code: CountryCode, text: string) => {
    const r = checkCurrencyCountryFit(code, text);
    return r ? `拦(${r.own})` : '放行';
  };
  const noun = (code: CountryCode, text: string) => {
    const r = checkWrongProperNouns(code, text);
    return r.length ? `拦(${r.map((h) => h.wrong).join('/')})` : '放行';
  };
  const parts = [
    // —— 必须命中：三种实测过的真缺陷 ——
    `A:${cur('az', '阿塞拜疆制造业平均工资达 1335 坚戈，采矿行业达 3700 坚戈。')}`,
    `D2:${noun('kz', '阿利穆拉特市市长要求检查街道美化项目承包商')}`,
    `E:${noun('kz', '苏丹国王访问哈萨克斯坦，哈萨克斯坦国家元首参加会谈')}`,
    '|',
    // —— 必须放行：三个实测过的假阳性陷阱 + 正确写法 ——
    `B:${cur('kg', '吉尔吉斯斯坦8月平均月薪为 25000 索姆，比什凯克物价同比上涨。')}`,
    `C:${cur('az', '阿塞拜疆巴库与苏姆盖特的体育场将举行比赛。')}`,
    `D:${cur('uz', '哈萨克斯坦向 61,548 户安装太阳能的家庭发放 105.4 亿坚戈补贴。')}`,
  ];
  return parts.join(' ');
}

/** 活体探针的期望值。**逐字量出来的**，不是猜的（改判据必须同步改这里）。 */
export const TERM_GATE_PROBE_EXPECT =
  'A:拦(马纳特) D2:拦(阿利穆拉特) E:拦(苏丹国王) | B:放行 C:放行 D:放行';
