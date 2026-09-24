/**
 * 真正生效的 RSS 源清单。
 *
 * ## 为什么单独成模块（原先内联在 `app/api/fetch-news/route.ts` 里）
 *
 * 1. **脚本要能读到它。** 排查「某国今天为什么只有一两篇」时必须知道「这个国家
 *    到底铺了几个源、每个源是什么语言」——而 Route Handler 只能导出 Next.js
 *    规定的那几个名字，脚本没法 import。留在路由里，诊断脚本就只能靠正则去抠
 *    源码文本（脆弱、会漂移）。`scripts/analyze-source-language.ts` 就是靠这个
 *    模块才做得到的。
 * 2. `src/lib/data/sources.ts` 是**另一个**空壳占位（那个文件自己写了说明），
 *    历史上因此出现过「以为改了源、其实改的是没人读的那份」。这里合并成一份。
 *
 * ## `language` 字段是**声明值**，不是实测值
 *
 * `analyze-source-language.ts` 的实测结果已经证明它会标错（例：标 `az` 的源实测
 * 有好几个是俄文）。所以**别拿它当判据**去决定语言相关的处理分支 ——
 * 要判语言请用实测（`detectScript`）或按国别配置。它现在的用途只是给人看的标签。
 *
 * ## 加源/换源的纪律
 *
 * - 优先收录**大陆网络可达**的源。本项目部署在微信云托管（大陆），
 *   `api.telegram.org` / `t.me` / Instagram 都不可达 —— 见下面 Telegram 段的说明。
 * - 判断一个地址是不是真 RSS，**看 `Content-Type`，不要看能不能 curl 到 200**。
 *   已踩过两次：
 *   ① `centralasia.news/feed/` 返回 200 但是 47KB 的 HTML 网页（已移除）；
 *   ②（2026-09-22）`kg.akipress.org/rss` 与 `tazabek.kg/rss` **也是 200 + 网页** ——
 *   但成因不同：它们**按 `User-Agent` 返回**，认得 feed 阅读器 UA 才给真 XML。
 *   当时因为报错长得像 `Unexpected close tag`，被误记成「XML 畸形」。
 *   **现在取回统一走 `src/lib/feed-fetch.ts` 的 `fetchFeed`**，它会在拿到网页时报错并带上
 *   Content-Type（详见那个文件的头部 + AGENTS.md「源取回层」）。**别再在别处 new Parser。**
 * - **换源之后要复查健康度**：`pnpm analyze:feeds`（逐源报 Content-Type / 字节 / 条数 / UA）
 *   是**本机视角**；**容器视角**看 `GET /api/fetch-news` 的 `lastRun.sourceCounts`
 *   与 `sourceErrors`（按源给出 `fetched / afterDate / droppedJunk / droppedCountry /
 *   droppedTopic / candidates`）。`fetched=0` 是源不通；`droppedTopic` 接近 `fetched`
 *   要警惕语言问题（见 `analyze-source-language.ts`）。**两边都要看，两者实测会不一致。**
 * - 2026-09-19 实测死源（404/410，已移除，**别加回来**）：
 *   `kabar.kg/rus/rss`(410)、`24.kg/rss/all`(404)、`24.kz/rss`(404)、
 *   `tengrinews.kz/rss_news/all.xml`(404)、inform.kz 的 english rss(404)、
 *   kun.uz(无 RSS 接口)、daryo.uz(feed 空壳)。
 * - 被 Cloudflare 拦、从本机返回 403 的阿塞拜疆媒体**别加**：
 *   azernews.az / oxu.az / 1news.az / minval.az / news.day.az / musavat.com / report.az。
 *   （2026-09-19 补测：abc.az / turan.az / news.az / sfera.az 均 404；
 *   interfax.az / aze.media 不可达。）
 *
 * ## 2026-09-24 大批量候选探测（`pnpm probe:feeds`，31 个候选）
 *
 * 起因是用户提的假设：「经常重复、还重叠，归根结底是信息源不够多」。
 * 先把「到底缺多少」量出来再动手 —— 38 个已配条目里 **13 个是死的（34%）**：
 * 12 个 Telegram（容器到不了 `*.workers.dev`，卡在用户侧）+ `AKIpress`（容器侧 60s 超时）。
 * 再跑候选探测，**11 个可用**，已按「哪国真正薄」收录（见下面各段）。
 *
 * ⚠️ **探测结果不是「可用就收」**：收录决策按国家缺口来，理由写在下面各段。
 *
 * 实测**不可用，别再加**（2026-09-24，本机视角；带的问题是「不是 feed」）：
 *   - 404：`kapital.kz/rss`、`zakon.kz/rss`、`kase.kz/en/news/rss/`、`akchabar.kg/feed/`、
 *     `xs.uz/ru/rss`、`president.uz/ru/rss`、`aniq.uz/feed`
 *   - 403：`informburo.kz/rss`
 *   - 500：`kyrtag.kg/feed/`
 *   - 200 但是**网页**：`cabar.asia/feed`、`sadoimardum.tj/feed/`
 *   - 通了但 **0 条目**（RSS 接口空壳）：`rus.ozodi.org/api/zrqiteuuir`、
 *     `ozodi.org/api/zrqiteuuir`、`avesta.tj/en/feed/`
 *   - 本机 25s 超时，**未定论**（收录后会从容器侧再见一次）：
 *     `eurasianet.org/rss.xml`、`forbes.kz/rss/all/`、`akhbor.com/feed/`、
 *     `faraj.tj/feed/`、`nhk.tj/feed/`、`pamir-news.tj/feed/`
 *   - **重复**：`www.vesti.kg/rss` 与已有的 `vesti.kg/rss` 是同一个源
 *     （探针第一版没归一化 `www.` 才把它报成新源 —— 已修）。
 */

export interface RSSSource {
  name: string;
  url: string;
  country: string;
  /** 声明语言（**不可靠**，见文件头说明）。 */
  language: string;
}

export const RSS_SOURCES: RSSSource[] = [
  // 哈萨克斯坦
  { name: 'The Astana Times', url: 'https://astanatimes.com/feed/', country: 'kz', language: 'en' },
  { name: 'Egemen Qazaqstan', url: 'https://egemen.kz/rss/', country: 'kz', language: 'kk' },
  { name: 'Newtimes.kz', url: 'https://newtimes.kz/rss/', country: 'kz', language: 'ru' },
  { name: 'Inbusiness.kz', url: 'https://inbusiness.kz/rss', country: 'kz', language: 'ru' },
  { name: 'Total.kz', url: 'https://total.kz/rss', country: 'kz', language: 'ru' },
  // 2026-09-24 加。kz 本来不缺条数（128 条候选，全项目第二多），加这两个是**换质量**不是换量：
  // Tengrinews 是最大民营通讯社（旧路径 `rss_news/all.xml` 已 404，`news.rss` 实测 102 条 / 当日）；
  // Kursiv 是财经媒体，直接对上本项目的 investorRelevant 判定。
  { name: 'Tengrinews', url: 'https://tengrinews.kz/news.rss', country: 'kz', language: 'ru' },
  { name: 'Kursiv.kz', url: 'https://kz.kursiv.media/feed/', country: 'kz', language: 'ru' },

  // 乌兹别克斯坦（2026-09-24 从 4 源扩到 8 源：uz 只有 41 条候选，属于偏薄的一档）
  { name: 'UzA', url: 'https://uza.uz/rss/', country: 'uz', language: 'ru' },
  { name: 'Gazeta.uz', url: 'https://www.gazeta.uz/rss', country: 'uz', language: 'ru' },
  { name: 'Spot.uz', url: 'https://spot.uz/rss/', country: 'uz', language: 'ru' },
  { name: 'Uznews.uz', url: 'https://uznews.uz/rss/', country: 'uz', language: 'ru' },
  { name: 'Podrobno.uz', url: 'https://podrobno.uz/rss/', country: 'uz', language: 'ru' },
  // UzDaily 是英语商业新闻 —— 原文就是英文，省掉一次翻译，对投资者最直接。
  { name: 'UzDaily', url: 'https://www.uzdaily.uz/en/rss', country: 'uz', language: 'en' },
  { name: 'NUZ.uz', url: 'https://nuz.uz/feed/', country: 'uz', language: 'ru' },
  { name: 'Review.uz', url: 'https://review.uz/ru/rss', country: 'uz', language: 'ru' },

  // 吉尔吉斯斯坦（2026-09-19 换血：旧的两个源 410/404 已死）
  { name: 'Kabar', url: 'https://kabar.kg/rss', country: 'kg', language: 'ky' },
  { name: 'AKIpress', url: 'https://kg.akipress.org/rss', country: 'kg', language: 'ru' },
  { name: 'Vesti.kg', url: 'https://vesti.kg/rss', country: 'kg', language: 'ru' },
  { name: 'Tazabek', url: 'https://tazabek.kg/rss', country: 'kg', language: 'ru' },
  { name: 'Economist.kg', url: 'https://economist.kg/rss', country: 'kg', language: 'ru' },
  // 2026-09-24 加。Kloop 是调查报道（换质量，不是换量）。kg 有 113 条候选、**不缺条数**，
  // 所以 `turmush.kg`（地方新闻、纯增量）故意**没收** —— 同一批候选里
  // 「建议收录」的有 11 个，但收录决策按国家缺口来，见文件头。
  { name: 'Kloop', url: 'https://kloop.kg/feed/', country: 'kg', language: 'ru' },
  // ⚠️ Sputnik 吉尔吉斯这条是**补偿性收录**：配置里那条 Telegram 频道
  // `@sputnik_kyrgyzstan` 目前抓不到（容器到不了 workers.dev），RSS 是同一个编辑部的
  // 公开接口、当日 100 条。**等 Telegram 那条救活后会变成同一家媒体跑两遍** ——
  // 不过那是同一个编辑部、同一批稿件，L0/L1（canonical URL + 原标题指纹）本来就该合并掉，
  // 风险远低于「这条渠道整个是死的」。
  { name: 'Sputnik Kyrgyzstan', url: 'https://sputnik.kg/export/rss2/archive/index.xml', country: 'kg', language: 'ru' },

  // 塔吉克斯坦（**全项目最薄：只有 18 条候选、3 个可用源**，优先补的就是这里）
  { name: 'Khovar', url: 'https://khovar.tj/rss/', country: 'tj', language: 'ru' },
  { name: 'Asia-Plus', url: 'https://asiaplustj.info/rss/', country: 'tj', language: 'ru' },
  { name: 'Avesta', url: 'https://avesta.tj/rss/', country: 'tj', language: 'ru' },
  // 2026-09-24 加。实测 100 条 / 当日，是本次探测里对 tj 最有效的一条。
  // 注释：配置里的 `@sputnik_tajikistan`（Telegram）同样是抓不到的死频道，这是它的 RSS 替代。
  { name: 'Sputnik Tajikistan', url: 'https://tj.sputniknews.ru/export/rss2/archive/index.xml', country: 'tj', language: 'ru' },

  // 阿塞拜疆
  // 下面每个 URL 都逐个实测过（HTTP 200 且能解析出 item）。
  //
  // ⚠️ **2026-09-24 明确决定：az 不再加源，即使探到可用的。**
  // 理由是可量化的：az 已有 8 个 RSS 源（全项目最多），而用户报的重复
  // （同一条 Unibank 绿色信贷被三家 az 媒体各写一篇）**正是多源的产物**。
  // 给 az 加源只会让 L2 的漏合并更显眼，不会减少重复。
  // → 结论：**先修去重，再扩源**；扩源要挑真正薄的国家（tj / uz），不是均匀铺。
  { name: 'AZERTAC', url: 'https://azertag.az/en/rss', country: 'az', language: 'en' },
  { name: 'AZERTAC (ru)', url: 'https://azertag.az/ru/rss', country: 'az', language: 'ru' },
  { name: 'Trend.az', url: 'https://www.trend.az/rss/', country: 'az', language: 'en' },
  { name: 'APA', url: 'https://apa.az/rss', country: 'az', language: 'az' },
  { name: 'Haqqin.az', url: 'https://haqqin.az/rss', country: 'az', language: 'ru' },
  { name: 'Qafqazinfo', url: 'https://qafqazinfo.az/rss', country: 'az', language: 'az' },
  { name: 'Modern.az', url: 'https://modern.az/rss', country: 'az', language: 'az' },
  { name: 'Banker.az', url: 'https://banker.az/feed/', country: 'az', language: 'az' },

  // 区域综合媒体
  { name: 'The Times of Central Asia', url: 'https://timesca.com/feed/', country: 'intl', language: 'en' },
  // 曾经的 'Central Asia News'（centralasia.news/feed/）已于 2026-09-20 移除：
  // 该地址返回的 Content-Type 是 text/html（47KB 的网页，不是 feed）。
];
