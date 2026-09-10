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

中亚投资资讯 - 面向中国投资者的中亚五国商业新闻聚合平台。

### 目标用户
有意在中亚五国（哈萨克斯坦、乌兹别克斯坦、吉尔吉斯斯坦、土库曼斯坦、塔吉克斯坦）投资的中国投资商。

### 内容覆盖
- 政治、经济、政策、工商税法
- 投资领域：能源、化工、矿产、基建、房地产、制造业
- 新闻来源：各国主流媒体、社交媒体

## 关键入口

### 数据链路（仅公众号推送，已取消网页端）
- 抓取 → 翻译 → 入库 → 推送公众号草稿

### API 路由
- `POST /api/fetch-news` - 从 RSS 源抓取新闻并用 LLM 翻译（正文≤300字、完整收尾、无省略号）
- `POST /api/wechat/push` - 推送文章到微信公众号草稿箱（每国精选15篇，正文去摘要只留主体）
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
- **翻译逻辑已抽到 `src/lib/translate.ts`（`translateNews`）**：多模型降级链，按序尝试智谱（GLM，`ZHIPU_API_KEY`）→ 豆包（动态 import `coze-coding-dev-sdk` 的 `LLMClient`，模型 `doubao-seed-2-0-lite`）；每模型内部最多重试 3 次 + 多策略 JSON 解析；全部失败才按失败处理。
- **入库端**（`fetch-news/route.ts`）：翻译结果必须通过 `isChineseText` 校验（标题+正文中文字符占比达标才视为成功），否则 `translated=false` 且**跳过该篇不入库**（`continue`），绝不把原文写入 content。
- **推送端**（`wechat/push/route.ts`）：精选前用 `isChineseText(a.title) && isChineseText(a.content)` 过滤非中文文章，历史英文数据也不会被推送。
- 搭配工具：`src/lib/utils.ts` 的 `isChineseText(text, threshold=0.4)`，中文字符占比达到阈值即视为中文。

## 抓取放宽与内容去重（重要，曾因过严导致每国不足15篇）

- **日期窗口**（`fetch-news/route.ts`）：`targetDate` 默认回溯最多 2 天（当天及前 1 天），放宽超时，不再严格限制当日。
- **智能国家判定**：RSS 源自身按国别归属 `source.country`；正文缺失国名关键词时不再硬筛，仅过滤明确指向他国的内容（`isCountryRelevant` 放宽为"无明确他国指向即按源归属放行"）。
- **内容级去重**：`src/lib/utils.ts` 的 `hasDuplicateContent` 对同国候选两两做标题规范化+正文相似度比对，防同一主题重复入库；推送端精选时同样对已选做两两去重（`isDuplicateContent`），确保每次推送内容不重复。
- **每国篇数下限**：默认 `minPerCountry=15`，但已允许"确实不足时适当少于 15"（不硬性凑数）。

## 信息源与社交网络（重要）

- RSS 源定义在 `src/lib/data/sources.ts`（按 `country: kz/uz/kg/tm/tj` 分组）；已补充大陆可访问的真实媒体源。
- **Telegram / Instagram / 公共 RSSHub 在大陆网络不可达**（本项目部署在微信云托管，`t.me`、`api.telegram.org`、`instagram.com` 均 `000`），**不能伪造社交集成**。
- **Telegram 通过 Cloudflare Worker 反向代理接入（已实现，配置驱动）**：
  - 链路：`微信云托管代码 → TELEGRAM_WORKER_URL（你的 Cloudflare Worker） → Telegram API → 返回给本项目`。
  - `src/lib/scraper.ts` 的 `fetchTelegramRSS(channelId)` 现**优先走 Worker**（`fetchTelegramByWorker`），无 Worker 时回退 RSSHub，均失败则丢篇。
  - 本项目在 fetch-news 主流程（`src/app/api/fetch-news/route.ts`）**新增 Telegram 补充段**：读 `TELEGRAM_CHANNELS` 环境变量（格式 `kz:@channelA@channelB`，按 `country:频道@...` 分组），**只有配置了 `TELEGRAM_WORKER_URL` 才启用**，抓到的文章走同样优选/翻译/入库链路，帮助凑齐每国 15 篇。
  - 启用前提（微信云托管环境变量）：`TELEGRAM_WORKER_URL=<你的worker域名>` + `TELEGRAM_CHANNELS=kz:@xnxxx...` 等；未配置时自动跳过、不影响现有 RSS/爬虫链路。
  - Worker 脚本需在 Cloudflare 免费版部署，把请求转发到 `https://api.telegram.org` 的 `getUpdates`/`getChat`，按 channel 返回文本与日期（参考 scraper.ts 中 worker 期望的返回结构）。

## 定时任务

- `src/lib/scheduler.ts` 用 node-cron 注册 2 个任务（每天早上 08:00、晚上 19:00，Asia/Shanghai 时区），每次先抓取当天新闻（每国≥15篇）再推送公众号（过去24h，每国精选15篇）。
- **仅生产模式启动**：`src/server.ts` 在 `!dev`（NODE_ENV=production）时调用 `startScheduler()`；`scripts/start.sh` 设置 `NODE_ENV=production` 并 `node dist/server.js`。本地预览走 `scripts/dev.sh`（`next dev`），**不启动调度器**。
- 调试定时任务是否触发：运行日志搜「启动定时任务调度器」「触发公众号推送任务」。
- 曾出现早上未触发：旧版本运行时 `NODE_ENV` 非 production、`startScheduler` 未被调用，后已修复。部署后要等到下一个到点时间才会触发（cron 精确到点）。

## 公众号推送排版规范（重要）

- `src/app/api/wechat/push/route.ts`：每国精选 15 篇，过去 24h；正文**只保留主体**，不显示"摘要"块。
- 正文默认以完整语句收尾，末尾省略号会被 `cleanSummary` 清理为句号；翻译 prompt 亦要求 ≤300 字、完整收尾、禁止省略号。
- 图片链路见上文「图片链路」。
