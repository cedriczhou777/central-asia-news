import { NextRequest, NextResponse } from 'next/server';
import { getArticles, getArticleById, type ArticleRow } from '@/lib/db-articles';

/**
 * 断言某个字段**被 select 出来了**。
 *
 * 这条断言存在的唯一理由是区分两种「空」：
 *
 * - 库里这一列的值是 `NULL` → PostgREST 返回 `null`，**字段在**，这是正常数据；
 * - 查询的 `select(...)` 里根本没写这一列 → `row.x` 是 `undefined`，而
 *   `JSON.stringify` 会把 `undefined` 的键**整个丢掉** ⇒ 接口返回里连字段名都没有。
 *
 * 后者是本项目 2026-10-05 真实发生的事故：`getArticles` 的选择列漏了
 * `original_content`，`rowToApi` 照常返回 `undefined`，接口没报错、只是少一个键，
 * 于是 `scripts/diagnose-push-window.ts` 把五国**全部**条目判成「无原文正文」，
 * 打印出一份「五国都出不了草稿」的假漏斗（详见 `db-articles.ARTICLE_COLUMNS`）。
 *
 * `undefined` 在这张表上**只可能**意味着「没 select」，所以这里抛错是精确的，
 * 不是防御性编程。抛出去会被本路由的 `catch` 变成 500 + 明确信息 ——
 * 宁可接口响亮地挂，也不要它安静地少一个字段。
 */
function requiredColumn<T>(value: T | undefined, column: string): T {
  if (value === undefined) {
    throw new Error(
      `articles 查询没有返回 \`${column}\` 列（值为 undefined，不是 null）——` +
        `检查 db-articles.ts 的 ARTICLE_COLUMNS；这条字段被漏掉时接口不会报错，` +
        `只会静默丢掉这个键，让下游诊断得出相反结论。`,
    );
  }
  return value;
}

function rowToApi(row: ArticleRow) {
  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    content: row.content,
    country: row.country_code,
    category: row.category,
    source: row.source_name,
    sourceUrl: row.source_url,
    /**
     * 原文标题（2026-10-05 加）—— `identityKeys` 的 `orig:` 那一刀用的就是它。
     *
     * 加之前，诊断脚本只能按链接判重，比生产**少**剔一部分（生产还有原文标题指纹
     * 那一刀），所以 `diagnose-push-window` 报的「进精选篇数」一直是**上限**。
     * 补上之后诊断与生产的身份判据才真正同一套。
     */
    originalTitle: requiredColumn(row.original_title, 'original_title'),
    /**
     * 原文正文（2026-10-02 加）。
     *
     * 为什么这个字段必须出现在这里：`scripts/diagnose-push-window.ts` 靠这个接口
     * 复现「推送那一刻的漏斗」，而推送侧新增的第 0 条闸（`hasSourceBody`）判的正是
     * 这个字段。不返回它，诊断脚本就只能把这个计数**恒定显示成 0** ——
     * 那正是本项目栽过的那类坑（诊断与生产不一致 ⇒ 得出相反结论，见
     * `article-format.pushExclusionReason` 注释里的事故三）。
     *
     * 安全性：它就是源站公开发布的正文文本，本来也随 `sourceUrl` 可查；
     * 体积上实测多为 RSS 导语（中位数约 200 字），对列表接口可忽略。
     */
    originalContent: requiredColumn(row.original_content, 'original_content'),
    publishedAt: row.published_at,
    tags: row.tags || [],
    isFeatured: row.is_featured,
    /**
     * **入库时刻**（2026-10-18 加）。
     *
     * ## 为什么加它
     *
     * 之前所有关于「这一轮跑了多久」的读数都只能从 `GET /api/wechat/push` 的
     * `lastRun.finishedAt` 拿，而那是**进程内存态** —— 定时扩缩容窗口一关、
     * 实例被回收，读数就没了（这个项目已经因此连续三次丢数据：10-17 的轮次耗时、
     * 10-16 与 10-17 的 `dupDrops`/`dupBudget`/`rejections`）。
     *
     * `created_at` 是**数据库里的列**，写进去就一直在 ⇒
     * **随时都能读，不依赖「有人恰好在窗口内」。**
     *
     * ## ⚠️ 它是**一个值**，不是一段区间（2026-10-18 实测更正）
     *
     * 原先这里写的是「`min` ≈ 入库开始、`max` ≈ 入库结束」——**那是错的**。
     * 实测 10-18 那一批的 **201 条全部共用同一个值**（`2026-10-18 05:53:29` 北京），
     * 因为它们是**同一条 INSERT 批量写入**、时间戳由数据库按语句统一赋值。
     *
     * ## 它能回答什么、不能回答什么
     *
     * · ✅ **入库那一刻的时刻** ⇒ 「抓取 + 翻译 + 入库」这一大段跑完了。
     *   2026-10-18 那一轮实测：入库 `05:53:29`，而日志里保活停止在 `05:58:35`
     *   ⇒ 抓取段 **113 分钟**、含推送 **119 分钟**（两边完全自洽）。
     * · ⚠️ **它不含推送**：草稿是入库之后另做的一步（实测那一步约 5–8 分钟）。
     *   要拿含推送的精确耗时，仍然要在窗口内读 `lastRun.finishedAt` —— 但那时
     *   「够不够窗口」这个判断已经能用入库时刻回答了。
     */
    createdAt: row.created_at,
  };
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const country = searchParams.get('country') || undefined;
  const category = searchParams.get('category') || undefined;
  const date = searchParams.get('date') || undefined;
  const limit = searchParams.get('limit') ? parseInt(searchParams.get('limit')!) : undefined;
  const id = searchParams.get('id');

  try {
    if (id) {
      const article = await getArticleById(parseInt(id));
      if (!article) {
        return NextResponse.json({ error: '文章不存在' }, { status: 404 });
      }
      return NextResponse.json(
        { article: rowToApi(article) },
        {
          headers: {
            'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0',
          },
        },
      );
    }

    const articles = await getArticles({
      country_code: country,
      category,
      date,
      limit,
    });
    return NextResponse.json(
      { articles: articles.map(rowToApi), count: articles.length },
      {
        headers: {
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0',
        },
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
