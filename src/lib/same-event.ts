/**
 * 「同一件事」识别 —— 内容级去重的唯一入口。
 *
 * ## 为什么需要这个文件
 *
 * 2026-09-21 用户在公众号草稿预览里截到一对新闻：两条都在讲「阿斯塔纳跨阿雷斯河新建桥梁」，
 * 一条写「八车道、总长 1.2 公里」，另一条写「七车道、2026 年 10 月竣工」。
 * 看起来是两篇，实际是同一条新闻被处理了两遍。
 *
 * 排查后发现原去重有两处根本问题（都有实测数据支撑，不是推测）：
 *
 * 1. **链接去重是精确字符串比较**，而同一篇原文的链接形式会变形
 *    （`?from=rss`、末尾斜杠、`utm_*`…）。实测线上库 200 篇里 4% 是
 *    **source_url 逐字相同**的重复行；换一个更早的 200 篇快照更是 22%。
 *    → 由 `utils.canonicalUrl` + `dedupeStoriesDeterministic` 的 `same_url` 处理。
 *
 * 2. **字符相似度判据实际上从不生效**。原 `isDuplicateContent` 要求
 *    「标题相似度 ≥0.8」或「标题+正文平均相似度 ≥0.6」。拿真实数据实测：
 *    连同一篇原文的两次翻译都只有 avg≈0.18（桥梁那对），而上面那对
 *    土耳其/以色列大使馆的**不同事件**却能达到 avg≈0.32 ——
 *    也就是说这个判据既抓不到该抓的，又（在阈值附近）可能误伤。
 *    单纯调阈值解决不了：正负样本的分数区间是**重叠**的。
 *    → 实测打分器确实做不到「理解」，所以这里引入模型判组（见 `judgeSameEventGroups`）。
 *
 * ## 三层机制（按可靠性从高到低）
 *
 * | 层 | 判据 | 性质 | 成本 |
 * |---|---|---|---|
 * | L0 `same_url` | 归一化链接相同 | 确定性，可断言 | 0 |
 * | L1 `same_original` | 原文标题相同（链接不同 → 同稿多链） | 确定性，可断言 | 0 |
 * | L2 `llm_same_event` | 模型判「表述不同、实际同一件事」 | 概率性，可回退 | 每国 1 次调用 |
 *
 * L2 是「理解机制」本体：像「金价下跌」vs「金价上涨」、「土耳其大使馆」vs「以色列大使馆」
 * 这种**字面很像但语义相反/不同**的对，只有看懂内容才分得开。
 * 因此提示词里**显式并列了这类反例**，并把「拿不准就不要合并」写进判据 ——
 * 宁可漏合并，也不能把两条不同的新闻合成一条（那是丢信息，比重复更糟）。
 *
 * L2 不可用时（没配 Key / 调用失败 / 返回不合法）**自动降级为只跑 L0+L1**，
 * 并在返回值里带上 `llm.error`，让调用方能看出来这次有没有真正跑过模型。
 */
import { canonicalUrl, similarity, originalTitleKey } from './utils';
import { askLlmJson } from './translate';

/** 判定「是不是同一件事」所需的最小字段集。DB 行与抓取中间产物都能满足。 */
export interface StoryLike {
  title: string;
  content?: string | null;
  summary?: string | null;
  country_code?: string | null;
  /** DB 行字段名 */
  source_url?: string | null;
  original_title?: string | null;
  /** API 返回的驼峰字段名 */
  sourceUrl?: string | null;
  originalTitle?: string | null;
  publishedAt?: string | null;
}

export type DedupReason = 'same_url' | 'same_original' | 'same_text' | 'llm_same_event';

export interface DedupDrop<T> {
  /** 被保留下来的那一条（组内排最前的） */
  kept: T;
  /** 被丢弃的这一条 */
  dropped: T;
  reason: DedupReason;
}

export interface DedupResult<T> {
  kept: T[];
  drops: DedupDrop<T>[];
  /** L2 的执行情况。`ran=false` 表示本次没跑模型（没配 Key 或条数不足）。 */
  llm: { ran: boolean; ok: boolean; groups: number[][]; error?: string };
}

// ----- 字段读取（兼容 snake_case / camelCase 两种来源）-----

function urlOf(a: StoryLike): string {
  return a.source_url ?? a.sourceUrl ?? '';
}

function originalTitleOf(a: StoryLike): string {
  return a.original_title ?? a.originalTitle ?? '';
}

function countryOf(a: StoryLike): string {
  return a.country_code ?? '';
}

/**
 * 一条新闻参与身份判定的 key。空字符串表示「这条没有可用身份」。
 * 导出是为了让离线体检脚本能直接断言「哪两条被判成同一条」。
 *
 * `originalTitleKey` 定义在 `utils.ts`：`db-articles.ts` 入库去重时也要用同一个指纹，
 * 放在这里会让 db 模块反向依赖本文件（进而依赖 translate），没必要。
 */
export function identityKeys(a: StoryLike): string[] {
  const keys: string[] = [];
  const cu = canonicalUrl(urlOf(a));
  if (cu) keys.push(`url:${cu}`);
  const ot = originalTitleKey(originalTitleOf(a));
  if (ot) keys.push(`orig:${countryOf(a)}:${ot}`);
  return keys;
}

// ----- L0 + L1 + 原字符相似度（纯同步、确定性）-----

/**
 * 兜底的「文本几乎逐字相同」判据 —— 只认**真正逐字重复**，不认「主题像」。
 *
 * 为什么把阈值收到这么紧（标题 0.9 + 正文 0.8）：
 *
 * 这条判据的前身是 `utils.isDuplicateContent`（标题 0.8 / 平均 0.6）。
 * 拿真实语料量过之后发现它两头都不对：
 *
 *   - **真实数据上一个真阳性都没有**。在 200 篇 / 1000 篇两份线上快照上跑，
 *     它一次都没触发（真实的重复全被链接判据先拦掉了）。
 *   - **却有一个可复现的误杀**。两条**方向相反**的新闻 ——
 *     「全球市场黄金和白银价格下跌」与「……上涨」，正文只差一个字 ——
 *     标题相似度 0.71、正文相似度 0.9，平均值 0.81 ≥ 0.6 → **被合并**，
 *     等于直接把一条利空/利多相反的消息删掉。
 *
 * 结论：一个「真实数据零贡献、却有实际误杀风险」的判据不该留在链路里。
 * 收成「几乎逐字相同」之后它只负责最后一种情况 ——
 * 同一段文本被两个入口各抓了一份（连标题带正文都一样），
 * 这种情况无论怎么判都该合并。
 *
 * 「表述不同、实际同一件事」（例如「团结的力量」与「团结之力」）交给 L2 模型判组，
 * **不要**试图靠调这里的阈值解决：那类正负样本的相似度区间实测是**重叠**的。
 */
function isNearIdenticalText(a: StoryLike, b: StoryLike): boolean {
  if (similarity(a.title, b.title) < 0.9) return false;
  return similarity(a.content || '', b.content || '') >= 0.8;
}

/**
 * 确定性的「同一条新闻」判定，按输入顺序保序去重。
 *
 * 复杂度 O(n²)，但这里的 n 是**单国单輪的候选数**（几十条），
 * 而且每条只存两个短字符串 key，实际开销可以忽略 ——
 * 换来的是「不依赖哈希碰撞、判据可逐条打印」的可排查性。
 */
export function dedupeStoriesDeterministic<T extends StoryLike>(items: T[]): {
  kept: T[];
  drops: DedupDrop<T>[];
} {
  const kept: T[] = [];
  const drops: DedupDrop<T>[] = [];
  const seenKeys = new Set<string>();

  for (const item of items) {
    const keys = identityKeys(item);

    // L0 / L1：链接或原文标题撞上已保留的条目 → 同一条新闻
    let hit: string | null = null;
    for (const k of keys) {
      if (seenKeys.has(k)) {
        hit = k;
        break;
      }
    }
    if (hit) {
      drops.push({
        kept: kept.find((p) => identityKeys(p).includes(hit as string)) as T,
        dropped: item,
        reason: hit.startsWith('url:') ? 'same_url' : 'same_original',
      });
      continue;
    }

    // 兜底：文本逐字相同的重复（见 isNearIdenticalText 的取舍说明）
    const textDup = kept.find((p) => isNearIdenticalText(p, item));
    if (textDup) {
      drops.push({ kept: textDup, dropped: item, reason: 'same_text' });
      continue;
    }

    for (const k of keys) seenKeys.add(k);
    kept.push(item);
  }

  return { kept, drops };
}

// ----- L2：模型判组（「理解机制」本体）-----

/** 单次交给模型的条目上限。超了就分块，块间不重叠。 */
const LLM_BLOCK_SIZE = 60;

/** 标题/摘要截断长度，防止个别超长正文把单次请求撑爆。 */
const TITLE_MAX = 80;
const SUMMARY_MAX = 60;

/**
 * 提示词里的判据。**这段是这套机制的核心资产**，改动前先跑
 * `/api/dedupe-check` 的固定语料，别凭感觉调。
 */
function buildJudgePrompt(rows: Array<{ i: number; title: string; summary: string; category: string }>): string {
  const lines = rows.map((r) => `${r.i} | ${r.category} | ${r.title} | ${r.summary}`);
  return [
    '下面是一个国家同一天的多条新闻（已按重要性排序，编号就是行首数字）。',
    '请找出其中「实际报道的是同一件事」的新闻，把它们归到同一组。',
    '',
    '判定为同一件事：同一次会议 / 同一次签约 / 同一份公告 / 同一条政策 /',
    '同一个项目的重复报道。即使来源不同、措辞不同、详略不同、',
    '甚至数字有出入（一处写"八车道"、另一处写"七车道"），也属于同一件事。',
    '',
    '以下情况是**两件不同的事**，绝对不要合并：',
    '  · 不同主体做同类事：「土耳其大使馆祝贺主权日」与「以色列大使馆祝贺主权日」',
    '  · 方向相反：「金价下跌」与「金价上涨」',
    '  · 不同地点/不同项目：「东哈萨克斯坦州建桥」与「阿斯塔纳建桥」',
    '  · 不同人物：「运动员甲夺金」与「运动员乙夺金」',
    '拿不准就不要合并 —— 把两条不同的新闻合成一条会丢信息，比留下重复更糟。',
    '',
    '只输出 JSON，不要任何解释文字。格式：',
    '{"groups": [[0,5],[3,7,9]]}',
    '每个分组至少 2 个编号；没有任何重复时输出 {"groups": []}。',
    '',
    '# | 分类 | 标题 | 摘要',
    ...lines,
  ].join('\n');
}

/**
 * 解析模型返回的分组。**只接受合法下标**：
 * 越界、重复、单元素分组一律丢掉，而不是抛错 ——
 * 宁可这次不合并，也不要让一次脏输出掀掉整轮推送。
 *
 * 导出是**故意的**：`scripts/test-dedup.ts` 直接拿它跑固定语料
 * （包括「模型返回 ```json 围栏」「返回越界下标」「返回单元素组」这些脏输出），
 * 这样这层解析逻辑不需要真的调模型就能回归。
 */
export function parseEventGroups(text: string, total: number): number[][] | null {
  // 模型偶尔会给 JSON 套上 ```json 围栏，或前后带一句客套话，所以取第一个 {...} 块。
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const raw = (parsed as { groups?: unknown })?.groups;
  if (!Array.isArray(raw)) return null;

  const groups: number[][] = [];
  for (const g of raw) {
    if (!Array.isArray(g)) continue;
    const nums = [...new Set(
      g.filter((v): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) < total),
    )].sort((a, b) => a - b);
    if (nums.length >= 2) groups.push(nums);
  }
  return groups;
}

/**
 * 让模型判「哪些条目在讲同一件事」。
 *
 * 返回**下标分组**（相对传入数组）。任何一步失败都返回 `{ groups: [], error }`，
 * 由调用方决定降级策略（当前策略：降级为不合并这些条目）。
 */
export async function judgeSameEventGroups<
  T extends StoryLike & { category?: string | null; summary?: string | null },
>(items: T[]): Promise<{ groups: number[][]; error?: string }> {
  const groups: number[][] = [];

  for (let base = 0; base < items.length; base += LLM_BLOCK_SIZE) {
    const block = items.slice(base, base + LLM_BLOCK_SIZE);
    if (block.length < 2) continue;

    const rows = block.map((a, i) => ({
      i,
      title: (a.title || '').slice(0, TITLE_MAX),
      summary: (a.summary || '').replace(/\s+/g, ' ').slice(0, SUMMARY_MAX),
      category: a.category || '-',
    }));

    const res = await askLlmJson(buildJudgePrompt(rows), { timeoutMs: 45000 });
    // 用 `in` 而不是靠 `!res.ok` 的可辨识联合收窄：这里跨模块取值，
    // 收窄在不同 tsconfig（strict / 非 strict）下表现不一致，
    // 而这条路径**必须**在任何配置下都能编译通过（它是推送链路上的关键分支）。
    if (!res.ok) {
      return { groups: [], error: 'error' in res ? res.error : '模型调用失败（无错误详情）' };
    }
    const parsed = parseEventGroups(res.text, block.length);
    if (!parsed) {
      return { groups: [], error: '模型返回不是合法 JSON（已按「不合并」处理）' };
    }
    for (const g of parsed) {
      // 还原成相对整体数组的下标
      groups.push(g.map((i) => i + base));
    }
  }

  return { groups };
}

// ----- 对外的统一入口 -----

export interface DedupeOptions {
  /**
   * 是否允许调用模型做 L2 判定。默认 true。
   * 传 false 时只跑 L0/L1（例如离线回归脚本、或调用方已知自己处在
   * 不能接受额外延迟的路径上）。
   */
  useLlm?: boolean;
}

/**
 * 内容级去重的统一入口。调用方只需要传一组同国候选，拿回「保留哪些 + 每一条为什么被丢」。
 *
 * 顺序很关键：**先跑确定性去重，再让模型看剩下的**。
 * 一来省钱（同一条新闻的链接重复在第一层就没了，不用占提示词），
 * 二来更准（模型看到的列表更短、噪声更少）。
 */
export async function dedupeStories<T extends StoryLike & { category?: string | null }>(
  items: T[],
  options: DedupeOptions = {},
): Promise<DedupResult<T>> {
  const { useLlm = true } = options;

  const { kept: keptAfterIdentity, drops: identityDrops } = dedupeStoriesDeterministic(items);
  const drops: DedupDrop<T>[] = [...identityDrops];
  const llm: DedupResult<T>['llm'] = { ran: false, ok: false, groups: [] };

  if (!useLlm || keptAfterIdentity.length < 2) {
    return { kept: keptAfterIdentity, drops, llm };
  }

  llm.ran = true;
  const judged = await judgeSameEventGroups(keptAfterIdentity);
  if (judged.error) {
    llm.error = judged.error;
    console.error(`[same-event] 模型判组未生效，本轮降级为只做链接/原文去重：${judged.error}`);
    return { kept: keptAfterIdentity, drops, llm };
  }

  llm.ok = true;
  llm.groups = judged.groups;

  // 组内保序保留第一条（传入前已按重要性排好），其余记为 llm_same_event
  const droppedIndexes = new Set<number>();
  for (const g of judged.groups) {
    const first = g[0];
    for (const idx of g.slice(1)) {
      droppedIndexes.add(idx);
      drops.push({
        kept: keptAfterIdentity[first],
        dropped: keptAfterIdentity[idx],
        reason: 'llm_same_event',
      });
    }
  }

  const kept = keptAfterIdentity.filter((_, i) => !droppedIndexes.has(i));
  return { kept, drops, llm };
}
