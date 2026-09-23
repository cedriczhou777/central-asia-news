/**
 * 闸 2 之二（库内中译标题去重）的**上线前回放体检**（只读，不改任何数据）。
 *
 * 用法：
 *   pnpm analyze:title-gate                # 默认最近 7 天 × 5 国
 *   pnpm analyze:title-gate 14             # 最近 14 天
 *   SITE_BASE=http://localhost:3000 pnpm analyze:title-gate 7
 *
 * ## 存在的理由
 *
 * 闸 2 之二是**入库前**的闸：被它拦下的行库里没有、事后不可追。
 * 所以上线前必须先在真实库上回放一遍，把每一个命中摆出来人工过目 ——
 * 「已知该合的都在列、没有任何意外命中」才允许部署。
 * 这与 `same_title` 上闸 3 之前的全量干跑（80704cb）是同一道工序。
 *
 * ## 回放规则（逐字对齐生产实现，见 fetch-news「闸 2 之二」段）
 *
 * 1. 按国分组（跨国出现同一件事是预期行为，不比）；
 * 2. 组内按 id 升序回放 —— id 连续段 ≈ 一轮 insertArticles 的入库顺序；
 * 3. 每行与「已保留标题」逐个比 `isSameTitleText`（≥0.95 + 反向极性否决，
 *    与闸 3 同一条代码）；命中 → 记为拦截，且该行标题**不**加入已保留集合
 *    （生产上这行不会入库，后续行不该跟它比）；
 * 4. 占位标题（'无标题'）跳过。
 *
 * ## 怎么读
 *
 * - `拦截` 列出的每一对都要**人工过目**：确认是同一件事（拦截正确），
 *   还是两条不同新闻标题撞车（误杀 = 上线后静默丢稿，必须先调判据）。
 * - 已知应被拦下的库内真重复（2026-09-23 量出来的三对）：
 *   kz 3741|3915（无人驾驶出租车）、kz 3925|3909（托卡耶夫会见秘书长）、
 *   az 4164|4134（伊朗航空暂停航班）—— 它们的中译标题相似度全部 = 1.000。
 * - `> 3 天窗口外` 的命中：生产窗口是 `DB_DEDUP_WINDOW_DAYS = 3` 天（created_at），
 *   回放窗口更长，所以这些对**在生产里不会触发**，列出仅供参照。
 *
 * ## 基线（2026-09-24 上线前实测，7 天 × 5 国）
 *
 *   （见运行输出；把每次跑的结果记回这里，形成前后对比）
 */
import { isSameTitleText } from '../src/lib/same-event';
import { similarity } from '../src/lib/utils';

const BASE = process.env.SITE_BASE || 'https://central-asia-news-307705-12-1480606601.sh.run.tcloudbase.com';
const COUNTRIES = ['kz', 'uz', 'kg', 'az', 'tj'];
const DAYS = Number(process.argv[2] || 7);
/** 生产闸 2 的窗口天数。回放窗口更长，超出的命中标注出来（生产不触发）。 */
const PROD_WINDOW_DAYS = 3;

interface Row {
  id: number;
  title: string;
  publishedAt: string;
}

async function load(country: string, date: string): Promise<Row[]> {
  const res = await fetch(`${BASE}/api/articles?country=${country}&date=${date}&limit=300`);
  if (!res.ok) return [];
  const j = (await res.json()) as { articles: Row[] };
  return (j.articles || []).map((a) => ({ ...a }));
}

function beijingDates(n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000 + 8 * 60 * 60 * 1000);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

async function main() {
  const dates = beijingDates(DAYS);
  const perCountry = new Map<string, Row[]>();
  let total = 0;
  for (const c of COUNTRIES) {
    const rows: Row[] = [];
    for (const d of dates) rows.push(...(await load(c, d)));
    // 同一行可能被相邻两天的 date 窗口各返回一次（按 publishedAt 过滤时），按 id 去重
    const byId = new Map<number, Row>();
    for (const r of rows) if (!byId.has(r.id)) byId.set(r.id, r);
    const list = [...byId.values()].sort((a, b) => a.id - b.id);
    perCountry.set(c, list);
    total += list.length;
  }
  if (total === 0) {
    console.error('没取到任何行 —— 检查 SITE_BASE 与日期窗口');
    process.exit(1);
  }
  console.log(`回放窗口 ${dates[dates.length - 1]} ~ ${dates[0]}（北京日期）｜${total} 篇`);
  console.log(`判据 isSameTitleText（≥0.95 + 反向极性否决，与生产同一份代码）｜生产窗口 ${PROD_WINDOW_DAYS} 天\n`);

  let totalDrops = 0;
  let outsideWindow = 0;
  for (const c of COUNTRIES) {
    const rows = perCountry.get(c)!;
    const kept: Row[] = [];
    const drops: Array<{ kept: Row; dropped: Row; sim: number; dayGap: number }> = [];
    for (const r of rows) {
      const t = r.title || '';
      if (!t || t === '无标题') {
        kept.push(r); // 生产不拦占位标题，只是不给它指纹；回放里同样放行
        continue;
      }
      let hit: Row | null = null;
      for (const k of kept) {
        if (isSameTitleText(t, k.title)) {
          hit = k;
          break;
        }
      }
      if (hit) {
        const dayGap = Math.abs(
          (new Date(r.publishedAt).getTime() - new Date(hit.publishedAt).getTime()) / 86400000,
        );
        drops.push({ kept: hit, dropped: r, sim: similarity(t, hit.title), dayGap });
        continue; // 命中 → 不加入 kept（生产上这行不入库）
      }
      kept.push(r);
    }
    totalDrops += drops.length;
    outsideWindow += drops.filter((d) => d.dayGap > PROD_WINDOW_DAYS).length;
    console.log(`[${c}] ${rows.length} 行 → 拦截 ${drops.length} 篇`);
    for (const d of drops) {
      const mark = d.dayGap > PROD_WINDOW_DAYS ? `（> ${PROD_WINDOW_DAYS} 天窗口外，生产不触发）` : '';
      console.log(`  拦 ${d.dropped.id}「${d.dropped.title}」`);
      console.log(`    ← 留 ${d.kept.id}「${d.kept.title}」 sim=${d.sim.toFixed(3)} 间隔 ${d.dayGap.toFixed(1)} 天${mark}`);
    }
  }

  console.log(`\n合计：${total} 行 → 拦截 ${totalDrops} 篇（${((totalDrops / total) * 100).toFixed(2)}%）`);
  console.log(`其中生产窗口（${PROD_WINDOW_DAYS} 天）外的：${outsideWindow} 篇`);
  console.log('\n⚠️ 人工过目清单：上面每一对都要确认「确实是同一件事」。');
  console.log('   任何一条拿不准 = 潜在误杀 = 上线后静默丢稿 —— 先改判据再上线。');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
