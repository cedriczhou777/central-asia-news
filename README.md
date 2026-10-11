# 中亚投资快报

抓取中亚与南高加索五国（哈/乌/吉/阿/塔）投资相关新闻 → 翻译整理成中文 → 推送至微信公众号草稿箱。
定时每天 04:00（北京时间）跑一轮「日报」（2026-10-10 起，原 07:00 早报 + 19:00 晚报已合并），部署在微信云托管。

- 生产模式跑的是自定义服务器 `src/server.ts`（内嵌 Next.js + node-cron 调度器）
- 推公众号走微信**云调用**，免 IP 白名单、免 access_token
- 部署步骤见 [DEPLOY_WECHAT_CLOUD.md](./DEPLOY_WECHAT_CLOUD.md)
- **本地怎么验证见 [LOCAL_VERIFY.md](./LOCAL_VERIFY.md)**

## 快速开始

### 安装依赖

```bash
pnpm install
```

> 若卡在 `? Do you want to continue? [Y/n]`，是 corepack 在等你确认下载锁定的 pnpm 版本，
> 先执行一次 `corepack prepare pnpm@9.0.0 --activate`。详见 LOCAL_VERIFY.md。

### 启动开发服务器

```bash
pnpm dev
```

启动后打开 [http://localhost:3000](http://localhost:3000)。

开发模式走 `next dev`（见 `scripts/dev.sh`），支持热更新，且**不会启动定时调度器**。

### 提交前自检

```bash
pnpm verify:local    # 类型检查 + 频道解析用例，不需要 API Key
```

### 构建生产版本

```bash
pnpm build
```

### 启动生产服务器

```bash
pnpm start
```

生产模式会拉起 `startScheduler()`，注册 **1 个**定时任务（每天 04:00 一轮「日报」）。

## 项目结构

```
src/
├── app/                       # Next.js App Router
│   ├── layout.tsx             # 根布局
│   ├── page.tsx               # 静态落地页（一句话「服务已就绪」）
│   ├── globals.css            # 全局样式（Tailwind 4）
│   └── api/                   # 10 个 API 路由（见下）
├── lib/                       # 全部业务逻辑
│   ├── feed-fetch.ts          # 抓取（RSS / Telegram）
│   ├── article-body.ts        # 正文补抓
│   ├── scraper.ts             # cheerio 解析
│   ├── translate.ts           # 翻译 + 提示词 + 译后校验
│   ├── same-event.ts          # 同事件去重（L0/L1/L1.5/L2 四层）
│   ├── dedup-before-translate.ts
│   ├── editor-review.ts       # AI 总审（丢弃/修正）
│   ├── country-relevance.ts   # 国家相关性闸
│   ├── proper-nouns.ts        # 专名/元首译名与术语闸
│   ├── investment-score.ts    # 投资相关性评分
│   ├── wechat-template.ts     # 公众号正文 HTML（不走 React）
│   ├── draft-cover.ts         # 封面（sharp 转 JPEG）
│   ├── db-articles.ts         # 库 CRUD
│   ├── scheduler.ts           # node-cron 调度
│   ├── publish-schedule.ts    # 时刻表（唯一出口）
│   ├── push-limits.ts         # 每国上限等常量
│   └── utils.ts               # 语言闸、去重助手、日期口径
├── storage/database/
│   └── supabase-client.ts     # 唯一的数据层入口
└── server.ts                  # 自定义服务端入口（tsup → dist/server.js）
```

### API 路由

| 路由 | 作用 |
|---|---|
| `POST /api/fetch-news` | 抓取 → 翻译 → 去重 → 入库（一轮日报的主体） |
| `POST /api/wechat/push` | 总审 → 生成草稿推公众号 |
| `POST /api/pipeline` | 一键跑完上面两步 |
| `POST /api/daily-digest` | 按国汇总摘要 |
| `GET /api/articles` | 文章列表（带 `originalTitle` / `originalContent`） |
| `POST /api/dedupe-check` | 去重体检（有 `llm=1` 走模型判组） |
| `POST /api/judge-pairs` | 指定配对对照探针 |
| `POST /api/format-check` | 排版自检 |
| `POST /api/translate-check` / `POST /api/telegram-check` | 通道自检 |

> `GET` 形式的 `/api/fetch-news` 与 `/api/wechat/push` 会返回 `codeVersion`（部署指纹）
> 与 `lastRun`（内存态），是判断「线上跑的哪一版」的**首选手段**，比猜日志快。
> 见 DEPLOY_WECHAT_CLOUD.md 的「推了代码但线上没变化？」。

## 核心开发规范

### ⚠️ 这是一个**没有交互式 Web UI** 的项目

唯一的「产品」是微信公众号草稿：正文 HTML 由 `src/lib/wechat-template.ts` 直接生成，
**不经过任何 React 组件**。`src/app/` 下只有一个 `layout.tsx` 和一个静态 `page.tsx`。

**2026-10-11 已删除**整套 shadcn/ui 组件库（`src/components/ui/` 53 个文件）
与 26 个 `@radix-ui/react-*` 等依赖 —— 它们从真实入口**全部不可达**，
过去只躺在 `dependencies` 里让镜像变大。**不要再按「Next.js 项目优先用 shadcn」的通用规范写代码。**

要重新引入 UI 组件：`npx shadcn@latest add <组件>`（会同时加回组件文件与依赖），
加完必须重跑 `pnpm verify:offline` + `npx next build`。

### 改代码后的自检纪律

```bash
pnpm verify:offline   # tsc + 19 个离线回归套件，不联网
npx next build        # 最接近云端的行为（含 TS 类型检查）
```

- **判据改动的验收标准是「在真实语料上逐条人工判读、误报 0」**，不是「跑通了」。
- 有些判据的下游是「重试 → 三次不过就丢稿」⇒ **误报 = 静默丢稿**，代价不对称。
  所以新判据的方向永远是**宁漏不误杀**。
- 阈值**不许拍**：先量、再定，且把量表和语料规模写进注释。
- 观测类输出**不许静默截断**：可以截，但必须写明「…另 N 条」/「（原始 N 字，已截断）」。

### 依赖管理

**仅允许 pnpm**（`preinstall` 有 `only-allow pnpm` 拦着）。`packageManager: pnpm@9.0.0` 必须与
Dockerfile 里 `corepack prepare` 的版本一致。

`dependencies` 现只有 **10 个**，全部有明确运行期引用点；加依赖前请先读
`AGENTS.md` 的「运行时依赖只有 10 个」一节 —— 那里写了怎么正确判断一个包是否真的被用
（**不许只 grep 包名**，要看引用它的文件是否从入口可达）。

改完 `package.json` **必须本机跑一次 `pnpm install` 重生成 `pnpm-lock.yaml`**：
Dockerfile 与 `build.sh` 都用 `--frozen-lockfile`，不一致就是构建硬失败。

### 样式

Tailwind CSS 4，入口 `src/app/globals.css`。
`tailwindcss` / `@tailwindcss/postcss` / `tw-animate-css` 都是**构建期**依赖，
因此位于 `devDependencies`，会被 `pnpm prune --prod` 裁掉 —— 这是对的，别挪回 `dependencies`。

### 时间口径

**一律用 `src/lib/utils.ts` 的 `beijingDate()`**。不要写 `new Date().toISOString().split('T')[0]`
—— 那是 UTC 日期，北京 00:00–08:00 会算成前一天（历史上因此产生过同名草稿）。

## 技术栈

- **Framework**: Next.js 16（App Router，Turbopack 构建）
- **Core**: React 19
- **Language**: TypeScript 5
- **Styling**: Tailwind CSS 4
- **UI 组件**: 无（见上）
- **数据库**: Supabase PostgreSQL（表 `articles`，DDL 见 DEPLOY_WECHAT_CLOUD.md）
- **调度**: node-cron（进程内，每天 04:00 一轮）
- **部署**: 微信云托管（`main` 分支即部署分支）

## 参考文档

| 文档 | 内容 |
|---|---|
| [AGENTS.md](./AGENTS.md) | 项目上下文、未结项清单、各判据的实测依据 |
| [DEPLOY_WECHAT_CLOUD.md](./DEPLOY_WECHAT_CLOUD.md) | 部署、验收、DDL、常见故障排查 |
| [LOCAL_VERIFY.md](./LOCAL_VERIFY.md) | 本地怎么验证、门禁怎么跑 |
| [BASELINE_2026-10-11.md](./BASELINE_2026-10-11.md) | 关闭态基线与逐条订正记录 |
| [REVIEW_2026-10-10.md](./REVIEW_2026-10-10.md) | 一次全仓复盘（历史记录，**不修改**） |

## 重要提示

1. **`main` 是云托管绑定的部署分支** —— `git push` 本身就是一次完整重建 + 滚动发布。
   **不要在任务窗口（北京 03:45–11:15）里推**；推前先确认线上没有长任务在跑。
2. **历史实测记录一律不改**。新结论用「supersede」的方式新增订正段，
   不删原文 —— 改历史等于伪造记录。
3. 报告类的数字（阈值、计数、耗时）**必须能复算**，并且要写清语料规模与口径；
   查不出来就写「没查出来」，不要给一个像模像样的假结论。
