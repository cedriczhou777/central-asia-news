/**
 * **候选**源探针：把「想收录的 URL」逐个过一遍 `fetchFeed`，报出能不能用、值不值得收。
 *
 * ## 为什么不直接往 `RSS_SOURCES` 里加
 *
 * 这个项目已经为「看着像 feed、其实是网页」付过两次代价：
 *
 *   ① `centralasia.news/feed/` —— 200 + 47KB HTML（已移除）；
 *   ② `kg.akipress.org/rss` / `tazabek.kg/rss` —— **按 UA 返回**，
 *      feed 阅读器 UA 给 XML、其它 UA 给 SPA 首页 HTML，
 *      而首页 HTML 会在第 38 行撞上一个不闭合标签，抛出和「XML 畸形」
 *      **一模一样**的错误，把根因带偏了整整一轮。
 *
 * 所以「能不能收」这件事必须**先量再写**，不能凭印象。本脚本与生产共用
 * `fetchFeed`（同一套 UA、同一套 Content-Type 判定），量出来的结论直接可比。
 *
 * ## ⚠️ 本机视角 ≠ 容器视角
 *
 * 与 `analyze:feeds` 同一个限制：`Inbusiness.kz` 本机可达、容器里超时。
 * 本脚本回答「这个 URL 到底是不是 feed / 本机能不能解析」；
 * 「线上通不通」要等收录后看 `GET /api/fetch-news` 的 `sourceErrors`。
 * **两边都要看，两者实测会不一致。**
 *
 * ## 判定口径
 *
 * - **建议收录**：解析出 ≥3 条，且最新条目在 7 天内（说明这源是活的，不是僵尸 feed）。
 * - **0 条 / 拿到网页**：不要收 —— 前者是死 feed，后者根本不是 feed。
 * - **超时**：**不下结论**。本机 25s 不代表容器 60s 也不行，标成「待容器验证」。
 * - **最新条目很旧**：标出来。僵尸 feed 收进来只会让 `sourceErrors` 常年挂噪音，
 *   而且它占的是一次超时预算。
 *
 * ## 用法
 *
 *   pnpm probe:feeds                 # 全部候选
 *   pnpm probe:feeds tj              # 只看塔吉克（候选清单里最薄的一国）
 *   pnpm probe:feeds --only=sputnik  # 只测 URL 含该子串的候选
 *   CAND_TIMEOUT_MS=45000 pnpm probe:feeds
 */
import { RSS_SOURCES } from '../src/lib/data/rss-sources';
import { fetchFeed, FeedFetchError } from '../src/lib/feed-fetch';

/**
 * 候选清单。**加候选前先想清「哪个国家需要更多源」** ——
 * 扩源不是均匀铺：阿塞拜疆本来就有 8 个 RSS 源（全项目最多），
 * 而用户报的重复恰恰出在 az —— 多源**制造**重复，不治重复。
 * 塔吉克只有 3 个可用源，是真正需要补的那个。
 */
const CANDIDATES: Array<{ name: string; url: string; country: string; lang: string; why: string }> = [
  // ── 塔吉克斯坦（现有仅 3 源，全项目最薄；优先补这里）──────────
  { name: 'Sputnik Tajikistan', url: 'https://tj.sputniknews.ru/export/rss2/archive/index.xml', country: 'tj', lang: 'ru', why: '俄语台，现有 sputnik_tajikistan 只有 Telegram 版' },
  { name: 'Ozodi (RFE/RL)', url: 'https://rus.ozodi.org/api/zrqiteuuir', country: 'tj', lang: 'ru', why: 'RFE/RL 塔吉克台，独立媒体里影响最大' },
  { name: 'Ozodi (tj)', url: 'https://ozodi.org/api/zrqiteuuir', country: 'tj', lang: 'tg', why: '同上，塔吉克语版' },
  { name: 'Akhbor', url: 'https://akhbor.com/feed/', country: 'tj', lang: 'tg', why: '本地新闻站' },
  { name: 'Sadoi Mardum', url: 'https://sadoimardum.tj/feed/', country: 'tj', lang: 'tg', why: '国家广播电台，官方口径' },
  { name: 'Faraj.tj', url: 'https://faraj.tj/feed/', country: 'tj', lang: 'tg', why: '本地独立站' },
  { name: 'NHK.tj', url: 'https://nhk.tj/feed/', country: 'tj', lang: 'tg', why: '本地站' },
  { name: 'Pamir News', url: 'https://pamir-news.tj/feed/', country: 'tj', lang: 'tg', why: '戈尔诺-巴达赫尚地区报道' },
  { name: 'Avesta (en)', url: 'https://avesta.tj/en/feed/', country: 'tj', lang: 'en', why: '已有俄语版，英语版或能提高可译性' },

  // ── 乌兹别克斯坦（41 条候选，偏薄）────────────────────────────
  { name: 'Podrobno.uz', url: 'https://podrobno.uz/rss/', country: 'uz', lang: 'ru', why: '主流新闻站，更新频繁' },
  { name: 'UzDaily', url: 'https://www.uzdaily.uz/en/rss', country: 'uz', lang: 'en', why: '英语商业新闻，对投资者最直接' },
  { name: 'NUZ.uz', url: 'https://nuz.uz/feed/', country: 'uz', lang: 'ru', why: '独立新闻站' },
  { name: 'xs.uz', url: 'https://xs.uz/ru/rss', country: 'uz', lang: 'ru', why: '商业/经济向' },
  { name: 'Review.uz', url: 'https://review.uz/ru/rss', country: 'uz', lang: 'ru', why: '经济评论' },
  { name: 'President.uz', url: 'https://president.uz/ru/rss', country: 'uz', lang: 'ru', why: '总统府官方，政策原文' },
  { name: 'Aniq.uz', url: 'https://aniq.uz/feed', country: 'uz', lang: 'uz', why: '本地语新闻' },

  // ── 吉尔吉斯斯坦 ────────────────────────────────────────────
  { name: 'Kloop', url: 'https://kloop.kg/feed/', country: 'kg', lang: 'ru', why: '调查报道，质量高' },
  { name: 'Sputnik Kyrgyzstan', url: 'https://sputnik.kg/export/rss2/archive/index.xml', country: 'kg', lang: 'ru', why: '现有 sputnik_kyrgyzstan 只有 Telegram 版' },
  { name: 'Akchabar', url: 'https://akchabar.kg/feed/', country: 'kg', lang: 'ru', why: '金融经济，投资者相关度高' },
  { name: 'Vesti.kg (alt)', url: 'https://www.vesti.kg/rss', country: 'kg', lang: 'ru', why: '现有 URL 不带 www，可能是 200+网页' },
  { name: 'Turmush', url: 'https://www.turmush.kg/rss', country: 'kg', lang: 'ru', why: '地方新闻覆盖' },
  { name: 'KyrTAG', url: 'https://kyrtag.kg/feed/', country: 'kg', lang: 'ru', why: '国家通讯社' },

  // ── 哈萨克斯坦（现有 5 源，尚可，只补高价值）─────────────────
  { name: 'Kursiv.kz', url: 'https://kz.kursiv.media/feed/', country: 'kz', lang: 'ru', why: '财经媒体，投资者相关度高' },
  { name: 'Kapital.kz', url: 'https://kapital.kz/rss/', country: 'kz', lang: 'ru', why: '商业财经' },
  { name: 'Forbes.kz', url: 'https://forbes.kz/rss/all/', country: 'kz', lang: 'ru', why: '商业报道' },
  { name: 'Zakon.kz', url: 'https://www.zakon.kz/rss', country: 'kz', lang: 'ru', why: '政策法规，本项目有 policy/law 分类' },
  { name: 'Infromburo', url: 'https://informburo.kz/rss', country: 'kz', lang: 'ru', why: '主流新闻' },
  { name: 'Tengrinews', url: 'https://tengrinews.kz/news.rss', country: 'kz', lang: 'ru', why: '最大民营通讯社（旧 URL rss_news/all.xml 已 404，这是另一个路径）' },
  { name: 'KASE', url: 'https://kase.kz/en/news/rss/', country: 'kz', lang: 'en', why: '交易所公告，投资者最直接' },

  // ── 区域 / 国际（跨国的背景与投资视角）───────────────────────
  { name: 'Eurasianet', url: 'https://eurasianet.org/rss.xml', country: 'intl', lang: 'en', why: '中亚区域深度报道' },
  { name: 'CABAR.asia', url: 'https://cabar.asia/feed', country: 'intl', lang: 'ru', why: '中亚分析平台' },

  // ── 阿塞拜疆：**故意不加** ───────────────────────────────────
  // az 已有 8 个 RSS 源（全项目最多），而用户报的三条重复（Unibank 绿色信贷）
  // 正是「同一事件被多家 az 媒体各写一篇」的产物。
  // 再给 az 加源只会让 L2 的漏合并更显眼，不会减少重复。
];

/** 本机探测超时。比生产的 60s 短，是为了让整批跑得完；超时**不下结论**。 */
const TIMEOUT_MS = (() => {
  const raw = Number(process.env.CAND_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 25000;
})();
/** 并发数。别开太大：这些是中亚的小站点，打狠了会被当攻击。 */
const CONCURRENCY = 4;
/** 「最新的这条有多新」超过这个天数就算僵尸 feed */
const STALE_DAYS = 7;

function pad(s: string, n: number) {
  const w = [...s].reduce((a, c) => a + (/[\u4e00-\u9fff\uff00-\uffef]/.test(c) ? 2 : 1), 0);
  return s + ' '.repeat(Math.max(0, n - w));
}

/** 从条目里尽力取一个时间。各源字段不统一，取到哪个用哪个。 */
function itemDate(item: Record<string, unknown>): Date | null {
  for (const k of ['isoDate', 'pubDate', 'date']) {
    const v = item[k];
    if (typeof v === 'string') {
      const d = new Date(v);
      if (!Number.isNaN(d.getTime())) return d;
    }
  }
  return null;
}

type Verdict = '建议收录' | '疑似僵尸' | '空 feed' | '不是 feed' | '待容器验证' | '不要收录';

interface Result {
  name: string;
  url: string;
  country: string;
  lang: string;
  why: string;
  verdict: Verdict;
  detail: string;
  items: number;
  newestDays: number | null;
}

async function probeOne(c: (typeof CANDIDATES)[number]): Promise<Result> {
  const base = { name: c.name, url: c.url, country: c.country, lang: c.lang, why: c.why };
  try {
    const { feed, meta } = await fetchFeed(c.url, { timeoutMs: TIMEOUT_MS });
    const items = (feed.items ?? []) as Array<Record<string, unknown>>;
    const dates = items.map(itemDate).filter((d): d is Date => d !== null);
    const newest = dates.length ? new Date(Math.max(...dates.map((d) => d.getTime()))) : null;

    if (items.length === 0) {
      return { ...base, verdict: '空 feed', detail: `解析成功但 0 条（Content-Type ${meta.contentType || '空'}，${meta.bytes}B）`, items: 0, newestDays: null };
    }
    // 「一条日期都取不到」必须**先于**「有多旧」判断，而且必须单列一档：
    // 本项目按 `published_at` 做窗口过滤，取不到日期就等于整个源会被窗口丢掉 ——
    // 它比「僵尸 feed」更隐蔽（僵尸至少还有日期，能在漏斗里看出来）。
    if (newest === null) {
      return { ...base, verdict: '疑似僵尸', detail: `${items.length} 条但**没有一条能取到日期**（窗口过滤会把它们全丢）`, items: items.length, newestDays: null };
    }
    // 到这里 TS 才知道 newest 非空 —— 所以天数在这里才算，不提前算成 `number | null`。
    const newestDays = (Date.now() - newest.getTime()) / 86400000;
    if (newestDays > STALE_DAYS) {
      return { ...base, verdict: '疑似僵尸', detail: `最新一条在 ${newestDays.toFixed(0)} 天前（${meta.bytes}B / ${meta.ms}ms / UA ${meta.usedUa}）`, items: items.length, newestDays };
    }
    return { ...base, verdict: '建议收录', detail: `${items.length} 条，最新 ${newestDays.toFixed(1)} 天前（${meta.bytes}B / ${meta.ms}ms / UA ${meta.usedUa.slice(0, 18)}）`, items: items.length, newestDays };
  } catch (err) {
    if (err instanceof FeedFetchError) {
      const m = err.meta;
      const timedOut = m.attempts.every((a) => a.error);
      return {
        ...base,
        verdict: timedOut ? '待容器验证' : '不是 feed',
        detail: timedOut
          ? `本机 ${TIMEOUT_MS}ms 内请求未返回（容器 60s 可能可以，**别据此否掉**）`
          : err.message.replace(/\s+/g, ' ').slice(0, 150),
        items: 0,
        newestDays: null,
      };
    }
    return { ...base, verdict: '不要收录', detail: String(err).slice(0, 150), items: 0, newestDays: null };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const country = args.find((a) => !a.startsWith('--'));
  const urlFilter = args.find((a) => a.startsWith('--only='))?.slice('--only='.length);

  const list = CANDIDATES.filter(
    (c) => (!country || c.country === country) && (!urlFilter || c.url.includes(urlFilter)),
  );

  console.log(`候选源探针：${list.length} 个，本机超时 ${TIMEOUT_MS}ms，并发 ${CONCURRENCY}`);
  console.log(`⚠️ 本机视角 —— 「容器通不通」要收录后看 GET /api/fetch-news 的 sourceErrors\n`);

  // 已有源清单：撞车检查。同一个 URL 写两遍会让每轮多打一次请求、且日志里出现两条同名记录。
  //
  // ⚠️ 比较前必须**归一化 `www.`**：`vesti.kg/rss` 与 `www.vesti.kg/rss`
  // 是两个不同字符串、但同一个源（实测两条都能解析出条目）。
  // 第一版没做这一步，于是 `Vesti.kg (alt)` 被判成「新源·建议收录」——
  // 收进去就是给同一个站点跑两遍。同一类坑还会出现在 `http`/`https`、末尾斜杠上。
  const norm = (u: string) =>
    u.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '').toLowerCase();
  const existing = new Set(RSS_SOURCES.map((s) => norm(s.url)));
  const existingHost = new Set(
    RSS_SOURCES.map((s) => new URL(s.url).hostname.replace(/^www\./, '').toLowerCase()),
  );

  const results: Result[] = [];
  for (let i = 0; i < list.length; i += CONCURRENCY) {
    const batch = list.slice(i, i + CONCURRENCY);
    process.stdout.write(`  探测 ${i + 1}-${Math.min(i + batch.length, list.length)}/${list.length}…\r`);
    results.push(...(await Promise.all(batch.map(probeOne))));
  }
  process.stdout.write(' '.repeat(40) + '\r');

  results.sort((a, b) => {
    // ⚠️ 键必须带引号：`空 feed` **含空格**，写成裸键会让 esbuild 直接报
    // `Expected "}" but found "feed"` —— 报错位置指向这一行，但信息看着像语法结构坏了。
    const order: Record<Verdict, number> = { '建议收录': 0, '疑似僵尸': 1, '空 feed': 2, '不是 feed': 3, '不要收录': 4, '待容器验证': 5 };
    return order[a.verdict] - order[b.verdict] || a.country.localeCompare(b.country);
  });

  for (const r of results) {
    const dup = existing.has(norm(r.url));
    const sameHost = existingHost.has(new URL(r.url).hostname.replace(/^www\./, '').toLowerCase());
    const dupNote = dup ? '　⛔ 已在 RSS_SOURCES 里（重复）' : sameHost ? '　ℹ️ 域名已有源（不同路径，可能是重复内容）' : '';
    console.log(`${pad(r.verdict, 12)}${pad(r.country, 6)}${pad(r.name, 22)}${r.detail}${dupNote}`);
    console.log(`${' '.repeat(40)}└─ ${r.why}`);
  }

  const count = (v: Verdict) => results.filter((r) => r.verdict === v).length;
  console.log(
    `\n──────── 小计 ────────\n` +
      `建议收录 ${count('建议收录')}　疑似僵尸 ${count('疑似僵尸')}　空 feed ${count('空 feed')}　` +
      `不是 feed ${count('不是 feed')}　待容器验证 ${count('待容器验证')}`,
  );
  console.log(`\n⚠️ 「建议收录」也**先别全加**：按国家看哪个最薄再决定 —— 加源会制造重复，不是均匀铺。`);
}

main().catch((err) => {
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
});
