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
| `pnpm verify:local` | 类型检查 + 全部离线回归用例，**提交前先跑这个** | 否 |
| `pnpm ts-check` | 全量 TypeScript 类型检查 | 否 |
| `pnpm test:channels` | `TELEGRAM_CHANNELS` 解析用例（12 条） | 否 |
| `pnpm test:format` | 选稿判据 / 排版用例（25 条） | 否 |
| `pnpm test:investment-score` | 投资评分 + **入库闸门语言覆盖**双向语料（83 条） | 否 |
| `pnpm test:translate-prompt` | 翻译提示词的**产品口径**用例（30 条） | 否 |
| `pnpm test:dedup` | 内容去重双向语料（99 条） | 否 |
| `pnpm analyze:source-language` | **只读**：按国别跑闸门，看真实 feed 通过率 / 逐词误命中 | 否 |
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
- `src/lib/data/sources.ts` - 新闻来源目录（⚠️ **无任何引用**，改源别改它）
- `src/lib/data/rss-sources.ts` - **真正生效的** RSS 源定义（`RSS_SOURCES`，抓取端与离线脚本共用）

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

- **两条由产品口径决定、不是模型自由发挥的规则**（2026-09-22 定，都写在 `TRANSLATE_PROMPT` 里，
  由 `pnpm test:translate-prompt` 逐条钉住）：
  1. **相关性口径 = 政经 / 外资 / 工商税法 / 行业项目 / 社会民生**（提示词第 5 条）。
     旧口径把「社会民生」整类漏在正向清单之外，而负向清单里的「日常生活琐事」又很容易把它一起扫掉 ——
     结果物价、工资、就业、补贴、税费、住房、公用事业这类**没有金额、但直接决定消费能力与劳动力成本**
     的稿子在入库阶段就没了。现在正向清单显式列出这一类，并**去掉了旧口径里的「宁可从严」**。
     ⚠️ 口径只在这一处定义。`article-format.ts` 的 `EXCLUDED_CATEGORIES` 只排除 `culture` / `sports`，
     **没有**排除 `livelihood` —— 两处一致，改这里时记得核对那边（`test:format` 钉着）。
  2. **人名保留拉丁字母，不音译成汉字**（提示词第 6 条）。中亚/高加索人名的汉字音译各家不统一、
     常常不准，投资者按拉丁写法反而检索得到（Tokayev / Mirziyoyev / Aliyev / Rahmon）。
     ⚠️ 这条**只针对人名** —— 机构名、公司名、地名、职务照常译成中文。
     ⚠️ 它会**拉低标题的汉字占比**，而 `isChineseText`（阈值 0.4，拉丁字母计入分母）既是
     「翻译是否成功」也是「能不能推送」的判据。2026-09-22 用线上 400 篇量过余量：标题汉字占比
     min=0.405 / p1=0.464 / 中位=0.931（0 篇低于 0.4），正常标题加一两个人名不会掉下去，
     但**余量只有 0.005 的那几条是贴线的** —— 改完上线要复查这个分布，别让「保留人名」变成静默丢稿。
     （同时验证过一个「只按字母算、把数字排除出分母」的替代口径，最小值只从 0.405 提到 0.410，
     收益太小、不值得动一个被 4 处调用的判据，故未改。）
- **回归**：`pnpm test:translate-prompt` 离线读 `TRANSLATE_PROMPT` 断言上面两条口径 + 占位符完整性
  （`{LANG}`/`{TITLE}`/`{CONTENT}`/`{CATEGORIES}`）+ `langLabel` 覆盖 `RSS_SOURCES` 里每个语言，
  不调模型、不碰数据库。
- **部分国家（哈萨克、吉尔吉斯等）曾推送英文原文**：根因是 LLM 翻译失败/JSON 解析失败后，抓取侧静默把原文入库，推送又被优选出去。
- **翻译逻辑已抽到 `src/lib/translate.ts`（`translateNews`）**：多模型降级链，**按序**尝试
  `zhipu`（`glm-4.7-flash`，免费档，关 thinking）→ `zhipu-flash`（`glm-4-flash-250414`，**同为智谱免费档、同 Key**）→ `deepseek`（`deepseek-flash`，**付费兜底**）；
  每个模型最多重试 3 次（指数退避）+ 多策略 JSON 解析；全部失败才按失败处理。
  **第二免费通道存在的理由**：智谱的 `1305 该模型当前访问量过大` 是**按型号**计的（不是按账号），
  所以主型号被挤爆时备用型号往往还通 —— 它插在付费通道之前，等于「多一次不花钱的机会」，
  属**行为超集**（命中省钱、没命中只是多花几百毫秒），所以当初直接上线、没灰度。
- **⚠️ 实测：主通道几乎打不通，链路实际一直跑在第二个免费通道上。** 2026-09-22 判定链路
  50 次调用统计：`zhipu-flash` 46 次 / `zhipu` 4 次 —— **主型号只成功了 8%**。
  两个后果：① 别再用「总耗时」推断走了哪条通道的**唯一**依据（`zhipu` 命中时 ≈35–70s、
  `zhipu-flash` ≈3.4–5s，有 15 倍差，但这只是**表现**，要确认请看响应里的 `provider`）；
  ② 一旦第二个免费型号也拥挤，就会**静默降级到付费的 DeepSeek**，而中间通道的失败原因
  在「最终成功」时**是被吞掉的**（`askLlmJson` 只在全部失败时才回传 `failures`）——
  想查「为什么主通道一直不通」需要另加观测，目前没有。
- **通道定义已导出为 `PROVIDERS`**，`scripts/test-translate.ts` 直接读它打印「已配置通道 + 型号」——**型号只在一处定义**，避免代码改了脚本/文档还写旧名字。
- **⚠️ 型号代号是易腐的**：`deepseek-chat` 已被官方下线（2026-09 查 `https://api-docs.deepseek.com/quick_start/pricing`，在售的只有 `deepseek-flash` / `deepseek-v4-pro`）；`daily-digest` 里也曾写死过 `glm-4`。**用错型号不会报错到用户面前**，只在日志留一行 `[deepseek/xxx] 请求失败 400`，降级链等于没有。加凭据类配置时**必须顺手核对型号**。
- **模型名可通过环境变量覆盖**（`ZHIPU_MODEL` / `DEEPSEEK_MODEL`），厂商调整型号代号时不需要改代码。
- **未配置 Key 的通道会被直接跳过**，不做无意义重试；启动日志里会打印「以下翻译通道未启用」。
- **已移除扣子专属依赖 `coze-coding-dev-sdk`**（原豆包降级通道），备用模型不再绑定扣子平台。
- **本地自测**：`pnpm tsx scripts/test-translate.ts`（在 `.env.local` 里配好 Key 后运行），只验证模型调用与中文解析，不碰数据库和微信接口。
- **入库端**（`fetch-news/route.ts`）：翻译结果必须通过 `isChineseText` 校验（标题+正文中文字符占比达标才视为成功），否则 `translated=false` 且**跳过该篇不入库**（`continue`），绝不把原文写入 content。
- **推送端**（`wechat/push/route.ts`）：精选前会挡掉非中文文章，历史英文数据也不会被推送。
  ⚠️ 这条判据现在是 `@/lib/article-format` 的 **`isPushableText(title, content)`**，
  并且**已经并进 `pushExclusionReason`**（原因名 `untranslated`）——
  即「选稿资格」是一个函数、四条判据。**别在调用方再写 `isChineseText(a.title) && isChineseText(a.content)`**：
  这个表达式曾与 `pushExclusionReason` 分家，导致体检接口把 31% 的非中文文章喂给模型判重
  （见 `pushExclusionReason` 注释里的第三次事故）。体检响应现在按原因报 `excludedByReason`，
  可以直接核对口径有没有对齐。
- 搭配工具：`src/lib/utils.ts` 的 `isChineseText(text, threshold=0.4)`，中文字符占比达到阈值即视为中文。

## 入库闸门的语言偏置（重要，曾让 kz/tj/kg/uz 每天只剩个位数候选）

- **症状**：2026-09-22 用户问「哈萨克今天为什么只有一篇」。结论：**不是上限的问题**，
  是入库闸门 `isInvestmentTopic`（`src/lib/investment-score.ts`）在**按语言而不是按题材**筛选。
- **根因**：闸门**故意跑在翻译之前**（为了省翻译钱），拿到的还是原文；
  但它的关键词表当时只有**纯英文 + 纯中文**两张 → 西里尔/中亚语条目几乎全被判为「非投资」丢掉。
  实测同一轮抓取：The Astana Times（英文源）闸门通过率 **82.6%**，
  而 Newtimes.kz / Total.kz / Egemen（俄文源）只有 **4.1%**（57/60、38/40、48/50 篇都死在 `droppedTopic`）。
  后果是 kz 的选稿实际变成了「**英文源里**最好的投资新闻」，而不是「kz 最好的投资新闻」。
- **修法**：加两组词表（`GATE_CYRILLIC` 224 条 + `GATE_OTHER_LATIN` 45 条词干）——
  俄语 `инвестиц`/`инвестор`/`налог`/`нефт`/`экономик`…；哈萨克语**民族词**
  `өндіріс`/`баға`/`салық`/`құрылыс`/`кәсіп`；吉尔吉斯 `салык`/`курулуш`/`долбоор`；
  塔吉克 `сармоя`/`андоз`/`буҷет`/`нарх`；乌兹别克西里尔 `солиқ`/`қурилиш`/`иш ҳақ`；
  阿塞拜疆 / 乌兹别克拉丁 `iqtisad`/`sərmayə`/`vergi`/`sarmoya`/`soliq`/`budjet`。
  - ⚠️ **必须用词干，不能只收原形**：这些语言屈折很重（`инвестиция` / `инвестиции` /
    `инвестиционный` 是同一个词），只收原形等于没收。代价是词干会撞上无关词 ——
    **这就是为什么必须逐词体检**（见下一条）。
  - ⚠️ **别加国家名 / 城市名**：对「哪篇更相关」零区分力（某国的文章几乎篇篇都有），
    只会给所有文章加同一个常数。这条规则在 `investment-score.ts` 头部也写着，别「顺手补上」。
  - ⚠️ **加宽闸门是安全的**：它是「只放宽不放严」的前置粗筛，后面还有 LLM 的
    `investorRelevant` 做真正的相关性判定（见 `translate.ts`）。放宽只多花翻译钱，不掉质量 ——
    所以**放宽的方向可以大胆，收紧的方向才要谨慎**。
- **逐词体检**（`pnpm analyze:source-language <国别> --words`）当场拦下 4 个**字面看不出、
  但会误伤**的词干：`рудник`→`сотрудник`（员工）、`руда`/`руды`→`труда`（劳动）、
  `аким`→`каким`（哪个）、`баа`→`баары`（所有，会让 Kabar 全站内容都通过闸门）。
  另有两个已知碰撞**接受并写进注释**：`цены`→`сцены`、`пенси`→`компенси`、`золот`→体育金牌。
  ⇒ **加词之后必须跑一次 `--words`**：聚合通过率只能看出「放宽了」，看不出「误命中了」。
- **回归**：`pnpm test:investment-score` 的「二之二 闸门语言覆盖」段，用**真实线上标题+描述**做
  双向语料（16 条必须通过 / 12 条必须拦住 / 4 条误命中护栏），该套用例共 83 项断言。
  ⚠️ 语料必须用 `标题 + 描述`，因为生产闸门的输入就是 `` `${title} ${desc}` `` ——
  只喂标题会误判（Stadler 那篇的哈萨克语信号 `көлік` 只出现在描述里）。
- **上线后复查**：`GET /api/fetch-news` 看 `funnelByCountry[*].droppedTopic` 是否下降、
  `candidates` 是否上升；本机可直接 `pnpm analyze:source-language kz --dump=5` 看真实 feed 逐条 ✓/✗。

## 抓取放宽与内容去重（重要，曾因过严导致每国不足15篇）

- **日期窗口**（`fetch-news/route.ts`）：`targetDate` 默认回溯最多 2 天（当天及前 1 天），放宽超时，不再严格限制当日。
- **智能国家判定**：RSS 源自身按国别归属 `source.country`；正文缺失国名关键词时不再硬筛，仅过滤明确指向他国的内容（`isCountryRelevant` 放宽为"无明确他国指向即按源归属放行"）。
- **内容级去重**：统一入口是 `src/lib/same-event.ts` 的 `dedupeStories()`，**入库端与推送端共用同一个**（不要各写一套）。三层判据：
  1. `same_url` —— `utils.canonicalUrl()` 归一化后的链接相同（去掉 `?from=rss` / `utm_*` / 末尾斜杠 / `www.`）。**这是主力判据。**
  2. `same_original` —— 原文标题指纹相同（`utils.originalTitleKey()`），用于「同一篇原文挂在两个不同链接下」。
  3. `llm_same_event` —— 模型判「表述不同、实际是同一件事」，每国 1 次调用，走 `translate.ts` 的免费优先降级链；不可用时自动降级为只做 1、2。
     形态是 **`pair`（逐对二选一）**，不是 `group`（在一长串里找组）。`group` 实测两次都失败：关 thinking 时模型把所有下标都列出来，开 thinking 时按**话题**而非事件归并（哈萨克把「聚乙烯工厂」与「节水灌溉面积」并成一组）。改为 pair 后模型只有**否决权** —— 候选对由确定性判据（标题相似度 ≥0.35）先召回，模型只能说「这两条不是同一件事」，误判的后果从「误删」变成「漏合并」，方向是安全的。
     ⚠️ **`SAME_EVENT_JUDGE` 默认关闭**（`on`/`1`/`true` 才开）。默认必须是「不合并」：误合并是丢信息且不可逆。打开前先用 `GET /api/dedupe-check?llm=1&debug=1` 看模型逐对的判定。
     ⚠️ **判定必须 `temperature: 0`**（`same-event.ts` 的 `JUDGE_TEMPERATURE`）。`translate.ts` 的默认温度是 0.3 —— 那是给**翻译**留用词变化的，判定类调用沿用它就是给结论注入随机性。但温度 0 **只是必要条件、远不是充分条件**：它保证不了确定性（下面实测证明），所以也别把「温度已修」当成这个问题解决了。
     ⚠️ **实测结论（2026-09-22 更正）：判定确实不稳，主因就是通道。**
     ⚠️⚠️ 这里曾写着「原因不是通道 —— 别去动 `PROVIDERS`」。**那是错的，已推倒。** 错的形态值得记：旧证据是「2 天窗口连跑 10 轮，两种通道对同一批对结论逐次完全一致（0 分歧）」，但 2 天窗口**每国只有 1 个候选对** —— 一条候选上「一致」几乎是必然的，那是**没有检验力**，不是稳定。
     用 14 天窗口（每国 8–12 对）重测，在**同一批候选内**按通道分组：

     | 口径 | 通道内标准差（均值/最大） | 通道间差（均值/最大） |
     |---|---|---|
     | 14 天、修好口径 | **0.09 / 0.44** | **5.07 / 8.22** |
     | 14 天、旧口径   | 0.73 / 2.08 | 4.43 / 7.58 |

     干净口径下 uz / az 的通道内标准差**恰好是 0**（zhipu 三轮判同 7/7/7；zhipu-flash 七轮 3/3/…/3），而两条通道差 4 对；tj 差 8.22 对 ⇒ **型号差异是主因**，比通道内随机大一个量级。旧证据里真实的那一半是「通道没变、结论也变」（同一条通道内确实会翻），但幅度只有标准差 0.09–0.44。
     **两条通道错的方向相反，钉哪条都还是错的：**
     - `zhipu`（`PROVIDERS` 首选）**在「同主题模板标题」上过度合并**：tj 的 12 个候选全是「独立 35 周年」相关但事件各不相同（专利信息中心 / 民主党在俄活动 / 驻维也纳使馆 / 驻东京使馆 / 尼亚加拉瀑布亮灯…），它 **12/12 全判「同」**；其中「驻奥地利使馆在维也纳」vs「驻日本大使馆在东京」是**没有任何含糊空间的误合并**，后果是整国新闻被折叠成 1 条。
     - `zhipu-flash`（降级通道）**对「同一件事的两种写法」漏合并**：az 的 9 个候选里「音乐日比赛」「航空大奖」「石油工人授勋」等 5 对明显同事件，它**一致判「否」**。
       ⚠️ 旧文把这算成「**模型**的偏置」—— 但 az 那 8/10 轮都是 `zhipu-flash` 答的，是**这条通道**的偏置；归因错了，修的方向就会跟着错。
     ⇒ 正确表述：**钉通道解决「可复现性」，不解决「精度」。** 前者有效（差 5.07 vs 标准差 0.09，差 50 倍），后者无效（两条通道各有各的错）。所以别把「钉固定通道」当成修好了，也别再因为「它修不好精度」就否认它是主因。
     ⚠️ **测稳定性必须喂够候选对，否则会得出「稳定」的假结论。** 同一套代码、同一份线上数据：2 天窗口（每国 1 对）连跑 10 轮**零分歧**；7 天窗口**第 2 轮就出分歧**；14 天窗口通道间差到 8 对。候选对只有 1 个时「稳定」几乎是必然的 —— 那不是稳定，是**样本没有检验力**。
     **这个护栏已写进工具**：`pnpm test:dedup-stability <响应目录>`（只读）在「候选对 < 4」或「只用到一条通道」时**拒绝下结论**，并显式列出无法归因的国家。把当年那批 2 天数据喂进去，它直接打印「没有任何国家达到检验力下限，**不要下结论**」—— 即**这个失误已经不可能再复现**。该脚本另钉住两个坑：① **按通道分组**，否则把「通道切换」误读成「模型随机」——混着算会让 p 呈**双峰**，中间那撮就是通道痕迹；② 用**多重集**计数，因为同一批候选里会出现**标题一字不差的多对**（uz 的 8 个候选里有 3 对完全相同），用 `Set` 会折叠掉、把「判同 7 对」算成 5 对。
     体检响应带 `provider` 字段（`DedupResult.llm.provider`，pair / group 两种形态都带）—— 用途是**归因**（同批候选里两条通道各答了什么），不是替哪条通道开脱。候选对为 0 时该字段为空（没真调用模型），不是 bug。
     **当前结论：`SAME_EVENT_JUDGE` 保持关闭。**
     ⚠️ **别用「多次调用取一致」（2 选 2 自洽投票）来解决判定不稳 —— 算过，不成立。**
     设某对模型单次答「是」的概率为 p，则「两次都判是」把它压成 `p²`：
     p≈0.6 时召回 60%→36%，p≈0.8 时 80%→64%，只有 p≈0.95 的明显重复几乎不损失。
     更要紧的是**它换不到确定性**——两次采样都随机，取「两次一致」只是把噪声换了位置。
     「同一对跑两遍结论不一致」的概率：p=0.6 时 48%→46%（几乎没动），
     p=0.8 时 32%→**46%**、p=0.95 时 9.5%→**17.6%**（**更差**，因为「两次都凑齐是」
     本身是稀有事件，两遍之间只要一次没凑齐，结论就翻）。
     ⇒ **付出 30–50% 召回、换来接近零的稳定性改善。不要做。**
     另：L2 的活儿本来就是**模糊对**（链接/原文相同的重复已被 `same_url` / `same_original`
     吃掉 —— 实测 30 天 3732 行里 1108 行重复几乎全是 `same_url`），所以按 L2 的
     **边际贡献**算，损失远不止「减半」。要动方向，只能是「给模型判『是』加一个
     **确定性加证**（如更高相似度、共享同一组数字/日期/人名）」以保证 precision 可复现，
     而不是在随机采样上叠加规则。
     ⚠️ **离线评估结果（2026-09-22，20 个中文候选对 × 14 轮；金标注由我人工判定）**：

     | 规则 | 召回 | 精确率 | 合并次数（对/错） |
     |---|---|---|---|
     | 基准：模型说「是」就合并 | 64% | 78% | 162 / **45** |
     | + `sim ≥ 0.45` | 36% | 89% | 91 / 11 |
     | **+ `sim ≥ 0.50`** | **29%** | **100%** | **74 / 0** |
     | + `sim ≥ 0.60` | 22% | 100% | 56 / 0 |
     | + `sim ≥ 0.70` | 17% | 100% | 42 / 0 |

     读法：**基准的 22% 误合并（45 次错删）对「不可逆」的动作是不可接受的**；
     而加一个 `sim ≥ 0.5` 的确定性加证就能把误合并压到 0，代价是召回从 64% 掉到 29%。
     **要点不是「让决策变确定」**（做不到，模型仍是随机源），
     而是**让危险方向变得不可能** —— 只要误合并≈0，剩下的「漏合并」是可事后清理的安全失效。
     另：`az` 有 5 对明显同事件却 p≈0.07–0.14（稳定判「否」）—— ⚠️ **这里曾归因给「模型的偏置」，错了**：az 那 8/10 轮都是 `zhipu-flash` 答的，是**这条通道**的偏置；同一批 9 对上 `zhipu` 判同 7 对，其中 5 对与它不同。加阈值救不回来，但**换通道会变**。详见上面「主因就是通道」段。
     ⚠️ **14 天窗口复测（干净口径，2026-09-22）：这个阈值方案的代价比上表大得多。** 候选对的 `sim` 几乎全挤在 0.35–0.45（召回的入口下限就是 0.35），所以 `sim ≥ 0.5` 事实上**把 L2 快关掉了** —— 每国平均只剩 1 对（tj 12→1、uz 7→1）。「精确率 100%」是**几乎不合并**换来的，不是判得准。复核同时给旧结论补了一个**正面发现**：闸门把两条通道的差异从「谁留下错的对」（危险、不可逆）降级成「谁少留了对」（安全、可事后清理）—— 在 `sim ≥ 0.5` 下两条通道留下的 7 对**逐对看都是对的**。所以正确组合是**闸门管精度、固定通道管可复现性**，不是二选一。
     ⚠️ **但 0.50 这个阈值是在 20 对、一天的数据上拟合出来的，不要直接上线。**
     下一步应当是：扩大候选对样本（更宽窗口 / 多天）再定阈值，并留出独立的一天做验证。
     ▸ 进展（2026-09-22）：「更宽窗口」**已做**（14 天 × 10–14 轮，干净口径，按通道拆分）；
     「**留出独立的一天做验证**」**仍未做** —— 上面所有数字都是同一段数据上的拟合，别当验证结果用。
     ⚠️ **体检接口的输入必须与 `push` 同口径，否则结论对生产无效。** 2026-09-22 踩到：`GET /api/dedupe-check?llm=1` 的输入直接来自 `getArticleIdentities()`，**没套选稿判据**，于是 kz 的 12 个候选对全是亚洲运动会体育稿 —— 而体育类在 `push` 里被 `EXCLUDED_CATEGORIES` 整类剔掉、永远进不了生产，测出来的「判定不稳」与生产无关。已修：体检的 L2 段现在套 `pushExclusionReason`，且只覆盖 `push` 会遍历的国家（kz/uz/kg/az/tj，**不含 intl**），并把口径报在 `llmJudgeParams.scope` 里。两处差异都补齐了 —— 以后加判据请加在 `pushExclusionReason` 里（`scripts/test-format.ts` 逐条钉住），**别在调用方再抄一份**：这个 bug 与投资评分那次是同一形态（同一判据两处各写一份，一边对一边错、不报错只在结论里体现）。
     ℹ️ **`intl` 的文章会入库但永远不会被推送**：`push` 只遍历 `countryList`（5 国），而 `RSS_SOURCES` 里有 1 个 `intl` 源（The Times of Central Asia）。也就是说这个源抓取+翻译的成本是白花的。要收编的话得决定「归到哪个国家」，属于产品决策，目前**未处理**。
  另有 `same_text` 兜底（标题+正文**几乎逐字相同**才成立，阈值 0.9/0.8）。
  ⚠️ 历史上的 `utils.isDuplicateContent`（标题 0.8 / 平均 0.6）已**不再用于去重**：实测在 200 篇与 1000 篇两份线上快照上零触发，却会误合并「金价下跌」与「金价上涨」这类方向相反的新闻。函数保留在 `utils.ts` 里但无调用点，别再把它接回去。
  **反向极性对在问模型之前就被确定性拦掉**（`hasOppositePolarity`）：「金价下跌」vs「金价上涨」相似度 0.71、排在候选表第一位，是字面最像的假阳性，方向词是封闭集合没理由交给模型猜。⚠️ 这类对**没有**比例熔断兜底 —— 候选按相似度降序截断，真重复占多数是正常的（实测乌兹别克单轮 12 对里 11 对确实是同一件事），任何「判是比例过高就作废」的阈值都会误伤，别再加回来。
  回归：`pnpm test:dedup`（固定双向语料）、`pnpm test:dedup <线上数据.json>`（真实数据体检）、`pnpm tsx scripts/peek-pairs.ts <线上数据.json>`（只看召回：会把哪些对交给模型）、线上 `GET /api/dedupe-check`（只读报告）、`POST /api/dedupe-check {apply:true}`（清理存量重复行，默认 dry-run）。
- **判定「重复行是存量还是仍在产生」，不能只看「是不是今天入库的」。**
  线上体检结果的 `identicalGroups[*].keepInfo / dropInfo` 给出每行的 `createdAt`（**入库时间**）与 `publishedAt`（**发布日期**）。判据是：
  **拿 `createdAt` 和「最近一次相关修复的上线时间」比**，不是和「今天」比。
  - 全部早于上线时间 → **存量**，`POST {apply:true}` 清掉即可。
  - 出现晚于上线时间的 → 那条修复没解决问题，**先修闸门再清存量**，否则清了还会再长。
  ⚠️ 2026-09-22 在这上面判反过一次：看到 0.62 天前的重复行就下了「仍在漏」的结论，
  而当时那次修复（链接归一化）在 0.48 天前才上线 —— 差几小时就会得出相反结论。
  另：**别用 `published_at` 判断新旧**。闸 2 的时间窗筛的就是它（`published_at`），
  而重复的典型成因恰恰是「发布日期很早、很晚才被抓到」——这类行的 `published_at`
  和老行混在一起，看不出它是刚插进来的。这也意味着闸 2 存在一个**尚未发生**的缺口：
  发布日期距重抓相隔 > 3 天的稿子会绕过窗口。触发后改用入库时间做窗口（`DB_DEDUP_WINDOW_DAYS` 附近的注释记录了这件事）。
- **改判据之前，先把「输入」变成可观测的。** 2026-09-22 修去重时按这个顺序做：
  ① 先只加只读诊断字段（`keepInfo`/`dropInfo`、`dedup.window.rows`）并单独上一个 commit；
  ② 读线上数据定因；③ 再改判据。好处是**改了之后能归因**——否则改动一多，
  症状变了也不知道是哪个原因起了作用。本项目多处（`?llm=1&debug=1`、`format-check`、
  `peek-pairs`、`translate-check` 的对照组）都是同一套做法：**让机制自己把答案说出来**。
- **每国篇数**：抓取端下限默认 `minPerCountry=10`（保证有内容可推）；推送端**不固定篇数**，"今日精选"按实际可用量推送。
  **每国上限 15 篇**（`maxPerCountry`，2026-09-22 由 30 收到 15 —— 改成早晚报两段后，每份报告每国 15 篇足够，30 篇只会把相关性靠后的稿子也塞进来、拉低整份报告质量）。上限不是配额，候选不足**不硬凑**：硬凑就得放宽判据，而判据过严/过松都出过事。
  ⚠️ 收上限会**扩大「每国不足 N 篇」的出现面**（以前要 30 篇才触发，现在 15 篇就可能不够）。候选不足时**先看 `GET /api/fetch-news` 的 `funnelByCountry`** 判断掉在哪一段，不要直接动 `pushExclusionReason` 或 `maxPerCountry`。
  **`funnelByCountry` 是 2026-09-22 为回答「某国今天为什么只有一篇」补的**（在那之前只报每源 `fetched`，中间全不可见）。口径：`fetched`（feed 条目）→ `afterDate`（过日期窗）→ `droppedJunk` / `droppedCountry` / `droppedTopic`（三个丢弃原因）→ `candidates`（进候选池）。四个环节的修法完全不同，所以分开计数：
  - `afterDate` 偏小 → 源在这个时段没发稿，或 **feed 本身只保留很少条目**（实测 Astana Times 的 feed 只有 **10 条**，等于只覆盖最近一两天；对比 Newtimes.kz 有 100 条）
  - `droppedCountry` 偏大 → `isCountryRelevant` 里「标题/正文提到**任何一个其它目标国**就丢」这条互斥规则在该国身上过敏（中亚当地区新闻极易同时提到邻国）
  - `droppedTopic` 偏大 → 入库闸门词表对该国**语言**覆盖不足。**2026-09-22 已按此修过一轮**
    （加西里尔 + 中亚语言词表，见上节「入库闸门的语言偏置」）。若仍偏大，
    先 `pnpm analyze:source-language <国别> --words` 看是哪条词没覆盖，**别去动闸门之外的判据**。
  - `fetched=0` 且 `sourceErrors` 有值 → 源本身不通。**2026-09-22 实测这批**：`Inbusiness.kz` 与 `Economist.kg` 从容器侧 `Request timed out after 30000ms`（本机 curl 同 URL 正常拿到 65 条/714KB，**所以别用本机可达性判断容器可达性**）；`AKIpress` / `Tazabek` 报 `Unexpected close tag`（XML 畸形，rss-parser 直接放弃整个源）；**11 个 Telegram 源全部 `fetch failed`**，因为 `telegram-proxy.cedriczhou777.workers.dev` 在大陆容器里不可达 —— 即 Telegram 补充段**整体是死的**，与它「帮助凑齐每国篇数」的设计目的相悖，要么换掉 workers.dev 域名（自建反代/自有域名），要么删掉这段免得误以为有供给。

## 信息源与社交网络（重要）

- **真正生效的** RSS 源定义在 `src/lib/data/rss-sources.ts` 的 `RSS_SOURCES`（按 `country: kz/uz/kg/az/tj/intl` 分组，共 26 个源）；已补充大陆可访问的真实媒体源。
  **2026-09-22 从 `fetch-news/route.ts` 抽出来**，因为离线脚本（`analyze:source-language`）也要读同一份定义 ——
  「一处定义、两处调用」，**别在脚本里再抄一份源列表**（抄了就会一边改了另一边没改，不报错、只在结论里体现）。
  ⚠️ 每条源上的 `language` 字段是**声明值、不可靠**：实测有源声明 `ru` 实际发 `kk`，也有同一个源混发多语。
  **别拿它做筛选依据**；要判语言请按实测文字系统（`analyze:source-language` 会打印按文字系统的分组统计）。
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

- ⚠️ **别在定时任务跑的中途推代码 —— 推送会打断它。**（2026-09-22 踩到）
  `main` 就是云托管绑定的分支，**推一次 = 完整重建 + 滚动发布**；滚动发布会替换容器，
  而这个项目的长任务状态（`lastRun`）放在**模块作用域**里 ⇒ **在跑的那轮会被杀掉、状态被清空**。
  实测一轮抓取含翻译约 **75 分钟**（19:00 触发 → 20:15 才抓完），部署要 4–26 分钟 ——
  两个窗口重叠的概率并不小。受害者是当晚的草稿箱：抓取刚跑到一半被换掉，推送那一步永远轮不到，
  **草稿箱空着，而控制台看不出任何异常**。
  - **推之前先查一句**（零副作用）：
    `curl -s "$BASE/api/fetch-news" | grep -o '"running":[a-z]*'`
    （顺带看 `/api/wechat/push` 的 `lastRun.startedAt` 是不是 null —— 空的就是今晚还没建草稿）。
    `running:true` 就**等它跑完再推**。
  - 判断部署有没有真的接管流量：**首页 build ID**（`curl -s "$BASE/" | grep -oE '<!--[A-Za-z0-9_-]{8,}-->'`）
    + 上面那个 `lastRun` 是否被清空。**别用「感觉没变」判断**。
  - **被换掉之后的补救**：等部署稳定，`POST /api/fetch-news` 再 `POST /api/wechat/push {"hours":11,"period":"evening"}`。
    ⚠️ 别用 `git push --force` 把远端退回旧提交「撤销」—— 那会**再触发一次**完整重建 + 滚动发布，
    等于把打断做第二遍，还会丢掉已上线的修复。
  - 纯文档/注释改动**不要单独推**（一样会触发一次完整重建 + 滚动发布）：本地 `git commit` 留着，
    等下一个功能改动一起推。
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
