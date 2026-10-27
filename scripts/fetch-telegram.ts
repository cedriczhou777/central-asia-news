/**
 * Telegram 抓取器（**跑在 GitHub Actions 上**，2026-10-26 加）。
 *
 * ## 为什么它跑在 GitHub 而不是云托管
 *
 * 微信云托管在大陆 ⇒ 连不上 `t.me`（实测：直连 254ms 就 `fetch failed`），
 * 也连不上 `*.workers.dev` ⇒ ⇒ **12 个 Telegram 频道（占配置源的 34%）一条都进不来**。
 * ⇒ 而 **GitHub 的 runner 在境外** ⇒ ⇒ **实测能直连 t.me 并抓到 208 条/轮**。
 *
 * ⇒ 所以分工是：**Actions 只负责「把原文抓到手」**，翻译/去重/入库**仍在云托管**
 * （那里有 Supabase 与翻译 Key）⇒ ⇒ **零 schema 改动、零新数据库对象**。
 *
 * ## 用法
 *
 *   INGEST_URL=https://<服务域名>/api/telegram-ingest \
 *   INGEST_SECRET=<与云托管环境变量 TELEGRAM_INGEST_SECRET 一致> \
 *   npx tsx scripts/fetch-telegram.ts
 *
 * ### 为什么**不能**「直接写 Supabase」
 *
 * 实测确认：**push 的选稿没有「必须中文标题」的闸**（`MIN_HAN_TITLE` 不在 push 里）
 * ⇒ ⇒ 未翻译的俄文标题稿子会被**原样选进日报** ⇒ ⛔ 绝对不行。
 * ⇒ ⇒ 必须让云托管来翻译 ⇒ ⇒ 走 ingest 接口。
 *
 * ## 行为细节（都是踩过的坑）
 *
 * · **每个频道之间 sleep 2 秒** —— 12 个频道从同一个 IP 连续抓 ⇒ 会被 Telegram 限流。
 * · **按频道逐个 POST**（不是一次全发）—— 一个频道失败不影响其余 11 个。
 * · **重复提交要幂等** —— ingest 接口按 `url` 去重 ⇒ Actions 重跑不会重复入库。
 * · **失败要打出来** —— 频道名写错时 t.me 返回 **200 + 空列表**（不报错），
 *   症状是「静默地少了一个频道」⇒ ⇒ 所以每个频道的结果都要打印。
 */
import { DEFAULT_TELEGRAM_CHANNELS, parseTelegramChannels } from '../src/lib/telegram-channels';
import { fetchTelegramPreviewDirect } from '../src/lib/telegram-preview';

const INGEST_URL = process.env.INGEST_URL || '';
const INGEST_SECRET = process.env.INGEST_SECRET || '';
/** 每个频道之间的间隔（毫秒）—— 防 Telegram 限流。 */
const CHANNEL_GAP_MS = 2000;

interface IngestResult {
  ok: boolean;
  accepted?: number;
  translated?: number;
  inserted?: number;
  failed?: number;
  /** ★ 接口是**异步**的 ⇒ 正常返回是 `{ queued: true, ... }`（202） */
  queued?: boolean;
  message?: string;
  error?: string;
}

async function postToIngest(channel: string, posts: unknown[]): Promise<IngestResult> {
  // ⚠️⚠️ **必须 catch**：网络层失败（DNS/连接重置/超时）会**抛异常**，
  // 而不 catch 的后果是**整个脚本崩掉** ⇒ ⇒ 第一个频道送不进去，
  // **后面 11 个频道全丢**（2026-10-26 第一次本地跑就撞到了：`fetch failed` 直接把脚本带崩）。
  // ⇒ 一个频道送不进去，**必须只影响它自己**。
  try {
    const res = await fetch(INGEST_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-ingest-secret': INGEST_SECRET,
      },
      body: JSON.stringify({ channel, posts }),
      // ⚠️ 60 秒足够：接口是**异步**的（立刻 202，翻译在云托管后台跑）
    // ⇒ ⇒ 这里等的是「排队成功」，不是「翻译完成」。
    // ⇒ ⚠️ 若超过 60 秒还没回来 ⇒ 说明接口在同步做（会撞网关的 ~30 秒预算）⇒ 报错。
    signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    try {
      return JSON.parse(text) as IngestResult;
    } catch {
      return { ok: false, error: `响应不是 JSON：${text.slice(0, 200)}` };
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function main(): Promise<void> {
  if (!INGEST_URL || !INGEST_SECRET) {
    console.error('✗ 缺 INGEST_URL 或 INGEST_SECRET（两者都必须配置）');
    process.exit(1);
  }
  const entries = parseTelegramChannels(DEFAULT_TELEGRAM_CHANNELS);
  console.log(`频道数：${entries.length}｜目标：${INGEST_URL}`);

  let grabbed = 0;
  let sent = 0;
  let failedChannels = 0;

  for (const e of entries) {
    // ⚠️⚠️ **0 条时必须重试一次**（2026-10-26 实测踩到）：
    // `@tengrinews` **同一分钟内**一次返回 20 条、一次返回 0 条
    // ⇒ ⇒ **t.me 预览页会偶发返回空**，而「频道名写错」也是 0 条
    // ⇒ ⇒ **两者必须用重试区分**：重试后仍是 0 才算「这个频道真的不行」。
    let r = await fetchTelegramPreviewDirect(e.channel, 15000);
    if (r.posts.length === 0) {
      console.log(`  ↻ ${e.channel} 首次 0 条，3 秒后重试一次（预览页会偶发返回空）`);
      await new Promise((s) => setTimeout(s, 3000));
      r = await fetchTelegramPreviewDirect(e.channel, 15000);
    }
    if (r.posts.length === 0) {
      // ⚠️ 频道名写错时 t.me 返回 **200 + 空列表**、不报错 ⇒ 只能靠打印发现。
      console.warn(`⚠ ${e.country} ${e.channel} 抓到 0 条（频道名可能失效，或那天没更新）`);
      failedChannels++;
      await new Promise((s) => setTimeout(s, CHANNEL_GAP_MS));
      continue;
    }
    grabbed += r.posts.length;
    const newest = r.posts[0]?.date?.slice(0, 10) ?? '-';
    const res = await postToIngest(e.channel, r.posts);
    if (res.ok) {
      sent += r.posts.length;
      console.log(
        `✓ ${e.country} ${e.channel} 抓到 ${r.posts.length} 条（最新 ${newest}）` +
          `⇒ 已排队${res.queued ? '（异步处理中，翻译在云托管后台跑）' : ''}` +
          (res.message ? `｜${res.message}` : ''),
      );
    } else {
      failedChannels++;
      console.warn(`✗ ${e.country} ${e.channel} 抓到了但送不进去：${res.error}`);
    }
    await new Promise((s) => setTimeout(s, CHANNEL_GAP_MS));
  }

  console.log(
    `\n★ 抓取 ${grabbed} 条｜已排队 ${sent} 条｜异常频道 ${failedChannels} 个` +
      `（翻译与入库在云托管后台跑 ⇒ 结果看 GET /api/telegram-ingest）`,
  );
  // ⚠️ 一条都没抓到 ⇒ **必须失败**（否则 cron 会静悄悄地跑空，白跑一天）
  if (grabbed === 0) {
    console.error('✗ 一个频道都没抓到 ⇒ 判定失败（不静默通过）');
    process.exit(1);
  }
}

main();
