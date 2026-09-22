/**
 * 闸门的**语言偏置**体检：`isInvestmentTopic` 的通过率是不是由原文语言决定的？
 *
 * ## 为什么需要这个脚本
 *
 * `isInvestmentTopic`（`src/lib/investment-score.ts`）是**入库闸门** —— 不通过的稿子
 * 直接不收。它跑在**原文**上（翻译刻意排在闸门之后，为了省翻译钱），所以词表覆盖
 * 哪些语言，就直接决定了「哪些语言的新闻有机会进模型」。
 *
 * 症状是「某国今天只有一两篇」。`GET /api/fetch-news` 的
 * `funnelByCountry.droppedTopic` 只能告诉你**掉了多少**，不能告诉你掉的是
 * **垃圾**还是**好稿子** —— 这是本脚本要补的观测点。
 *
 * ## 怎么读结果
 *
 * - 看「按实测文字系统汇总」：**拉丁 vs 西里尔**的通过率差多少。
 *   2026-09-22 补词表**前**是 82.6% vs 4.1%（差 20 倍）；补词表**后**同口径复测是
 *   100% vs 44.9%（Newtimes.kz 41% / Inbusiness.kz 52% / Total.kz 43%）——
 *   **西里尔侧的绝对通过率涨了约 11 倍**，差距从 20 倍收到 2.2 倍。
 *   ⚠️ 但**别把「比值仍不是 100%」读成「还有偏置」**：拉丁侧只有一个源
 *   （The Astana Times，面向投资者的编辑定位，篇篇都算），
 *   俄文源里本来就混着庭审/治安/文化稿，这部分差距是**真实内容差异**。
 *   判有没有误杀要看下面的 `--dump` 抽样，不看这个比值。
 * - 逐源看通过率与该源的**实测文字分布**。⚠️ `RSS_SOURCES` 里的 `language`
 *   是**声明值、会标错**，判断语言看实测列。
 * - `AZERTAC`（`/en/rss`）与 `AZERTAC (ru)`（`/ru/rss`）是**对照实验**：
 *   同一家通讯社、同一批新闻、只差语言，通过率之差就是净语言效应。
 *
 * ## 局限（别把结论说过头）
 *
 * - **本机可达性 ≠ 容器可达性。** 已实测：`Inbusiness.kz`、`Economist.kg`
 *   容器里 `Request timed out`；`AKIpress`、`Tazabek` 的 XML 畸形、
 *   rss-parser 直接放弃；`AZERTAC` 从本机返回 400。这些源在这里的读数不代表生产。
 *   两边一起看。
 * - 测的是**闸门**，不含 `isJunkTitle` / `isCountryRelevant` 两道前置闸门，
 *   也不含翻译、评分、判重。所以通过率会**高于**生产漏斗里
 *   `afterDate → candidates` 的比值，这是预期的。
 * - 本机连续拉 25 个 feed 会被对端限流（`read ECONNRESET`），
 *   偶发缺源不是代码问题，重跑即可。
 *
 * 只读：拉 feed、跑纯函数、打印。不入库、不翻译、不调用任何模型。
 *
 * 用法：
 *   pnpm analyze:source-language                # 全部源
 *   pnpm analyze:source-language kz             # 只测某国
 *   pnpm analyze:source-language kz --dump=12   # 每源列 12 条标题（含**被挡**的）
 *   pnpm analyze:source-language --words        # 逐词体检（哪个词在误命中 / 从没生效）
 *
 * `--dump` 是给「该不该放宽闸门」用的：只看通过率数字无法判断被挡掉的是垃圾
 * 还是好稿子，必须逐条看标题。`✓` 是通过、`✗` 是被挡。
 *
 * `--words` 是给「词表本身写得对不对」用的：一张几百词的列表，光看总通过率
 * 看不出哪个词在误命中（例如 `цены` 会命中戏剧稿的 `сцены`）。逐词统计
 * 「在真实 feed 上命中多少条 + 命中的都是什么标题」，才能在上线前把问题抓出来。
 */
import Parser from 'rss-parser';
import { RSS_SOURCES } from '../src/lib/data/rss-sources';
import { isInvestmentTopic, matchedInvestmentKeywords, gateKeywordGroups } from '../src/lib/investment-score';

/** 文字系统。阿塞拜疆语用拉丁字母但有 ə ğ ş ı ö ü ç 这类独有字母，单列一档以便与英文分开。 */
type Script = 'cyrillic' | 'az' | 'cjk' | 'latin' | 'other';

/**
 * 判定一段文本的主要文字系统。
 *
 * ⚠️ 这不是语言识别，只是**够用的文字系统归类**：目标是回答「这段文字里有没有
 * 英文单词可给闸门匹配」。所以规则刻意简单（按字符计数比大小），不引语言库 ——
 * 引了反而会因为「俄文里夹英文品牌名」这类混合文本判成英文，而**混合文本恰恰是
 * 能过闸门的那部分**，归错类会让结论完全反掉。
 */
export function detectScript(s: string): Script {
  const cyr = (s.match(/[\u0400-\u04FF]/g) || []).length;
  const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  const lat = (s.match(/[A-Za-z]/g) || []).length;
  const az = (s.match(/[əğıöüşçƏĞİÖÜŞÇ]/g) || []).length;
  if (cyr > 0 && cyr >= lat) return 'cyrillic';
  if (az >= 3) return 'az';
  if (cjk > lat) return 'cjk';
  if (lat > 0) return 'latin';
  return 'other';
}

interface Item {
  source: string;
  declared: string;
  country: string;
  title: string;
  /** 与生产**逐字一致**的输入：`${title} ${contentSnippet || content || ''}` */
  text: string;
  script: Script;
  pass: boolean;
}

interface Row {
  name: string;
  declared: string;
  country: string;
  total: number;
  pass: number;
  byScript: Record<string, [number, number]>;
  error: string;
  items: Item[];
}

async function probe(source: (typeof RSS_SOURCES)[number], wantItems: boolean): Promise<Row> {
  const row: Row = {
    name: source.name, declared: source.language, country: source.country,
    total: 0, pass: 0, byScript: {}, error: '', items: [],
  };
  try {
    const feed = await new Parser({ timeout: 30000 }).parseURL(source.url);
    for (const item of feed.items || []) {
      const title = item.title || '';
      const desc = (item as { contentSnippet?: string; content?: string }).contentSnippet
        || (item as { content?: string }).content || '';
      const text = `${title} ${desc}`;
      const sc = detectScript(text);
      const ok = isInvestmentTopic(text);
      row.total++;
      row.byScript[sc] = row.byScript[sc] || [0, 0];
      row.byScript[sc][0]++;
      if (ok) { row.pass++; row.byScript[sc][1]++; }
      if (wantItems) {
        row.items.push({ source: source.name, declared: source.language, country: source.country, title, text, script: sc, pass: ok });
      }
    }
  } catch (e) {
    row.error = String((e as Error)?.message || e).slice(0, 46);
  }
  return row;
}

const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(0)}%`.padStart(4) : '   –');

/** 逐词体检：哪些词在真实 feed 上生效、命中的是什么、哪些词从没生效。 */
function wordAudit(items: Item[]) {
  const corpus = items.map((i) => i.text.toLowerCase());
  console.log(`\n逐词体检（语料 ${corpus.length} 条，来自 ${new Set(items.map((i) => i.source)).size} 个源）`);
  console.log('命中=含该词的条目数；样本=命中该词的第一条标题。\n');

  for (const g of gateKeywordGroups()) {
    const stats = g.words
      .map((w) => {
        const lower = w.toLowerCase();
        let hits = 0;
        let sample = '';
        let junkish = 0;
        for (let i = 0; i < corpus.length; i++) {
          if (corpus[i].includes(lower)) {
            hits++;
            if (!sample) sample = items[i].title.slice(0, 52);
            // 「该词单独命中、但整条被别的原因判过」无法区分，这里只统计条目是否通过
            if (!items[i].pass) junkish++;
          }
        }
        return { w, hits, sample, mine: junkish };
      })
      .sort((a, b) => b.hits - a.hits);

    const dead = stats.filter((s) => s.hits === 0);
    const live = stats.filter((s) => s.hits > 0);
    console.log(`═══ ${g.label}：${g.words.length} 词，${live.length} 个在本次语料上命中，${dead.length} 个 0 命中 ═══`);
    for (const s of live) console.log(`  ${String(s.hits).padStart(4)}  ${s.w.padEnd(20)} ${s.sample}`);
    if (dead.length) console.log(`  —— 0 命中（语料没有这类稿子，或该词有错别字/永不匹配）——\n     ${dead.map((d) => d.w).join('  ')}`);
    console.log();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const wordsMode = args.includes('--words');
  const dumpArg = args.find((a) => a.startsWith('--dump'));
  const dumpN = dumpArg ? Number(dumpArg.split('=')[1] || 3) : 3;
  const only = args.find((a) => !a.startsWith('--'));

  const sources = RSS_SOURCES.filter((s) => !only || s.country === only);
  // ⚠️ 收集条目必须**同时**看 `--dump`，不能只看 `--words`：
  // 曾经写成 `probe(s, wordsMode)`，于是 `--dump=N` 打出来的是「通过率 52%」下面**一条样本都没有** ——
  // 看着像「这个源没稿子」，实际是根本没收集。这两个开关都会用到 `items`。
  const wantItems = wordsMode || !!dumpArg;
  const rows: Row[] = [];
  for (const s of sources) rows.push(await probe(s, wantItems));

  if (wordsMode) {
    wordAudit(rows.flatMap((r) => r.items));
    return;
  }

  console.log('源                        声明语言  条数  过闸门  实测文字分布（条数/其中过闸门）');
  console.log('-'.repeat(104));
  for (const r of rows) {
    const dist = Object.entries(r.byScript)
      .sort((a, b) => b[1][0] - a[1][0])
      .map(([k, v]) => `${k}:${v[0]}/${v[1]}`)
      .join('  ');
    console.log(
      `${r.name.padEnd(24)} ${r.declared.padEnd(8)} ${String(r.total).padStart(4)}  ${pct(r.pass, r.total)}  ${dist}${r.error ? `   ⚠️ ${r.error}` : ''}`,
    );
  }

  // 这一行才是结论
  const agg: Record<string, [number, number]> = {};
  for (const r of rows) for (const [k, v] of Object.entries(r.byScript)) {
    agg[k] = agg[k] || [0, 0];
    agg[k][0] += v[0]; agg[k][1] += v[1];
  }
  console.log('-'.repeat(104));
  console.log('按**实测文字系统**汇总：');
  for (const [k, [t, ok]] of Object.entries(agg).sort((a, b) => b[1][0] - a[1][0])) {
    const rate = t ? (ok / t) * 100 : 0;
    console.log(`  ${k.padEnd(9)} ${String(t).padStart(5)} 条   过闸门 ${String(ok).padStart(4)} 条   ${rate.toFixed(1)}%`);
  }

  const cyr = agg['cyrillic'];
  const lat = agg['latin'];
  if (cyr && lat && lat[1] > 0) {
    const ratio = (cyr[1] / cyr[0]) / (lat[1] / lat[0]);
    console.log(`\n⇒ 西里尔条目通过率是拉丁条目的 ${(ratio * 100).toFixed(0)}%。`);
    // 基线写死在输出里，因为「45% 是高还是低」离开这个基线就没法判断 ——
    // 单看一个 45% 很容易被读成「还有一半被误杀」，而修之前的同一个数字是 10%。
    console.log('   基线：**修词表之前**这个比值是 10%（西里尔 4.1% vs 拉丁 82.6%，2026-09-22 实测）。');
    console.log(
      '   ⚠️ **别把「比值仍 < 100%」直接读成「还有语言偏置」。** 拉丁那一侧只有一个源' +
      '（The Astana Times），\n' +
      '   它是面向投资者的编辑定位，本来就是「篇篇都算投资新闻」；俄文源里本来就混着大量\n' +
      '   庭审 / 治安 / 文化稿。**这部分差距是真实的内容差异，不是误杀。**\n' +
      '   判有没有误杀只能看下面的 `--dump` 抽样：被挡的若确实是文化/体育/治安，就是对的。\n' +
      '   要收紧闸门只在「被挡的里面出现了投资相关稿子」时才成立。',
    );
  }

  console.log('\n各源样本（✓ 通过 / ✗ 被挡；`←` 后面是命中的关键词）');
  for (const r of rows) {
    if (!r.total) continue;
    console.log(`\n  ${r.name}  [声明 ${r.declared}]  通过率 ${pct(r.pass, r.total)}${r.error ? `   ⚠️ ${r.error}` : ''}`);
    // 抽样策略：先给通过的前若干条，再给被挡的若干条 ——
    // 只列被挡的会看不出闸门放行了什么，只列通过的同理。
    const shown: string[] = [];
    const passItems = r.items.filter((i) => i.pass).slice(0, Math.ceil(dumpN / 2));
    const failItems = r.items.filter((i) => !i.pass).slice(0, Math.floor(dumpN / 2));
    for (const i of [...passItems, ...failItems]) {
      const hits = i.pass ? ` ← ${matchedInvestmentKeywords(i.text).slice(0, 2).join(',')}` : '';
      shown.push(`    ${i.pass ? '✓' : '✗'} [${i.script}] ${i.title.slice(0, 44)}${hits}`);
    }
    for (const line of shown) console.log(line);
  }
}

// ⚠️ 必须显式 `process.exit(0)`：所有工作做完后事件循环里还留着 rss-parser / undici 的
// keep-alive socket，**进程不会自己退出**。实测症状是「输出全部打印完了，命令却一直挂着」
// （挂够 47 分钟才被人发现），看起来像脚本卡死在抓取上，实际早就干完了。
main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });
