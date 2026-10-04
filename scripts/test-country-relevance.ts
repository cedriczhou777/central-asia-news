/**
 * 国家相关性判据的离线回归（不联网、不调模型）。
 *
 * 用法：`pnpm test:country-relevance`
 *
 * ## 这个脚本存在的理由
 *
 * 用户 2026-09-20 报过一次「阿塞拜疆频道出现土耳其新闻」，2026-10-04 **又报了一次**。
 * 根因是同一个判据被写在两处、两份词表内容不同：采集侧有 `土耳其`、推送侧没有。
 * 词表有 340 条，靠人眼比对两个数组**不可能**发现少了一条 ——
 * 所以这次除了把词表合一，还必须把「漏一个概念」变成**测试会红的事**。
 *
 * 本脚本钉住四件事：
 *   ① **每个外国概念都有汉字形态**（`FOREIGN_CONCEPT_CHECKLIST`）——
 *      汉字是推送侧唯一读得到的形态，这条让「土耳其那种事故」无法再上线；
 *   ② **每个本国都有汉字词**，否则那个国家在推送侧等于不可检测；
 *   ③ 判据**双向**：该拦的拦（土耳其稿落进 az 频道）、该留的留（本国 + 别国）；
 *   ④ **只有一份实现**（源码级断言）——判据回归到两处各写一份是本项目的老毛病。
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { CountryCode } from '../src/lib/data/types';
import {
  SELF_KEYWORDS,
  SELF_KEYWORDS_SOURCE_SCRIPT,
  REGION_KEYWORDS,
  REGION_KEYWORDS_INGEST_ONLY,
  FOREIGN_KEYWORDS,
  FOREIGN_KEYWORDS_INGEST_ONLY,
  FOREIGN_CONCEPT_CHECKLIST,
  selfKeywordsFor,
  otherCountryKeywords,
  isCountryRelevant,
} from '../src/lib/country-relevance';

let passed = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name}${detail ? ` —— ${detail}` : ''}`);
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

function section(title: string) {
  console.log(`\n${'─'.repeat(64)}\n${title}\n`);
}

const HAN = /[\u4e00-\u9fff]/;
const CYR = /[\u0400-\u04ff]/;
const CODES: CountryCode[] = ['kz', 'uz', 'kg', 'az', 'tj'];

// ============================================================
// 一、★ 外国概念的汉字形态（这条直接对应「土耳其」那次事故）
// ============================================================

section('一、★ 每个外国概念都必须有汉字形态（推送侧只读得到汉字）');

{
  const foreignLower = new Set(FOREIGN_KEYWORDS.map((k) => k.toLowerCase()));
  for (const c of FOREIGN_CONCEPT_CHECKLIST) {
    ok(
      `概念「${c.label}」在推送侧可检测（${c.zh}）`,
      HAN.test(c.zh) && foreignLower.has(c.zh.toLowerCase()),
      `「${c.zh}」不在 FOREIGN_KEYWORDS 里 ⇒ 中文标题里写「${c.label}」也拦不住`,
    );
  }
  ok('清单非空', FOREIGN_CONCEPT_CHECKLIST.length > 0);

  // 反向：清单里别出现重复概念
  const labels = FOREIGN_CONCEPT_CHECKLIST.map((c) => c.label);
  ok('清单里没有重复概念', new Set(labels).size === labels.length);
}

section('二、★ 每个本国都必须有汉字词');

{
  for (const code of CODES) {
    const words = SELF_KEYWORDS[code] || [];
    ok(`${code}（本国词 ${words.length} 条）含汉字词`, words.some((w) => HAN.test(w)));
    ok(`${code} 含国名本身`, words.some((w) => w === '哈萨克斯坦' || w === '乌兹别克斯坦' || w === '吉尔吉斯斯坦' || w === '阿塞拜疆' || w === '塔吉克斯坦'));
  }
}

// ============================================================
// 三、★ 双向回归
// ============================================================

section('三、★ 双向回归：该拦的拦');

{
  const reject: Array<[CountryCode, string, string, string]> = [
    // ★ 用户报的那一条：土耳其国防工业稿落在阿塞拜疆频道
    ['az', '土耳其总统埃尔多安称土国防工业正经历“全面革命”', '安卡拉方面表示…', '用户原话：阿塞拜疆出现土耳其新闻'],
    ['az', '土耳其外交部：我们正团结一致建设突厥世纪', '土耳其外交部声明…', '同上'],
    ['az', '土耳其 TPAO 计划将每日石油产量提升至 100 万桶', 'TPAO 总部位于安卡拉。', '同上'],
    ['az', '土库曼斯坦：Serdar Berdimuhamedov 推动甲烷减排与天然气出口扩张', '阿什哈巴德消息…', '土库曼斯坦也不是目标国'],
    ['kg', '哈萨克斯坦8月通胀率达12.5%，主要受燃料价格飙升推动', '阿斯塔纳消息…', '2026-09-21 抓到的 kg→kz 漏网'],
    ['uz', '哈萨克斯坦推进公共卫生系统现代化', '政府会议…', '2026-09-21 抓到的 uz→kz 漏网'],
    ['kz', '蒙古国矿难致 12 人遇难', '乌兰巴托消息…', '2026-09-20 报的蒙古 4 篇'],
    ['kg', '第比利斯与巴统之间的铁路停运', '格鲁吉亚铁路公司…', '2026-09-20 报的格鲁吉亚 3 篇'],
  ];
  for (const [code, title, summary, why] of reject) {
    ok(
      `拦下 ${code}：${why}`,
      isCountryRelevant({ title, summary, countryCode: code }) === false,
      `没拦：${title.slice(0, 30)}`,
    );
  }
}

section('四、★ 双向回归：该留的必须留（不许误杀本国新闻）');

{
  const keep: Array<[CountryCode, string, string, string]> = [
    ['az', '阿塞拜疆与哈萨克斯坦以马纳特与坚戈结算贸易额', '巴库与阿斯塔纳签署协议。', '本国 + 别国 → 必须留（判定顺序不可重排）'],
    ['az', '巴库计划 2027 年前建成新港口泊位', '阿塞拜疆政府批准。', '本国首都'],
    ['kz', '哈萨克斯坦与土耳其签署投资协议', '阿斯塔纳消息…', '本国 + 别国'],
    ['uz', '中国投资者在卡拉卡尔帕克斯坦发现4吨黄金储量', '努库斯消息…', '2026-09-21 的误杀案例：本国自治共和国 + 中国'],
    ['kg', '楚河州阿拉梅金区近 70 公顷灌溉农田将用于建设多层住宅', '比什凯克消息…', '本国州名'],
    ['kz', '阿拉木图市新建住宅区', '市政府批准。', '本国城市'],
    ['kg', '奥什市新建学校竣工', '', '本国城市（没有「吉尔吉斯斯坦」字样）'],
    ['az', '甘贾市工业园投产', '占地 40 公顷。', '本国城市'],
    ['tj', '苦盏与杜尚别之间开通新航线', '', '本国城市'],
    ['kz', '政府批准 2026 年预算修正案', '未披露具体金额。', '谁都没提 → 推送侧放行'],
  ];
  for (const [code, title, summary, why] of keep) {
    ok(
      `放行 ${code}：${why}`,
      isCountryRelevant({ title, summary, countryCode: code }) === true,
      `被误杀：${title.slice(0, 30)}`,
    );
  }

  // 区域 / 合作框架信号：必须在外国判断**之前**生效
  ok(
    '中国—中亚天然气管道（同时含「中国」与「中亚」）走区域信号放行',
    isCountryRelevant({ title: '中国—中亚天然气管道扩容', summary: '', countryCode: 'kz' }) === true,
    '区域判断跑到外国判断后面就会误杀这条',
  );
  ok(
    '里海 / 独联体也是区域信号',
    isCountryRelevant({ title: '里海沿岸国家签署协议', summary: '', countryCode: 'kz' }) === true &&
      isCountryRelevant({ title: '独联体国家开会', summary: '', countryCode: 'uz' }) === true,
  );

  // ★ 区域信号**排在外国信号之前**，所以「既含区域词、又点名外国」的稿子**放行**。
  //
  // ⚠️ 这一条是**规则本身**，不是漏网。2026-10-05 我自己第一次写这条用例时写反了
  // （以为「提到莫斯科就该拦」），跑出来是红的 —— 回去读 `country-relevance.ts`
  // 才知道顺序是「本国 → 区域 → 别国 → 外国」，`中国—中亚天然气管道`
  // **必须**放行（`article-format.ts` 里那段注释写的就是这件事）。
  // 保留这条用例，是为了让下一个想「顺手把区域判断挪到外国之后」的人**先红一次**。
  ok(
    '★ 区域信号优先于外国信号：既含「中亚」又点名莫斯科 → 放行（规则，非漏网）',
    isCountryRelevant({
      title: '中国—中亚天然气管道扩容谈判在莫斯科举行',
      summary: '俄罗斯方面参与。',
      countryCode: 'az',
    }) === true,
    '若这条变红，说明判定顺序被改了 —— 请先回读 country-relevance.ts 的判定顺序注释',
  );
}

// ============================================================
// 五、★ 两侧的差别：只该有「兜底」与「语言形态」两处
// ============================================================

section('五、★ 两侧差别（语言形态 + 兜底）');

{
  // 兜底：谁都没提
  const t = '政府批准了预算修正案';
  ok(
    '推送侧兜底 = 放行（country_code 已是采集侧判过的结论）',
    isCountryRelevant({ title: t, summary: '', countryCode: 'kz' }) === true,
  );
  ok(
    '采集侧兜底 = 只有来源是该国自己的媒体才放行',
    isCountryRelevant({ title: t, summary: '', countryCode: 'kz', sourceCountry: 'kz' }) === true &&
      isCountryRelevant({ title: t, summary: '', countryCode: 'kz', sourceCountry: 'intl' }) === false &&
      isCountryRelevant({ title: t, summary: '', countryCode: 'kz', sourceCountry: 'uz' }) === false,
  );

  // 语言形态：西里尔只在采集侧生效
  ok(
    '西里尔形态只在采集侧生效（推送侧读中文，带了也没用）',
    selfKeywordsFor('kz', 'ingest').some((w) => CYR.test(w)) &&
      !selfKeywordsFor('kz', 'push').some((w) => CYR.test(w)),
  );
  ok(
    '采集侧本国词 ⊇ 推送侧本国词（采集侧只会更多，不会更少）',
    CODES.every((c) => {
      const push = new Set(selfKeywordsFor(c, 'push'));
      return selfKeywordsFor(c, 'ingest').every((w) => push.has(w) || CYR.test(w));
    }),
  );
  ok(
    '「казахстан」在采集侧能命中 kz（推送侧不需要，但采集侧必须能）',
    isCountryRelevant({ title: 'Казахстан увеличил экспорт', summary: '', countryCode: 'kz', sourceCountry: 'kz' }) === true,
  );

  // 采集侧专用的外国词真的被用上了
  ok(
    '俄语词干在采集侧生效：турци ⇒ 土耳其',
    isCountryRelevant({ title: 'Турция увеличила поставки', summary: '', countryCode: 'az', sourceCountry: 'azertag' }) === false,
  );
  ok(
    '会撞词的拉丁短词只在采集侧（推送侧不含 usa / eu ）',
    FOREIGN_KEYWORDS_INGEST_ONLY.includes('usa') &&
      FOREIGN_KEYWORDS_INGEST_ONLY.includes('eu ') &&
      !FOREIGN_KEYWORDS.includes('usa') &&
      !FOREIGN_KEYWORDS.includes('eu '),
    'usa 会命中 usage/USAID，放进推送侧会误杀',
  );
  ok(
    '` nato` 的汉字形态「北约」在共享表里（` nato` 在中文里匹配不上）',
    FOREIGN_KEYWORDS.includes('北约'),
    '推送侧真正生效的是「北约」这一条',
  );

  // 区域词的两侧差别是有意的
  ok(
    '「南高加索」只在采集侧（推送侧的放行口径被用户要求收窄过）',
    !REGION_KEYWORDS.includes('south caucasus') && REGION_KEYWORDS_INGEST_ONLY.includes('south caucasus'),
  );
  ok('区域词的采集侧专用表含 BRI（前导空格防 brief）', REGION_KEYWORDS_INGEST_ONLY.includes(' BRI'));

  // otherCountryKeywords 不许把本国自己算进去，也不许漏掉别国
  for (const code of CODES) {
    const others = otherCountryKeywords(code, 'push');
    ok(
      `${code} 的「别国」词里不含本国词`,
      !(SELF_KEYWORDS[code] || []).some((w) => others.includes(w)),
    );
    ok(`${code} 的「别国」词非空`, others.length > 0);
  }
}

// ============================================================
// 六、★ 只有一份实现（判据回归两处 = 本项目第五次事故的成因）
// ============================================================

section('六、★ 只有一份实现');

{
  const af = readFileSync(resolve(process.cwd(), 'src/lib/article-format.ts'), 'utf8');
  const fn = readFileSync(resolve(process.cwd(), 'src/app/api/fetch-news/route.ts'), 'utf8');
  const cr = readFileSync(resolve(process.cwd(), 'src/lib/country-relevance.ts'), 'utf8');

  ok('article-format.ts 里不再有 FOREIGN_KEYWORDS 声明', !/^\s*const FOREIGN_KEYWORDS/m.test(af), '词表又在这边建了一份');
  ok('article-format.ts 里不再有 SELF_KEYWORDS 声明', !/^\s*(export )?const SELF_KEYWORDS/m.test(af));
  ok('article-format.ts 从 country-relevance 取实现', /from '\.\/country-relevance'/.test(af));
  ok('article-format.ts 的 isCountryRelevant 是薄适配器（不传 sourceCountry ⇒ 推送侧口径）', /isCountryRelevantImpl\(\{ title, summary, countryCode \}\)/.test(af));

  ok('fetch-news 里不再有 COUNTRY_KEYWORDS 私有清单', !/^\s*const COUNTRY_KEYWORDS/m.test(fn));
  ok('fetch-news 里不再有 FOREIGN_COUNTRY_KEYWORDS 私有清单', !/^\s*const FOREIGN_COUNTRY_KEYWORDS/m.test(fn));
  ok('fetch-news 里不再有本地 isCountryRelevant 函数', !/^\s*function isCountryRelevant/m.test(fn));
  ok('fetch-news 从 country-relevance 取实现', /from '@\/lib\/country-relevance'/.test(fn));

  // 采集侧两处调用必须把 sourceCountry 传进去（漏传 = 悄悄换成推送侧兜底）
  const calls = fn.match(/isCountryRelevant\(\{[^}]*\}\)/g) || [];
  ok(`采集侧有 2 处调用（实际 ${calls.length} 处）`, calls.length === 2, calls.join(' ｜ '));
  ok(
    '采集侧每处调用都传了 sourceCountry（漏传会走成推送侧兜底，静默放宽）',
    calls.length === 2 && calls.every((c) => c.includes('sourceCountry')),
    calls.filter((c) => !c.includes('sourceCountry')).join(' ｜ '),
  );

  // 词表只能定义在 country-relevance 一处
  ok(
    'SELF_KEYWORDS 在 country-relevance 里定义',
    /export const SELF_KEYWORDS: Record<CountryCode, string\[\]>/.test(cr),
  );
  ok(
    '清单（FOREIGN_CONCEPT_CHECKLIST）与词表在同一文件（改词时清单就在眼前）',
    /export const FOREIGN_CONCEPT_CHECKLIST/.test(cr) && /export const FOREIGN_KEYWORDS: string\[\]/.test(cr),
  );
}

// ============================================================
// 七、结构不变量
// ============================================================

section('七、结构不变量');

{
  ok('共享外国词表里没有西里尔（西里尔属于采集侧专用）', !FOREIGN_KEYWORDS.some((k) => CYR.test(k)));
  ok('共享本国词表里没有西里尔', CODES.every((c) => !(SELF_KEYWORDS[c] || []).some((w) => CYR.test(w))));
  ok(
    '采集侧专用的西里尔表覆盖 5 国 + tm',
    ['kz', 'uz', 'kg', 'az', 'tj', 'tm'].every((c) => (SELF_KEYWORDS_SOURCE_SCRIPT[c] || []).length > 0),
  );
  ok('外国词全部小写（比对前统一小写，写大写会静默失效）', FOREIGN_KEYWORDS.every((k) => k === k.toLowerCase()));
  ok('本国词全部小写', CODES.every((c) => (SELF_KEYWORDS[c] || []).every((w) => w === w.toLowerCase())));
  ok('外国词表里没有重复条目', new Set(FOREIGN_KEYWORDS).size === FOREIGN_KEYWORDS.length);
  for (const code of CODES) {
    ok(`${code} 本国词无重复`, new Set(SELF_KEYWORDS[code]).size === SELF_KEYWORDS[code].length);
  }
}

console.log(`\n${'='.repeat(64)}`);
if (failures.length === 0) {
  console.log(`✅ 全部通过：${passed} 项断言`);
} else {
  console.log(`❌ ${failures.length} 项失败 / 共 ${passed + failures.length} 项：`);
  for (const f of failures) console.log(`   - ${f}`);
  process.exit(1);
}
