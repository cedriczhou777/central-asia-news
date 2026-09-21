# 项目上下文

### 版本技术栈

- **Framework**: Next.js 16 (App Router)
- **Core**: React 19
- **Language**: TypeScript 5
- **UI 组件**: shadcn/ui (基于 Radix UI)
- **Styling**: Tailwind CSS 4

## 目录结构

```
├── public/                 # 静态资源
├── scripts/                # 构建与启动脚本
│   ├── build.sh            # 构建脚本
│   ├── dev.sh              # 开发环境启动脚本
│   ├── prepare.sh          # 预处理脚本
│   └── start.sh            # 生产环境启动脚本
├── src/
│   ├── app/                # 页面路由与布局
│   ├── components/ui/      # Shadcn UI 组件库
│   ├── hooks/              # 自定义 Hooks
│   ├── lib/                # 工具库
│   │   └── utils.ts        # 通用工具函数 (cn)
│   └── server.ts           # 自定义服务端入口
├── next.config.ts          # Next.js 配置
├── package.json            # 项目依赖管理
└── tsconfig.json           # TypeScript 配置
```

- 项目文件（如 app 目录、pages 目录、components 等）默认初始化到 `src/` 目录下。

## 包管理规范

**仅允许使用 pnpm** 作为包管理器，**严禁使用 npm 或 yarn**。
**常用命令**：
- 安装依赖：`pnpm add <package>`
- 安装开发依赖：`pnpm add -D <package>`
- 安装所有依赖：`pnpm install`
- 移除依赖：`pnpm remove <package>`

### ⚠️ 用到「传递依赖」时必须先提升为直接依赖

pnpm 默认是**隔离式链接**：只有 `package.json` 里**显式声明**的包才会在根 `node_modules`
建软链（自己验一下：`node -e "console.log(require('fs').readlinkSync('node_modules/rss-parser'))"`
→ 指向 `.pnpm/rss-parser@3.13.0/...`）。传递依赖只做**私有提升**到
`node_modules/.pnpm/node_modules/`，**根目录解析不到**。

**后果**：代码里写 `await import('sharp')`，而 sharp 只是某个包的 `optionalDependency` 时，
`next build` 的类型检查会报 `TS2307: Cannot find module 'sharp'` 并**直接让构建失败**。

**已踩过**：`sharp` 原本只是 `next` 的 optionalDependency。2026-09-18 线上连续 5 个提交
（`6f85900`…`fcdaf94`）一个都没部署上去，全是这个原因 —— 而本地 `pnpm build` 却能过，
因为本机 `node_modules` 早先被 npm 装过、依赖被拍平了，把差异掩盖了。
**所以「本地能构建」不能证明云端能构建。**

**规矩**：任何在 `src/` 里被 `import` 的包，都必须在 `package.json` 里显式声明。
`scripts/build.sh` 在装完依赖后会跑一次 `require.resolve` 预检，
解析不到就打 `[FATAL]` 把原因说清楚（不 exit 1，成败交给后面的 `next build`）。

### corepack 交互式确认（本地必踩）

`package.json` 里锁了 `packageManager: pnpm@9.0.0`。若本机 pnpm 版本与它不一致，
corepack 会先下载指定版本，并**弹一个交互式确认**：

```
! Corepack is about to download https://registry.npmjs.org/pnpm/-/pnpm-9.0.0.tgz
? Do you want to continue? [Y/n]
```

在脚本/CI/容器里没人回答这一问，就会永久停在原地（表现为「命令跑着跑着没反应了」）。

- `scripts/dev.sh` 与 `scripts/build.sh` 已在脚本内置 `COREPACK_ENABLE_DOWNLOAD_PROMPT=0`，走脚本不受影响。
- 但**外层** `pnpm <script>` 由你自己 shell 里的 pnpm shim 处理，脚本内的设置管不到它。
  首次卡住时任选其一：
  - 直接调脚本：`bash scripts/dev.sh`（绕过外层 shim）
  - 或给当前 shell 加：`export COREPACK_ENABLE_DOWNLOAD_PROMPT=0`
  - 或一次性激活锁定版本：`corepack prepare pnpm@9.0.0 --activate`

### 本地校验命令

| 命令 | 作用 | 需要 Key |
| --- | --- | --- |
| `pnpm verify:local` | 类型检查 + 频道解析用例，**提交前先跑这个** | 否 |
| `pnpm ts-check` | 全量 TypeScript 类型检查 | 否 |
| `pnpm test:channels` | `TELEGRAM_CHANNELS` 解析用例（12 条） | 否 |
| `pnpm test:translate` | 真实调一次翻译模型 | **是** |
| `pnpm lint:build` | ESLint | 否 |

## 开发规范

### 编码规范

- 默认按 TypeScript `strict` 心智写代码；优先复用当前作用域已声明的变量、函数、类型和导入，禁止引用未声明标识符或拼错变量名。
- 禁止隐式 `any` 和 `as any`；函数参数、返回值、解构项、事件对象、`catch` 错误在使用前应有明确类型或先完成类型收窄，并清理未使用的变量和导入。

### next.config 配置规范

- 配置的路径不要写死绝对路径，必须使用 path.resolve(__dirname, ...)、import.meta.dirname 或 process.cwd() 动态拼接。

### Hydration 问题防范

1. 严禁在 JSX 渲染逻辑中直接使用 typeof window、Date.now()、Math.random() 等动态数据。**必须使用 'use client' 并配合 useEffect + useState 确保动态内容仅在客户端挂载后渲染**；同时严禁非法 HTML 嵌套（如 <p> 嵌套 <div>）。
2. **禁止使用 head 标签**，优先使用 metadata，详见文档：https://nextjs.org/docs/app/api-reference/functions/generate-metadata
   1. 三方 CSS、字体等资源可在 `globals.css` 中顶部通过 `@import` 引入或使用 next/font
   2. preload, preconnect, dns-prefetch 通过 ReactDOM 的 preload、preconnect、dns-prefetch 方法引入
   3. json-ld 可阅读 https://nextjs.org/docs/app/guides/json-ld

## UI 设计与组件规范 (UI & Styling Standards)

- 模板默认预装核心组件库 `shadcn/ui`，位于`src/components/ui/`目录下
- Next.js 项目**必须默认**采用 shadcn/ui 组件、风格和规范，**除非用户指定用其他的组件和规范。**

## 项目概述

中亚投资资讯 - 面向中国投资者的中亚与南高加索商业新闻聚合平台。

### 目标用户
有意在中亚与南高加索五国（哈萨克斯坦、乌兹别克斯坦、吉尔吉斯斯坦、阿塞拜疆、塔吉克斯坦）投资的中国投资商。

> 覆盖范围说明：阿塞拜疆地理上属南高加索，但在里海能源与「中间走廊」上和中亚是同一条线，
> 2026-09-18 按需求替换掉了原先的土库曼斯坦。

### 内容覆盖
- 涵盖 16 个分类：政治、经济、政策、法律、社会、人文、医疗卫生、能源、化工、矿产、基建、住建、制造业、民生、国安、交通
- 分类定义在 `src/lib/data/categories.ts`（label + color），`Category` 类型在 `src/lib/data/types.ts`
- 抓取端 `fetch-news/route.ts` 的 `CATEGORY_KEYWORDS` 按英文关键词自动归类（`classifyCategory`）
- 新闻来源：各国主流媒体、Telegram（经 Cloudflare Worker）、社交媒体

## 关键入口

### 数据链路（仅公众号推送，已取消网页端）
- 抓取 → 翻译 → 入库 → 推送公众号草稿

### API 路由
- `POST /api/fetch-news` - 从 RSS 源抓取新闻并用 LLM 翻译（正文≤300字、完整收尾、无省略号）
- `POST /api/wechat/push` - 推送文章到微信公众号草稿箱（"今日精选投资资讯"，每国按实际可用量推送，正文只留主体）
- `POST /api/daily-digest` - 生成今日摘要（按国别汇总）
- `POST /api/pipeline` - 一键执行完整流程（抓取 → 翻译 → 入库 → 生成摘要 → 推送草稿）
- `GET /api/articles` - 文章列表（保留供调试）

### 数据层
- **数据库**: Supabase PostgreSQL，表 `articles`
- `src/lib/db-articles.ts` - 数据库 CRUD 操作
- `src/storage/database/shared/schema.ts` - Drizzle ORM schema
- `src/lib/data/types.ts` - 类型定义
- `src/lib/data/countries.ts` - 国家数据
- `src/lib/data/categories.ts` - 分类数据
- `src/lib/data/sources.ts` - 新闻来源

### 设计风格（公众号排版配色）
- 主色：深藏青 #0F1B2D（权威、信任）
- 辅助色：丝路金 #C8A45C（财富、机遇）
- 背景色：羊皮白 #F8F6F1

## 图片链路（重要）

- 数据库 `articles` 表的 `cover_image`/`image_urls` 字段因 Supabase schema cache 问题被废弃，插入时被移除。
- 图片 URL 改为**嵌入 `content`（contentZh）正文开头**：`fetch-news` 在翻译后把首图拼为 `<img src="..." referrerpolicy="no-referrer" />\n\n正文`（见 `src/app/api/fetch-news/route.ts`）。
- 渲染层通过 `src/lib/utils.ts` 的 `extractFirstImage`/`splitContentImage` 从 content 提取首图、剥离图片标签。
- 公众号推送：`src/app/api/wechat/push/route.ts` 用 `extractFirstImage(a.content)` 兜底取封面。
- 图片 URL 常带 `referrerpolicy="no-referrer"`，前端/公众号 `<img>` 同样加该属性，规避源站防盗链。

## 翻译保中文（重要）

- **部分国家（哈萨克、吉尔吉斯等）曾推送英文原文**：根因是 LLM 翻译失败/JSON 解析失败后，抓取侧静默把原文入库，推送又被优选出去。
- **翻译逻辑已抽到 `src/lib/translate.ts`（`translateNews`）**：多模型降级链，按序尝试智谱（GLM，`ZHIPU_API_KEY`，默认型号 `glm-4.7-flash`，免费档）→ DeepSeek（`DEEPSEEK_API_KEY`，默认型号 `deepseek-flash`）；每个模型最多重试 3 次（指数退避）+ 多策略 JSON 解析；全部失败才按失败处理。
- **通道定义已导出为 `PROVIDERS`**，`scripts/test-translate.ts` 直接读它打印「已配置通道 + 型号」——**型号只在一处定义**，避免代码改了脚本/文档还写旧名字。
- **⚠️ 型号代号是易腐的**：`deepseek-chat` 已被官方下线（2026-09 查 `https://api-docs.deepseek.com/quick_start/pricing`，在售的只有 `deepseek-flash` / `deepseek-v4-pro`）；`daily-digest` 里也曾写死过 `glm-4`。**用错型号不会报错到用户面前**，只在日志留一行 `[deepseek/xxx] 请求失败 400`，降级链等于没有。加凭据类配置时**必须顺手核对型号**。
- **模型名可通过环境变量覆盖**（`ZHIPU_MODEL` / `DEEPSEEK_MODEL`），厂商调整型号代号时不需要改代码。
- **未配置 Key 的通道会被直接跳过**，不做无意义重试；启动日志里会打印「以下翻译通道未启用」。
- **已移除扣子专属依赖 `coze-coding-dev-sdk`**（原豆包降级通道），备用模型不再绑定扣子平台。
- **本地自测**：`pnpm tsx scripts/test-translate.ts`（在 `.env.local` 里配好 Key 后运行），只验证模型调用与中文解析，不碰数据库和微信接口。
- **入库端**（`fetch-news/route.ts`）：翻译结果必须通过 `isChineseText` 校验（标题+正文中文字符占比达标才视为成功），否则 `translated=false` 且**跳过该篇不入库**（`continue`），绝不把原文写入 content。
- **推送端**（`wechat/push/route.ts`）：精选前用 `isChineseText(a.title) && isChineseText(a.content)` 过滤非中文文章，历史英文数据也不会被推送。
- 搭配工具：`src/lib/utils.ts` 的 `isChineseText(text, threshold=0.4)`，中文字符占比达到阈值即视为中文。

## 抓取放宽与内容去重（重要，曾因过严导致每国不足15篇）

- **日期窗口**（`fetch-news/route.ts`）：`targetDate` 默认回溯最多 2 天（当天及前 1 天），放宽超时，不再严格限制当日。
- **智能国家判定**：RSS 源自身按国别归属 `source.country`；正文缺失国名关键词时不再硬筛，仅过滤明确指向他国的内容（`isCountryRelevant` 放宽为"无明确他国指向即按源归属放行"）。
- **内容级去重**：统一入口是 `src/lib/same-event.ts` 的 `dedupeStories()`，**入库端与推送端共用同一个**（不要各写一套）。三层判据：
  1. `same_url` —— `utils.canonicalUrl()` 归一化后的链接相同（去掉 `?from=rss` / `utm_*` / 末尾斜杠 / `www.`）。**这是主力判据。**
  2. `same_original` —— 原文标题指纹相同（`utils.originalTitleKey()`），用于「同一篇原文挂在两个不同链接下」。
  3. `llm_same_event` —— 模型判「表述不同、实际是同一件事」，每国 1 次调用，走 `translate.ts` 的免费优先降级链；不可用时自动降级为只做 1、2。
     形态是 **`pair`（逐对二选一）**，不是 `group`（在一长串里找组）。`group` 实测两次都失败：关 thinking 时模型把所有下标都列出来，开 thinking 时按**话题**而非事件归并（哈萨克把「聚乙烯工厂」与「节水灌溉面积」并成一组）。改为 pair 后模型只有**否决权** —— 候选对由确定性判据（标题相似度 ≥0.35）先召回，模型只能说「这两条不是同一件事」，误判的后果从「误删」变成「漏合并」，方向是安全的。
     ⚠️ **`SAME_EVENT_JUDGE` 默认关闭**（`on`/`1`/`true` 才开）。默认必须是「不合并」：误合并是丢信息且不可逆。打开前先用 `GET /api/dedupe-check?llm=1&debug=1` 看模型逐对的判定。
  另有 `same_text` 兜底（标题+正文**几乎逐字相同**才成立，阈值 0.9/0.8）。
  ⚠️ 历史上的 `utils.isDuplicateContent`（标题 0.8 / 平均 0.6）已**不再用于去重**：实测在 200 篇与 1000 篇两份线上快照上零触发，却会误合并「金价下跌」与「金价上涨」这类方向相反的新闻。函数保留在 `utils.ts` 里但无调用点，别再把它接回去。
  **反向极性对在问模型之前就被确定性拦掉**（`hasOppositePolarity`）：「金价下跌」vs「金价上涨」相似度 0.71、排在候选表第一位，是字面最像的假阳性，方向词是封闭集合没理由交给模型猜。⚠️ 这类对**没有**比例熔断兜底 —— 候选按相似度降序截断，真重复占多数是正常的（实测乌兹别克单轮 12 对里 11 对确实是同一件事），任何「判是比例过高就作废」的阈值都会误伤，别再加回来。
  回归：`pnpm test:dedup`（固定双向语料）、`pnpm test:dedup <线上数据.json>`（真实数据体检）、`pnpm tsx scripts/peek-pairs.ts <线上数据.json>`（只看召回：会把哪些对交给模型）、线上 `GET /api/dedupe-check`（只读报告）、`POST /api/dedupe-check {apply:true}`（清理存量重复行，默认 dry-run）。
- **每国篇数**：抓取端下限默认 `minPerCountry=10`（保证有内容可推）；推送端**不固定篇数**，"今日精选"按实际可用量推送（上限宽松 30 篇），不硬凑。

## 信息源与社交网络（重要）

- **真正生效的** RSS 源定义在 `src/app/api/fetch-news/route.ts` 的 `RSS_SOURCES`（按 `country: kz/uz/kg/az/tj/intl` 分组）；已补充大陆可访问的真实媒体源。
  `src/lib/data/sources.ts` 那份目录目前**没有任何地方引用**（barrel 也无人 import），改源不用碰它 —— 但 `types.ts` 的 `NewsSource` 联合类型必须与它对齐，否则 `tsc` 报错。
- **Telegram / Instagram / 公共 RSSHub 在大陆网络不可达**（本项目部署在微信云托管，`t.me`、`api.telegram.org`、`instagram.com` 均 `000`），**不能伪造社交集成**。
- **Telegram 通过 Cloudflare Worker 反向代理接入（已实现，配置驱动）**：
  - 链路：`微信云托管代码 → TELEGRAM_WORKER_URL（你的 Cloudflare Worker） → Telegram API → 返回给本项目`。
  - `src/lib/scraper.ts` 的 `fetchTelegramRSS(channelId)` 现**优先走 Worker**（`fetchTelegramByWorker`），无 Worker 时回退 RSSHub，均失败则丢篇。
  - 本项目在 fetch-news 主流程（`src/app/api/fetch-news/route.ts`）**新增 Telegram 补充段**：读 `TELEGRAM_CHANNELS` 环境变量，**只有配置了 `TELEGRAM_WORKER_URL` 才启用**，抓到的文章走同样优选/翻译/入库链路，帮助凑齐每国篇数。
  - **频道配置格式**：`国家:频道[@频道...]`，多个国家用逗号分隔。例：`kz:@tengrinews, uz:@kunuzofficial@gazetauz` —— uz 会展开成 2 个频道；不带 `@` 的裸写法也支持。解析结果会打进日志（搜「Telegram 待抓取频道」），配错了一眼能看见。
  - 启用前提（微信云托管环境变量）：`TELEGRAM_WORKER_URL=<你的worker域名>` + `TELEGRAM_CHANNELS=kz:@xnxxx...` 等；未配置时自动跳过、不影响现有 RSS/爬虫链路。
  - Worker 脚本需在 Cloudflare 免费版部署，把请求转发到 `https://api.telegram.org` 的 `getUpdates`/`getChat`，按 channel 返回文本与日期（参考 scraper.ts 中 worker 期望的返回结构）。

## 定时任务

- `src/lib/scheduler.ts` 用 node-cron 注册 2 个任务（每天早上 08:00、晚上 19:00，Asia/Shanghai 时区），每次先抓取当天新闻（每国≥10篇）再推送公众号（"今日精选"按实际可用量推送）。
- **两次推送的回看窗口首尾相接、互不重叠**（改动原因见下）：早报回看 **13h**（昨日19:00→今日08:00），晚报回看 **11h**（今日08:00→今日19:00）。
  窗口与时段标记由 `PUBLISH_SCHEDULES` 给出，经 `runPublishCycle(hours, period)` 传给 `POST /api/wechat/push`。
- **旧版两个坑（已修，别再退回去）**：① 两次都用 `hours: 24`，中间 13 小时重叠 → 同一条新闻连着进两次推送；
  ② 草稿标题的日期用 `new Date().toISOString().split('T')[0]`（**UTC 日期**），北京 08:00 与 19:00 落在同一个 UTC 日 →
  同一天 5 国草稿标题完全相同，草稿箱里成对出现。现在日期改为 `Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Shanghai'})`，
  并在标题/digest 里加「早报 / 晚报」后缀（`periodSuffix()`）。
- **`/api/wechat/push` 的入参契约**：`{ hours?: number (默认24), period?: 'morning'|'evening' }`。
  不传 `period` → 标题不带后缀、窗口按传入 hours 走，用于人工补跑（`{"hours": 24}`）。
- 调试定时任务是否触发：运行日志搜「启动定时任务调度器」「触发公众号推送任务」「回看 N 小时」。
- **仅生产模式启动**：`src/server.ts` 在 `!dev`（NODE_ENV=production）时调用 `startScheduler()`；`scripts/start.sh` 设置 `NODE_ENV=production` 并 `node dist/server.js`。本地预览走 `scripts/dev.sh`（`next dev`），**不启动调度器**。
- 调试定时任务是否触发：运行日志搜「启动定时任务调度器」「触发公众号推送任务」。
- 曾出现早上未触发：旧版本运行时 `NODE_ENV` 非 production、`startScheduler` 未被调用，后已修复。部署后要等到下一个到点时间才会触发（cron 精确到点）。
- **`container.config.json` 的 triggers 只做「预热」**：该文件里 `container.minNum: 0` 表示实例可缩容到零，进程一停应用内定时器也就没了。所以挂了 2 条 warmup 触发器（北京 07:55 / 18:55）提前唤醒实例，真正干活的是应用内调度器。想让调度更可靠可把 `minNum` 改成 1（代价是常驻实例）。
- **不要**在 `container.config.json` 里再加业务触发器：旧版曾挂着 4 条 `{"action":"fetch-and-push"}` 的触发器，但代码里没有任何地方处理这个 payload，属于「看着在跑、其实没干活」，已清理。

## 日期口径（重要）

- **所有「今天」一律走 `src/lib/utils.ts` 的 `beijingDate()`**（`Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Shanghai'})`，返回 `YYYY-MM-DD`）。
- **不要再用 `new Date().toISOString().split('T')[0]`** —— 那是 UTC 日期，北京 00:00–08:00 会算成前一天。
  已经踩过的坑：草稿标题里的日期，以及日报/流水线不带 `date` 时的默认值。
- 例外并**故意保留**：`src/app/api/fetch-news/route.ts` 的 `targetDate` 默认值仍是 UTC 日期。
  原因：它要和 `item.pubDate` 转出来的（UTC）日期做 2 天窗口比较，两边同口径才自洽；
  且两次定时推送（北京 08:00 / 19:00）恰好都落在「北京日期 == UTC 日期」区间内，不受影响。
  **要动它得连 `itemDate` 的口径一起改。**

## 端口约定（重要）

- 全项目唯一的端口口径在 `src/lib/runtime.ts` 的 `resolvePort()`：`DEPLOY_RUN_PORT` → `PORT` → `3000`。
- `3000` 与 `container.config.json` 的 `container.port`、`Dockerfile` 的 `EXPOSE` 保持一致。
- ⚠️ **线上跑多少端口，由「控制台 → 云托管 → 服务设置 → 端口」决定，不是由仓库里这几个文件决定。**
  `container.config.json` 并不会被「Git 推送触发」这条流水线读取（2026-09-16 实测：文件写 3000，
  而探针实际打 5000，部署因此失败）。改端口时**必须同步改控制台**，否则容器按代码里的端口监听、
  平台按控制台的端口探活，表现为 `Liveness probe failed: connection refused`。
- `scripts/start.sh` 在拉起 node 前会把解析结果写回 `PORT`，因此进程内 `process.env.PORT` 已是最终值。
- **禁止**在业务代码里写死端口（旧版 `api/pipeline/route.ts` 写死 `localhost:5000`，与部署声明对不上就是静默失败）。需要内部互调请用 `resolveSelfBaseUrl()`。

## 公众号推送排版规范（重要）

- `src/app/api/wechat/push/route.ts`：推送标题「今日精选投资资讯」，每国按实际可用量推送（不固定 15），过去 24h；正文**只保留主体**，不显示"摘要"块。
- 正文默认以完整语句收尾，末尾省略号会被 `cleanSummary` 清理为句号；翻译 prompt 亦要求 ≤300 字、完整收尾、禁止省略号。
- 公众号排版：外层 padding 8px、内容卡片 padding 18px 16px、正文字号 16px、行距 2.0（已收窄左右留白、加宽正文）。分类标签颜色来自 `categories.ts`，中文标签与 16 类分类对齐。
