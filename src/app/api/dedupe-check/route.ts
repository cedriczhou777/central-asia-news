/**
 * 去重体检 / 存量重复清理。
 *
 * ## 两个入口，一个是只读的
 *
 * - `GET  /api/dedupe-check?days=7[&llm=1][&mode=pair|group][&judge=think|nothink][&debug=1]`
 *   只读体检。把时间窗内的文章按国家分组跑一遍「同一件事」判据，
 *   报告**哪些会被判为重复、原因是什么**，不写任何数据。
 *   `llm=1` 时会真的调用一次模型判定（每国 1 次），用来验证 L2 通道通不通；
 *   此时会额外返回模型**逐对**的判定结果（`pairs`），那是判得准不准的直接证据。
 *   `mode=group` 是已停用形态的对照实验入口，生产链路固定走 `pair`。
 *
 * - `POST /api/dedupe-check  { "apply": false, "days": 30 }`
 *   存量重复行清理。**默认 dry-run**，只有显式传 `apply: true` 才会真删。
 *   保留每组里 id 最小的那一行，删掉其余。
 *
 * ## 为什么需要它
 *
 * 2026-09-21 用户在公众号草稿预览里发现两条阿斯塔纳桥梁新闻讲的是同一件事。
 * 排查后发现线上库里有大量**重复行**：同一 source_url 被处理并入库了两次甚至更多次
 * （根因见 `fetch-news/route.ts` 第三步的注释）。修去重逻辑只能防住**以后**，
 * 存量重复行还在库里 —— 只要推送窗口覆盖到它们，草稿里就还是会出现两条一样的新闻。
 * 所以必须有一次性的清理动作，而且要能先看清楚会删什么。
 *
 * ## 安全边界
 *
 * - 只删「归一化链接相同」或「原文标题指纹相同」的重复行 —— 这两条判据是
 *   **确定性**的（逐字比对），不做任何语义推断，误删风险为零。
 * - 刻意**不**用「同一件事」的模型判据来删存量：那是概率性判据，
 *   用在只读体检上给人看没问题，用来自动删数据不合适。
 * - 保留 id 最小（最早入库）的那一条。若同一组最早的那条恰好是被排序靠后的，
 *   也不影响：组内内容本就是同一条新闻的不同译法。
 */
import { NextRequest, NextResponse } from 'next/server';
import { getArticleIdentities, deleteArticlesByIds } from '@/lib/db-articles';
import { canonicalUrl, originalTitleKey, similarity } from '@/lib/utils';
import { dedupeStoriesDeterministic } from '@/lib/same-event';

/** 时间窗上限，防止有人传个 3650 天把整库拉出来。 */
const MAX_DAYS = 90;
const DEFAULT_DAYS = 30;

function windowStart(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

interface Row {
  id: number;
  title: string;
  summary?: string | null;
  content?: string | null;
  country_code: string;
  source_url: string | null;
  original_title: string | null;
  /** 文章发布日期。窗口过滤用的就是它。 */
  published_at?: string | null;
  /** **入库时间**。与 `published_at` 不是一回事 —— 见下面 `dropInfo` 的说明。 */
  created_at?: string | null;
}

/**
 * 一行的时间画像。带上它，是为了让体检结果能自己回答
 * 「这堆重复是**旧代码留下的存量**，还是**现在还在产生**」。
 *
 * 为什么光看 `published_at` 分不出来：窗口过滤的是**发布日期**，
 * 而重复的成因恰恰可能是「发布日期很早、今天才被抓到」——
 * 这类行的 `published_at` 和别的老行混在一起，看不出它是新插进来的。
 * `createdAt` 才是「它什么时候进的库」。
 *
 * ⚠️ 判读时**必须拿 `createdAt` 和「最近一次修复的上线时间」比**，
 * 不能只看「是不是今天」—— 2026-09-22 第一版就是按「有今天入库的重复行 = 仍在漏」
 * 判的，看到 0.62 天前就下了「仍在漏」的结论，而那次修复其实在 0.48 天前才上线，
 * 实际全是存量。差几小时就会判反，所以要把上线时间算进来：
 *
 *   - 重复行的 `createdAt` **全都早于**最近一次相关修复的上线时间 → 存量，清掉即可
 *     （`POST {apply:true}` 就是干这个的，默认 dry-run）。
 *   - 出现**晚于**上线时间的 `createdAt` → 那条修复没解决问题，先修闸门再清存量，
 *     否则清了还会再长。
 */
function stamp(r: Row) {
  return {
    id: r.id,
    createdAt: r.created_at ?? null,
    publishedAt: r.published_at ?? null,
  };
}

/**
 * 确定性的存量重复分组：**只用一条判据** —— 归一化链接或原文指纹相同。
 *
 * 特意不复用 `dedupeStoriesDeterministic`：那个函数除了身份判据还带
 * 「文本逐字相同」的兜底，而清理存量时应当只按**可断言的强身份**删，
 * 弱判据留给只读体检去呈现。
 */
function groupIdentical(rows: Row[]): {
  groups: Array<{
    keepId: number;
    dropIds: number[];
    key: string;
    reason: 'same_url' | 'same_original';
    title: string;
    /** 保留行的时间画像（见 {@link stamp}） */
    keepInfo: ReturnType<typeof stamp>;
    /** 待删行的时间画像，与 `dropIds` 同序 */
    dropInfo: Array<ReturnType<typeof stamp>>;
  }>;
} {
  const canonicalOf = (r: Row) => canonicalUrl(r.source_url || '');

  // 两级索引：先按链接归组，再在结果上按原文指纹并组
  const byUrl = new Map<string, Row[]>();
  const orphans: Row[] = [];
  for (const r of rows) {
    const cu = canonicalOf(r);
    if (!cu) {
      orphans.push(r);
      continue;
    }
    const g = byUrl.get(cu);
    if (g) g.push(r);
    else byUrl.set(cu, [r]);
  }

  const groups: Array<{
    keepId: number;
    dropIds: number[];
    key: string;
    reason: 'same_url' | 'same_original';
    title: string;
    keepInfo: ReturnType<typeof stamp>;
    dropInfo: Array<ReturnType<typeof stamp>>;
  }> = [];
  const remaining: Row[] = [];

  for (const [cu, list] of byUrl) {
    const sorted = [...list].sort((a, b) => a.id - b.id);
    if (sorted.length > 1) {
      groups.push({
        keepId: sorted[0].id,
        dropIds: sorted.slice(1).map((r) => r.id),
        key: cu,
        reason: 'same_url',
        title: sorted[0].title,
        keepInfo: stamp(sorted[0]),
        dropInfo: sorted.slice(1).map(stamp),
      });
    }
    remaining.push(sorted[0]);
  }
  remaining.push(...orphans);

  // 第二级：不同链接、同一篇原文（同稿多链）
  //
  // ⚠️ key 必须带国家，与 `same-event.ts` 的 `identityKeys`（`orig:国家:指纹`）保持一致。
  // 早期这里只用了指纹，会**跨国家**合并：一条通讯社通稿同时进了 kz 和 uz 两个国家的流、
  // 原文标题相同 → 被判成同一组 → 删掉其中一个国家那条，等于**削掉那个国家的篇数**。
  // 判重口径分裂是这套机制反复踩过的坑，存量清理必须和入库/选稿用同一把尺子。
  const byOrig = new Map<string, Row[]>();
  for (const r of remaining) {
    const k = originalTitleKey(r.original_title || '');
    if (!k) continue;
    const ck = `${r.country_code || 'intl'}:${k}`;
    const g = byOrig.get(ck);
    if (g) g.push(r);
    else byOrig.set(ck, [r]);
  }
  for (const [ck, list] of byOrig) {
    if (list.length < 2) continue;
    const sorted = [...list].sort((a, b) => a.id - b.id);
    groups.push({
      keepId: sorted[0].id,
      dropIds: sorted.slice(1).map((r) => r.id),
      key: `orig:${ck.slice(0, 60)}`,
      reason: 'same_original',
      title: sorted[0].title,
      keepInfo: stamp(sorted[0]),
      dropInfo: sorted.slice(1).map(stamp),
    });
  }

  return { groups };
}

function parseDays(raw: string | null | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_DAYS;
  return Math.min(Math.floor(n), MAX_DAYS);
}

/** 只读体检：报告「会被判为重复」的内容，不写数据。 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const days = parseDays(searchParams.get('days'));
  const withLlm = searchParams.get('llm') === '1';
  const sampleLimit = Math.min(Number(searchParams.get('sample')) || 15, 50);

  const since = windowStart(days);
  let rows: Row[];
  try {
    rows = (await getArticleIdentities(since)) as Row[];
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: `读取文章失败：${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }

  // 确定性判据（与入库/选稿用的是同一套）
  const byCountry = new Map<string, Row[]>();
  for (const r of rows) {
    const k = r.country_code || 'intl';
    const g = byCountry.get(k);
    if (g) g.push(r);
    else byCountry.set(k, [r]);
  }

  const perCountry: Array<{
    country: string;
    total: number;
    kept: number;
    dropped: number;
    byReason: Record<string, number>;
    samples: Array<{ reason: string; dropped: string; kept: string }>;
  }> = [];

  let droppedTotal = 0;
  const allByReason: Record<string, number> = {};

  for (const [cc, list] of [...byCountry.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const { kept, drops } = dedupeStoriesDeterministic(list as never[]);
    const byReason: Record<string, number> = {};
    for (const d of drops) {
      byReason[d.reason] = (byReason[d.reason] || 0) + 1;
      allByReason[d.reason] = (allByReason[d.reason] || 0) + 1;
    }
    droppedTotal += drops.length;
    perCountry.push({
      country: cc,
      total: list.length,
      kept: kept.length,
      dropped: drops.length,
      byReason,
      samples: drops.slice(0, sampleLimit).map((d) => ({
        reason: d.reason,
        dropped: (d.dropped as Row).title,
        kept: (d.kept as Row).title,
      })),
    });
  }

  // 存量确定性重复（这一节才是「可以安全删」的）
  const { groups } = groupIdentical(rows);
  const removableIds = groups.flatMap((g) => g.dropIds);

  const result: Record<string, unknown> = {
    ok: true,
    mode: 'report-only（只读，不写任何数据）',
    window: { days, since },
    totals: {
      articles: rows.length,
      /** 用同一套判据跑一遍会剩下多少 */
      afterDedup: rows.length - droppedTotal,
      dropped: droppedTotal,
      byReason: allByReason,
    },
    /** 存量里**确定性**重复的组（可直接安全删除的那些） */
    identicalGroups: {
      groupCount: groups.length,
      removableRows: removableIds.length,
      sample: groups.slice(0, sampleLimit),
    },
    perCountry,
  };

  // 可选：真的调一次模型，验证 L2 通道通不通（每国 1 次调用）
  //
  // `judge=think|nothink` 用来 A/B「判组要不要开 thinking」：
  // 翻译链路刻意关掉 thinking（GLM-4.7 默认开会拖慢到超时），但判组是推理型任务，
  // 2026-09-21 实测首次上线时模型把 18 条无关新闻并成一组，怀疑与关掉 thinking 有关。
  // 这个参数让两种配置**同一次部署里都能试**，不用每试一次等一轮构建。
  //
  // `mode=pair|group` 用来 A/B 任务形态：`group`（长串找组）实测按话题乱合并已停用，
  // 生产走 `pair`（逐对二选一）。这里保留 `group` 是为了需要时能原地重现那次失败。
  // `debug=1` 会把模型的原始返回文本一并带回来 —— 判组出问题时，只有它说得清「模型到底吐了什么」。
  if (withLlm) {
    const { dedupeStories } = await import('@/lib/same-event');
    const judgeMode = searchParams.get('judge') || 'nothink';
    const extraBody =
      judgeMode === 'think'
        ? ({ thinking: { type: 'enabled' } } as Record<string, unknown>)
        : judgeMode === 'nothink'
          ? ({ thinking: { type: 'disabled' } } as Record<string, unknown>)
          : undefined; // auto：沿用通道默认值
    const taskMode = searchParams.get('mode') === 'group' ? 'group' : 'pair';
    const debug = searchParams.get('debug') === '1';
    const perCountryLimit = Math.min(Number(searchParams.get('limit')) || 60, 200);

    const probe: Array<{
      country: string;
      ran: boolean;
      ok: boolean;
      /** 本轮问给模型的候选对数（pair 形态才有） */
      candidatePairs?: number;
      /** 模型判为「同一件事」的对数（pair 形态才有） */
      judgedPairs?: number;
      /** 被确定性判据（反向极性）拦下、**没问模型**的对数 */
      vetoedPairs?: number;
      /** 问了模型、但模型判「否」的对数 —— 用来发现**漏合并** */
      declinedPairs?: number;
      groups: number;
      error?: string;
      /** 每组的具体标题 —— 只报数量的话，误合并会静默藏起来，看不出来 */
      groupTitles?: Array<{ kept: string; dropped: string[] }>;
      /**
       * pair 形态：模型**逐对**的原话。这是判得准不准的唯一直接证据 ——
       * `groupTitles` 只显示合并后的结果，看不出模型答了哪些对被簇护栏拦掉。
       */
      pairs?: Array<{ sim: number; a: string; b: string }>;
      /** pair 形态：被极性判据拦下的对（模型看不到，答什么都无效） */
      vetoed?: Array<{ sim: number; a: string; b: string }>;
      /**
       * pair 形态：模型判「否」的对。
       * **这是「漏合并」的唯一可见窗口** —— 只盯 `pairs`（判是的）会让人误以为
       * 剩下的都判对了，实际上真重复被否掉就永久留成两条，没人会知道。
       */
      declined?: Array<{ sim: number; a: string; b: string }>;
      /** debug=1 时的模型原始返回（截断），判组离谱时看这个 */
      raw?: string[];
    }> = [];

    for (const [cc, list] of byCountry) {
      const slice = list.slice(0, perCountryLimit);
      const { llm } = await dedupeStories(slice as never[], {
        // 显式打开：体检的目的就是验证 L2，不能受生产默认值（关闭）影响
        useLlm: true,
        judge: { extraBody, collectRaw: debug, mode: taskMode },
      });
      // 候选对里被模型判为「是」的那些，配上相似度 —— 相似度是召回的排序依据，
      // 把它和模型的判定并排看，才能分清「模型判错」与「候选没召回」。
      const simOf = (a: number, b: number) =>
        Math.round(similarity((slice[a] as Row).title || '', (slice[b] as Row).title || '') * 100) / 100;
      probe.push({
        country: cc,
        ran: llm.ran,
        ok: llm.ok,
        candidatePairs: llm.candidateCount,
        judgedPairs: llm.pairs?.length,
        vetoedPairs: llm.vetoed?.length,
        declinedPairs: llm.declined?.length,
        groups: llm.groups.length,
        error: llm.error,
        groupTitles: llm.groups.map((g) => ({
          kept: (slice[g[0]] as Row).title,
          dropped: g.slice(1).map((i) => (slice[i] as Row).title),
        })),
        pairs: llm.pairs?.map((p) => ({
          sim: simOf(p.a, p.b),
          a: (slice[p.a] as Row).title,
          b: (slice[p.b] as Row).title,
        })),
        vetoed: llm.vetoed?.map((p) => ({
          sim: simOf(p.a, p.b),
          a: (slice[p.a] as Row).title,
          b: (slice[p.b] as Row).title,
        })),
        declined: llm.declined?.map((p) => ({
          sim: simOf(p.a, p.b),
          a: (slice[p.a] as Row).title,
          b: (slice[p.b] as Row).title,
        })),
        ...(debug && llm.raw ? { raw: llm.raw.map((t) => t.slice(0, 1500)) } : {}),
      });
    }
    result.llmJudge = probe;
    result.llmJudgeParams = { mode: taskMode, judgeMode, perCountryLimit, debug };
  }

  return NextResponse.json(result);
}

/** 存量清理。**默认 dry-run**，必须显式 `apply: true` 才真删。 */
export async function POST(request: NextRequest) {
  let body: { apply?: boolean; days?: number } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    // 空 body 就是 dry-run，不算错误
  }

  const apply = body.apply === true;
  const days = parseDays(body.days === undefined ? null : String(body.days));
  const since = windowStart(days);

  let rows: Row[];
  try {
    rows = (await getArticleIdentities(since)) as Row[];
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: `读取文章失败：${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }

  const { groups } = groupIdentical(rows);
  const dropIds = groups.flatMap((g) => g.dropIds);

  if (!apply) {
    return NextResponse.json({
      ok: true,
      mode: 'dry-run',
      hint: '确认无误后，用 POST {"apply": true} 真正删除这些行',
      window: { days, since },
      scannedRows: rows.length,
      duplicateGroups: groups.length,
      wouldDeleteRows: dropIds.length,
      groups: groups.slice(0, 50),
      wouldDeleteIds: dropIds.slice(0, 200),
    });
  }

  if (dropIds.length === 0) {
    return NextResponse.json({ ok: true, mode: 'apply', deleted: 0, message: '该时间窗内没有确定性重复行' });
  }

  try {
    const deleted = await deleteArticlesByIds(dropIds);
    return NextResponse.json({
      ok: true,
      mode: 'apply',
      window: { days, since },
      scannedRows: rows.length,
      duplicateGroups: groups.length,
      deleted,
      deletedIds: dropIds.slice(0, 200),
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, mode: 'apply', error: `删除失败：${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }
}
