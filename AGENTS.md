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

### 页面路由
- `/` - 首页仪表盘（国家概览、重点新闻、分类筛选）
- `/countries/[code]` - 国家详情页（kz/uz/kg/tm/tj）
- `/article/[id]` - 文章详情页

### API 路由
- `GET /api/articles` - 获取文章列表（支持 country/category/limit 筛选）
- `POST /api/articles` - 手动添加文章
- `POST /api/fetch-news` - 从 RSS 源抓取新闻并用 LLM 翻译摘要
- `POST /api/daily-digest` - 生成今日摘要（按国别汇总）
- `POST /api/wechat/push` - 推送文章到微信公众号草稿箱
- `POST /api/pipeline` - 一键执行完整流程（抓取 → 翻译 → 入库 → 生成摘要 → 推送草稿）

### 数据层
- **数据库**: Supabase PostgreSQL，表 `articles`
- `src/lib/db-articles.ts` - 数据库 CRUD 操作
- `src/lib/article-service.ts` - 文章服务（优先数据库，fallback mock）
- `src/storage/database/shared/schema.ts` - Drizzle ORM schema
- `src/lib/data/types.ts` - 类型定义
- `src/lib/data/countries.ts` - 国家数据
- `src/lib/data/categories.ts` - 分类数据
- `src/lib/data/sources.ts` - 新闻来源
- `src/lib/data/articles.ts` - Mock 数据（数据库为空时 fallback）
- `src/lib/data/sources.ts` - 新闻来源
- `src/lib/data/articles.ts` - 新闻数据（当前为 mock）

### 组件
- `src/components/news-card.tsx` - 新闻卡片
- `src/components/news-badges.tsx` - 国家/分类/来源标签
- `src/components/country-card.tsx` - 国家卡片

### 设计风格
- 主色：深藏青 #0F1B2D（权威、信任）
- 辅助色：丝路金 #C8A45C（财富、机遇）
- 背景色：羊皮白 #F8F6F1
- 详见 `DESIGN.md`

## 图片链路（重要）

- 数据库 `articles` 表的 `cover_image`/`image_urls` 字段因 Supabase schema cache 问题被废弃，插入时被移除。
- 图片 URL 改为**嵌入 `content`（contentZh）正文开头**：`fetch-news` 在翻译后把首图拼为 `<img src="..." referrerpolicy="no-referrer" />\n\n正文`（见 `src/app/api/fetch-news/route.ts`）。
- 渲染层通过 `src/lib/utils.ts` 的 `extractFirstImage`/`splitContentImage` 从 content 提取首图、剥离图片标签，供网页端和公众号使用。
- 网页端展示点：`NewsCard / FeaturedCard / article/[id]/page.tsx` 均读 `DisplayArticle.coverImage`；`article-service.ts` 的 `dbRowToDisplay` 用 `splitContentImage` 拆出 `coverImage`。
- 公众号推送：`src/app/api/wechat/push/route.ts` 用 `extractFirstImage(a.content)` 兜底取封面，排版内先剥离 content 里的 `<img>` 再统一输出首图，避免重复图。
- 图片 URL 常带 `referrerpolicy="no-referrer"`，前端 `<img>` 同样加该属性，规避源站防盗链。

## 定时任务

- `src/lib/scheduler.ts` 用 node-cron 注册 5 个任务（网页抓取 08/12:30/15/22 点 + 公众号推送 08:30，Asia/Shanghai 时区）。
- **仅生产模式启动**：`src/server.ts` 在 `!dev`（NODE_ENV=production）时调用 `startScheduler()`；`scripts/start.sh` 设置 `NODE_ENV=production`。本地 `pnpm dev` 也会启动调度器。
- 调试定时任务是否触发：运行日志搜「启动定时任务调度器」「触发网页端抓取任务」「触发微信公众号推送任务」。
- 曾出现早上未触发：根因是旧版本（033~047）运行时 `NODE_ENV` 非 production、`startScheduler` 未被调用；048 起已修复。部署后要等到下一个到点时间才会触发（cron 精确到点）。
