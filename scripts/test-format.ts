/**
 * 选稿资格（`pushExclusionReason`）回归。
 *
 * 用法：`pnpm tsx scripts/test-format.ts`（纯内存，不联网、不碰数据库）
 *
 * ## 为什么必须有这个脚本
 *
 * 这三条判据（分类 / 空壳文 / 国家相关性）决定**一篇稿子能不能进推送**。
 * 它们原本**内联写在 `POST /api/wechat/push` 里**，于是任何「想按生产口径跑一遍」
 * 的地方都得照着抄 —— 而 2026-09-22 实测就抄漏了一条，后果是结论整个反过来：
 *
 *   `GET /api/dedupe-check?llm=1` 用来自检 L2 模型判重稳不稳，
 *   但它的输入直接来自 `getArticleIdentities()`，**没套这三条判据**。
 *   结果 kz 的 12 个候选对**全是体育新闻**（亚洲运动会乒乓球/自行车/举重），
 *   而体育类在 push 里被 `EXCLUDED_CATEGORIES` 整类剔掉、永远进不了生产。
 *   三次调用判出 4 / 6 / 2 对「同一件事」→ 被读成「L2 判定不稳定」，
 *   实际上测的是模型对**模板化体育标题**的判断，与生产无关。
 *
 * 所以本文件用**双向语料**钉住这个共享函数：
 *   - 该留的（五国各一条真实投资标题）必须返回 `null`；
 *   - 该剔的（文体类 / 空壳文 / 讲他国）必须返回对应的原因。
 * 只测一边一定会调歪：放宽了会把文体新闻推给读者，收紧了会复发「每国不足 15 篇」。
 *
 * ⚠️ **别在调用方再写一份过滤条件**。要加判据就加在这里，
 * 这样 `push` 与体检接口不可能漂移 —— 这正是本文件存在的理由。
 */
import { pushExclusionReason, type PushExclusion } from '../src/lib/article-format';
import { countryList } from '../src/lib/data/countries';

// ----- 极简断言（与其他 test-*.ts 同款，便于一起读输出）-----

let passed = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed++;
  } else {
    failures.push(`${name}${detail ? ' —— ' + detail : ''}`);
    console.log(`  ✗ ${name}${detail ? ' —— ' + detail : ''}`);
  }
}

function section(title: string) {
  console.log(`\n=== ${title} ===`);
}

type Case = {
  cc: string;
  category: string;
  title: string;
  summary?: string;
  expect: PushExclusion | null;
  why: string;
};

// ============================================================
// 一、必须保留：五国各一条真实标题（收紧判据会让它变红）
// ============================================================

section('必须保留（判据收紧了这里会红）');

const KEEP: Case[] = [
  {
    cc: 'kz', category: 'economy',
    title: '哈萨克斯坦与中方签署铀矿开发协议，总投资12亿美元',
    summary: '双方还就铁路通道建设交换意见。',
    expect: null, why: '典型投资新闻（签约 + 金额）',
  },
  {
    cc: 'uz', category: 'energy',
    title: '乌兹别克斯坦卡拉卡尔帕克斯坦将获3000亿苏姆优惠贷款，利率降至12%',
    expect: null, why: '地方城市名（卡拉卡尔帕克斯坦）不能误杀',
  },
  {
    cc: 'kg', category: 'infrastructure',
    title: '吉尔吉斯斯坦交通部：比什凯克至库恩-图路段铺设第二层沥青',
    expect: null, why: '基建新闻',
  },
  {
    cc: 'tj', category: 'economy',
    title: '塔吉克斯坦与中国拟扩大工业与投资合作',
    expect: null, why: '对外合作',
  },
  {
    cc: 'az', category: 'oil_gas',
    title: '阿塞拜疆戈布斯坦太阳能电站投产',
    expect: null, why: '能源项目投产',
  },
  {
    // 「什么都没提到」要放行 —— 按入库国别归属（isCountryRelevant 的设计）。
    // 这条是**故意**的宽松：收紧它会大面积误杀行业/企业新闻。
    cc: 'kz', category: 'economy',
    title: '央行上调基准利率至14%',
    expect: null, why: '无国名 → 按入库国别归属放行（宽松是有意的）',
  },
];

for (const c of KEEP) {
  const got = pushExclusionReason({ title: c.title, summary: c.summary, category: c.category }, c.cc);
  ok(`保留 ${c.cc}：${c.title.slice(0, 26)}…`, got === c.expect, `得到 ${JSON.stringify(got)}（${c.why}）`);
}

// ============================================================
// 二、必须剔除：三类原因各测到位
// ============================================================

section('必须剔除（判据放宽了这里会红）');

const DROP: Case[] = [
  // ★ 这一组就是那次误判的直接来源：体育类**必须**被剔，否则体检会拿它们去测模型
  {
    cc: 'kz', category: 'sports',
    title: '哈萨克斯坦运动员在2026年亚洲运动会中夺冠',
    expect: 'category', why: '★ 2026-09-22 那次误判的输入就是这类稿子',
  },
  {
    cc: 'kz', category: 'sports',
    title: '哈萨克斯坦乒乓球国家队在2026年亚洲运动会中夺得铜牌',
    expect: 'category', why: '乒乓球队',
  },
  {
    cc: 'kz', category: 'culture',
    title: '阿拉木图举办国际爵士音乐节',
    expect: 'category', why: '演艺娱乐类，用户要求「全部取消」',
  },
  {
    cc: 'kz', category: 'economy',
    title: '哈萨克斯坦货币市场周度回顾：原文正文缺失，马纳特汇率数据无法提取',
    expect: 'missing_source', why: '空壳文（标题自曝无正文）',
  },
  {
    cc: 'kz', category: 'economy',
    title: '阿塞拜疆PAŞA银行向纳希切万25兆瓦太阳能电站提供贷款',
    expect: 'country', why: '讲到别国（az 的稿子混进了 kz 的流）',
  },
  {
    cc: 'kz', category: 'sports',
    title: '阿塞拜疆运动员在亚洲运动会中夺冠',
    expect: 'category', why: '同时命中两条 → 分类优先（顺序决定日志里的原因）',
  },
];

for (const c of DROP) {
  const got = pushExclusionReason({ title: c.title, summary: c.summary, category: c.category }, c.cc);
  ok(`剔除 ${c.cc}：${c.title.slice(0, 26)}…`, got === c.expect, `得到 ${JSON.stringify(got)}，期望 ${JSON.stringify(c.expect)}（${c.why}）`);
}

// ============================================================
// 三、两条机制必须都在（只有一条会漏掉一类稿子）
// ============================================================

section('intl 的两道防线：规则挡不住它，只能靠国家列表挡');

{
  // `intl`（The Times of Central Asia）不是 `countryList` 里的国家，
  // 所以 **push 遍历不到它** —— 它的文章入库但永不被推送。
  //
  // ⚠️ 而这个共享函数**不会**挡住 intl（它只判断内容，不知道谁会被推送），
  // 所以「不推送 intl」必须由调用方（体检接口用 `PUSHED_COUNTRIES`）单独处理。
  // 两条机制都要有：只看规则会以为 intl 会被推送，只看国家列表会漏掉内容判据。
  const intl = pushExclusionReason(
    { title: 'The Times of Central Asia: 区域投资动态', summary: '', category: 'economy' },
    'intl',
  );
  ok('共享规则**不**拦截 intl（所以调用方必须自己按国家列表收窄）', intl === null, JSON.stringify(intl));

  // 注意标成 `string[]`：`countryList` 的 code 是 `CountryCode` 字面量联合，
  // 直接用 `codes.includes('intl')` 会因为 'intl' 不在联合里而编译失败。
  const codes: string[] = countryList.map((c) => c.code);
  ok('push 的国家列表里没有 intl', !codes.includes('intl'), codes.join(','));
  ok('push 的国家列表覆盖五个目标国', ['kz', 'uz', 'kg', 'az', 'tj'].every((c) => codes.includes(c)), codes.join(','));
}

{
  // 缺字段不能崩（真实数据里 category / summary 都可能是 null）
  ok('category 缺失时不崩且放行', pushExclusionReason({ title: '哈萨克斯坦铁路项目开工', category: null }, 'kz') === null);
  ok('summary 缺失时不崩', pushExclusionReason({ title: '哈萨克斯坦铁路项目开工' }, 'kz') === null);
  ok('title 为空时按国家相关性处理，不崩', typeof pushExclusionReason({ title: '', category: 'economy' }, 'kz') !== 'undefined');
}

// ----- 汇总 -----

console.log(`\n${'='.repeat(60)}`);
if (failures.length === 0) {
  console.log(`✅ 全部通过：${passed} 项断言`);
  process.exit(0);
} else {
  console.log(`❌ ${failures.length} 项失败 / 共 ${passed + failures.length} 项：`);
  for (const f of failures) console.log(`   - ${f}`);
  process.exit(1);
}
