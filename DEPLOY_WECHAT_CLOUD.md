# 微信云托管部署指南

## 前置条件

1. 已开通微信云托管服务
2. 已开启云调用功能
3. 已添加接口路径：
   - `/cgi-bin/draft/add`
   - `/cgi-bin/material/add_material`

## 部署步骤

### 1. 在微信云托管创建服务

1. 登录 [微信公众平台](https://mp.weixin.qq.com/)
2. 进入 **设置与开发** → **微信云托管**
3. 点击 **新建服务**
4. 填写服务名称：`central-asia-news`

### 2. 配置环境变量

在云托管控制台 → **设置** → **环境变量** 中添加：

**必填（缺了会直接影响功能）**

| 变量名 | 值 | 说明 |
|--------|-----|------|
| `ZHIPU_API_KEY` | (你的智谱 Key) | **翻译用，必填**。`glm-4.7-flash` 当前免费档；缺了翻译链路全断，文章会在入库前被丢弃 |
| Supabase 地址 / Key | (你的 Supabase URL / Key) | 数据库。读变量的顺序是 `SUPABASE_URL` → `NEXT_PUBLIC_SUPABASE_URL` → `COZE_SUPABASE_URL`（Key 同理，`ANON_KEY` 三套命名任选其一） |

**建议配置**

| 变量名 | 值 | 说明 |
|--------|-----|------|
| `DEEPSEEK_API_KEY` | `sk-...`（[platform.deepseek.com](https://platform.deepseek.com) → API keys） | 智谱失败时的**降级通道**，按量付费。不配的话智谱一旦限流/欠费，整批文章直接不入库（单点风险）。⚠️ 新账号余额为 0，**必须先充值**，否则请求直接 402 |
| `SUPABASE_SERVICE_ROLE_KEY` | `eyJ...`（Supabase → Settings → API Keys → Legacy API keys → `service_role`） | 服务端直接写库，不受 RLS 影响。不配则回退到 anon key。⚠️ 全权限钥匙，别外传 |
| `DEEPSEEK_MODEL` | `deepseek-flash` | **建议显式写上**。旧默认值 `deepseek-chat` 已被官方下线（见下方「型号代号会过期」） |

**可选**

| 变量名 | 说明 |
|--------|------|
| `TELEGRAM_WORKER_URL` | Cloudflare Worker 代理地址；不配则不抓 Telegram。部署见下方「Telegram 接入」 |
| `TELEGRAM_CHANNELS` | 频道配置，格式 `国家:频道[@频道...]`，逗号分隔。留空用内置默认值 |
| `ZHIPU_MODEL` | 覆盖第一优先的免费型号，留空即用默认值 `glm-4.7-flash` |
| `ZHIPU_FALLBACK_MODEL` | 覆盖**第二个**免费型号，留空即用默认值 `glm-4-flash-250414`。它排在付费通道之前，专门用来接住 `glm-4.7-flash` 的 1305（按型号计的拥挤）。**厂商换代号时只改这个变量，不用改代码** |
| `DEEPSEEK_MODEL` | 覆盖降级型号，留空即用代码默认值 |

#### 翻译走了哪个通道、花了谁的钱？（一轮抓取后必看）

`GET /api/fetch-news` 的 `lastRun.summary.translation` 里有：

| 字段 | 含义 |
|------|------|
| `providerCounts` | 每个通道成功翻了几篇，如 `{"zhipu": 40, "zhipu-flash": 30, "deepseek": 96}` —— **只有 `deepseek` 那一项是花钱的篇数**，两个 zhipu 都是免费档 |
| `errors` | 每个失败通道的第一个报错（如 `zhipu: HTTP 429 ... code 1305`），免费档为什么没生效看这里 |

如果 `zhipu` 计数为 0 而 `errors` 里有它的报错：按报错处理——
401 = Key 错；`model not found` = 型号代号过期（去智谱控制台「模型与价格」页核对，
用 `ZHIPU_MODEL` 覆盖）；429 = 免费档限流（检查是否有并发）。

##### ⚠️ 已实测：微信云托管**到不了** `*.workers.dev`（2026-09-20）

**这一段是结论，不要再重复排查。**

`GET /api/telegram-check` 的实测结果（部署于微信云托管的容器内发起）：

| 检查项 | 结果 |
|--------|------|
| `TELEGRAM_WORKER_URL` 是否配上 | ✅ 已配，值 `https://telegram-proxy.cedriczhou777.workers.dev` |
| 容器能不能上外网 | ✅ 能，`https://www.baidu.com` → HTTP 200（40ms） |
| 12 个频道请求 Worker | ❌ 全部 `fetch failed`，约 250ms 内失败，`status=null`（**网络层就没通**） |

**结论：容器有外网，但解析/连接不了 `workers.dev` 这个域名。**
微信云托管在大陆网络访问 Cloudflare 的 `*.workers.dev` 默认域名不可达。
这**不是**频道名写错，也不是环境变量配错 —— 改 `TELEGRAM_CHANNELS` 没有任何用。

**想真正打通 Telegram，只有两条路**（都要额外资源，见下）：

1. **给 Worker 绑一个自定义域名**（Cloudflare 后台 → Worker → Settings → Domains & Routes
   → Add Custom Domain）。需要一个托管在 Cloudflare 的域名。把 `TELEGRAM_WORKER_URL`
   换成该域名后再跑一次 `GET /api/telegram-check` 验证 —— 能通就通了。
   ⚠️ 仍走 Cloudflare 边缘，不保证一定可达，必须用 telegram-check 实测过才算数。
2. **换一个大陆可达的转发地址**（境外小服务器 / 云函数 + 自定义域名），
   返回结构必须与 `telegram-worker/worker.js` 一致（`{ posts: [{title,url,date,summary}] }`）。

**替代方案（推荐）**：这条链路不通**不影响内容覆盖**。目前 26 个 RSS 源全部可用
（2026-09-20 干跑实测：单轮采集 910 条，含吉尔吉斯 5 源与阿塞拜疆 6 源），
Telegram 只是"再多一路社交媒体来源"，不是唯一来源。代码侧的桥已经就位且已验证，
等有了可达域名，改一个环境变量就能开通，不必改代码。

#### 翻译通道体检（配好凭据后必跑一次）

```bash
curl -s "$URL/api/translate-check" | python3 -m json.tool
```

逐通道真实打一次极小请求，返回型号、通/不通、**原始报错**、单次耗时。
对配了 `thinking` 开关的通道（智谱）**还会再打一次「去掉该参数」的对照组**，
返回 `reasoningChars` / `requestExtra` / `control`，并把这些结论直接写进 `notes`。怎么读：

| 现象 | 含义 |
|------|------|
| `zhipu.ok=false` + `HTTP 401` | Key 无效或复制时被截断 |
| `zhipu.ok=false` + `404` / `model not found` | 型号代号过期，用 `ZHIPU_MODEL` 覆盖 |
| `zhipu.ok=false` + `429` / `code 1302` | **你的账户**并发到顶了 —— 见下面「1302 与 1305 的区别」 |
| `zhipu.ok=false` + `429` / `code 1305` | **平台整体过载**，与你账户无关，只能稍后重试 |
| `notes` 里「传了 disabled 仍有 reasoning_content」 | thinking **没**关掉 → 单篇慢的锅在 thinking，要改参数/换型号 |
| `notes` 里「thinking 确实关掉了（不关 Xms → 关掉 Yms）」 | 参数生效，慢的原因在别处 |
| `notes` 里「关不关耗时接近」+ `zhipu.latencyMs` 几十秒 | **通道本身拥挤/排队**，与 thinking 无关 |
| `deepseek.ok=true` | 降级通道可用，文章仍能入库，只是这条要花钱 |

> ⚠️ 别只看 `latencyMs` 几十秒就断定「thinking 没关掉」——
> 这正是加对照组的原因。2026-09-20 晚实测就两种都出现过。

##### 1302 与 1305 的区别（官方口径，别搞混 —— 处置完全相反）

官方文档 <https://docs.bigmodel.cn/cn/api/rate-limit> 的定义：

| 错误码 | 官方含义 | 是谁的问题 | 该做什么 |
|---|---|---|---|
| **1302** | 触发**用户**速率限制（`您的账户已达到速率限制`） | **你的账户**并发超上限 | 降并发 / 加排队；或在控制台提交[速率限制调整申请](https://bigmodel.cn/rate-limits/form)（10 个工作日审核） |
| **1305** | **平台服务过载**（`该模型当前访问量过大`） | **智谱自己**（与单一账户的调用行为无直接关系） | 什么都改不了：稍后重试 / 加长重试间隔 / 降级到别的通道 |

> 本项目 2026-09-20 遇到的**大部分是 1305**，也就是「不是你的问题」。
> 免费模型的并发上限本来就低（官方只说「各模型独立、随权益等级变化」，
> 具体数值要在下面那个页面看），**所以本项目翻译保持严格串行是正确姿势**，
> 不要为了提速去提并发 —— 那只会把 1305 变成 1302 再叠加付费降级。

**在控制台哪里看**（左侧栏没有这两项，都在右上角头像进去的用户中心里）：

| 想看什么 | 地址 |
|---|---|
| 本账户**各模型并发上限**（速率限制） | <https://bigmodel.cn/usercenter/proj-mgmt/rate-limits> |
| **用户权益等级**与积分 | <https://bigmodel.cn/usercenter/equity-mgmt/user-rights> |
| 免费额度/**资源包**到账情况 | 右上角头像 →「财务」→ 资源包（首页「系统管理」卡里也有入口） |
| 消费明细 | 右上角头像 →「财务」→ 费用账单 |

**2026-09-20 白天实测**：`ZHIPU_API_KEY` 配的是对的、`glm-4.7-flash` 也确认是当前免费文本主力
（200K 上下文 / 128K 输出，官方定价页单价 0 元，非限时活动），
但智谱持续返回 `429 / code 1302「您的账户已达到速率限制」`与 `1305「该模型当前访问量过大」`
（间隔 15 秒连测 8 次全部 429）。所以那段时间翻译大部分走了付费的 DeepSeek。
遇到这种情况：先按上表分清 1302/1305，再决定要不要去控制台调，**代码那边不用动**。

**2026-09-20 晚实测（结论已定）**：智谱偶尔能通时单次要 **17–25 秒**，
但 `reasoningChars = 0`（对照组反而 25 秒超时）——
**说明 `thinking: { type: 'disabled' }` 是生效的，慢的原因是免费档在排队/拥挤**。
所以：不要再去改 thinking 参数，那是白改；要提速只能换付费通道或限流时段错峰。

#### 信息源体检（零成本干跑，不写库不翻译）

```bash
curl -X POST "$URL/api/fetch-news" -H 'Content-Type: application/json' \
  -d '{"skipTranslation": true}'
```

`skipTranslation=true` 现在是**只采集、不入库、不调翻译**的干跑模式，
跑完 `GET /api/fetch-news` 读 `lastRun.summary.sourceCounts` / `sourceErrors`，
几分钟就能知道每个源（含 `Telegram/@xxx`）通不通。新增/替换信息源后先跑这个。

> 历史坑：这个参数以前**不是**干跑 —— 翻译块被跳过后，入库代码没有同步判断，
> 于是未翻译的原文（俄语、阿塞拜疆语…）会被直接写进生产库，并可能被下一轮推送出去。

#### 抓取耗时与等待上限（改了源就要重估）

2026-09-20 实测构成：纯采集（26 RSS + 12 Telegram）**156 秒**；翻译顺序执行、
一次一篇；逐篇取封面约 4 分钟。**翻译是唯一的变动量，按篇数线性增长。**

| 实测轮次 | 篇数 | 耗时 |
|---|---|---|
| 2026-09-20 白天 | 268 篇 | 73 分钟 |
| 2026-09-19 夜 | ~300 篇 | 89.5 分钟 |
| 2026-09-27（最坏，拥挤时段） | — | **37 秒/篇** ← `scheduler.ts` 的 `MEASURED_WORST_PER_ARTICLE_MS` 取自这里 |

即**约 16 秒/篇**（健康时段）～ **37 秒/篇**（拥挤时段）。两个变量任一个变大都会顶穿等待上限：
篇数、单篇耗时（智谱免费档拥挤时段单次要 17–25 秒，见 `/api/translate-check`）。

等待预算（2026-10-10 随「合并成日报」放宽，因为单轮候选翻倍）：
`FETCH_SOFT_WAIT_MS` = **240 分钟**、`FETCH_HARD_WAIT_MS` = **400 分钟**；
`PUSH_SOFT_WAIT_MS` = 20、`PUSH_HARD_WAIT_MS` = 40 分钟。硬上限的余量核算见
`scheduler.ts` 的 `mergedRoundWorstMs()`（600 候选 × 37 秒 = 370 分钟 vs 400 ⇒ **只剩 30 分钟**）。

⚠️ 这个值**必须显著高于实测耗时**：撞到硬上限后调度器**整轮不推送**
（不是「推一份缺国家的草稿」，而是**一整天没有草稿**，且静默）。
⚠️ 执行时刻是 **04:00 起跑**（2026-10-10 起）；典型 144 分钟 ⇒ 草稿约 **06:35**，
最坏 400 分钟 ⇒ 约 **10:50**。

> 📊 **「翻译到底占多少」现在有实测数（2026-10-10 加）**：抓取跑完会打一行
> `翻译耗时：X 分钟／N 篇 = Y 秒/篇（本函数总耗时 Z 分钟，翻译占 P%）`，
> 同一份数据也进了 `GET /api/fetch-news` 的 `lastRun.summary.timing`。
> 判读：`P%` 大 ⇒ 时间花在**等翻译 API** ⇒ 加并发收益大、降规格代价小；
> `P%` 小 ⇒ 时间花在**本地算** ⇒ 加并发没用，该查去重/判组/排版那几段。
> `Y 秒/篇` 与上面的 16 / 37 秒对照，可判断最坏值是否仍然成立。

> 取舍仍是刻意的：**宁可草稿晚一点，也不要在库半空时推。**
>
> ⚠️⚠️ **旧版这里写「真要压缩周期，唯一有效的手段是让翻译并发」——那句话已作废，
> 而且与同一份文档下面那句「不要为了提速去提并发」自相矛盾。**
> 作废依据（实测，不是推测）：`scripts/fixtures/judge-repro-2026-10-07_10-08.json` 原文写着
> 「ok=false（实测 HTTP 429 / **code 1302 账号级限流**）…**并发发起请求会稳定触发这个状态**
> （实测 **3 个并发里有 2 个中招**）；要重跑就串行」。`1302` 是**账号级**的，
> 而判组与翻译共用**同一个智谱账号** ⇒ 我们的并发上限实测约为 **1**。
> 提并发 ⇒ 大概率 1302 ⇒ 降级到付费 DeepSeek ⇒ **更贵，而且不一定更快**。
>
> ★★ **真正的第一杠杆：翻译前先按库内身份去重（已实现，开关 `DEDUP_BEFORE_TRANSLATE`，默认关）。**
> 现在每轮是「采集 → **翻译整个候选集** → 第三步才去重」，所以**库里早就有的稿子也会被
> 完整翻译一遍再由闸 2 丢掉**。这是**实测**的规模，不是估计：线上
> **`dedup.againstDb = 85`**（2026-09-24 19:00 那轮，见 `AGENTS.md`），
> 按实测 37 秒/篇 ≈ **52 分钟/轮**，外加 85 篇的翻译费。
> 而「是不是库内重复」只用两个**翻译前**字段（`item.link`、`original_title`）就能判定 ⇒
> 这部分判断排在翻译后面没有任何理由。
> 改法：翻译循环**之前**查一次身份窗口（存 `preKnown*`，与闸 2 的 `existing*` 分开），
> 循环里命中即跳过（不抓 og:image、不翻译）；**闸 2 原封不动**，正确性仍由它负责。
> ⚠️ 「输出集合不变」这条**有前提**（原先在本文件里被写成了无条件的，是错的）：
> 前置窗口必须**严格窄于**闸 2 的窗口，且前置集合是其子集 —— 两条的算术与反例
> 见 `src/lib/dedup-before-translate.ts`，那里也是唯一该改这条逻辑的地方。
> 探测失败只会「没省下时间」（`preKnownOk = false` ⇒ 照旧全译），**不会丢稿**。
>
> ⇒ 正确顺序：**① 关闭态拿基线（`durationMs` + `timing`）→ ② 开 `DEDUP_BEFORE_TRANSLATE`
> 再量一轮 → ③ 才轮到降规格。**「加并发」已从这条路线上划掉（见上）。
> （降规格是同一个问题的另一条路：它省钱但把轮次拉长 ⇒ 窗口要变宽 ⇒ 省的又被吃掉；
> 而且算过余量只有 8.1%，见 `container.config.json` 的降规格段。
> ⚠️ 去重前置打掉的 52 分钟**不足以**把 8.1% 那道算术关变成「安全」—— 别把两者混为一谈。）
>
> ✅ **在开跑之前先确认开关真的生效（2026-10-10 加，省掉一次 2.5 小时的空跑）**：
> `GET /api/fetch-news` 多了一段 `knobs`，一条 curl 就能问清楚：
> ```
> curl -s "$URL/api/fetch-news" | grep -A6 '"knobs"'
>   → knobs.dedupBeforeTranslate = { switch, windowDays, effective }
> ```
> · `effective` = 「下一轮真跑会不会走这条路」；为 `false` 时看是 `switch`（环境变量没设／写法
>   不被识别）还是 `windowDays`（这份配置收不出安全更窄窗口）——**两者修法不同，别混**。
> · 它**不受**「只能在 03:45–11:15 窗口内读」的限制（那条限制属于 `lastRun`）：
>   `lastRun` 是模块级内存态，缩容到 0 就没了；而**环境变量是容器级配置**，冷启动的新容器
>   身上也是同一份 ⇒ 任何时刻读都准。这正是它值得存在的理由。
> · 这个接口无副作用 ⇒ 也是保活 ping 的正确靶子（⚠️ 别把 ping 打到 POST，那是一打就跑一轮）。

##### ⚠️ 等待逻辑踩过的坑：状态要取 `body.lastRun`，不是整个响应体（2026-09-20 已修）

`GET /api/fetch-news` / `GET /api/wechat/push` 返回的是一个**信封**，状态一律在 `body.lastRun` 里：
- `fetch-news` → `{ message, usage, dryRunHint, sources, knobs, lastRun }`
- `wechat/push` → `{ ..., codeVersion, ..., lastRun }`

⚠️ 两个信封里除了 `lastRun` 还有别的**看起来像状态**的字段（`fetch-news` 的 `knobs`、
`wechat/push` 的 `codeVersion` 与各类计数）⇒ 更容易把顶层字段当成 `running` / `finishedAt` 用。
调度器（`lib/scheduler.ts`）和流水线（`api/pipeline/route.ts`）原先都把整个响应体当状态用，
于是 `state.running` / `state.finishedAt` **恒为 undefined**，完成判据永远为假 ——
不报错，只是**每一轮都干等到超时上限**。

实测症状（19:00 那轮）：抓取 19:00 启动、20:13 就跑完了，但到 20:19 推送那一步还没开始，
**草稿箱自然是空的**；日志里只有「已触发」，后面什么都没有（旧代码等待期间一行都不打）。

排查口诀：日志里出现 `running=undefined` 就是这个问题。修完的判据是
`body.lastRun`，并带 `?cb=` 破坏缓存；等待期间每 2 分钟打一行
`仍在等待XX（已等 N 分钟）: running=... finishedAt=...` 作为哨兵。

修好之后，典型一轮是「抓取 73–90 分钟 + 推送 ~10 分钟」——
当年那两轮的草稿分别约 **08:25 / 20:25** 出现（修之前是 09:40 / 20:40）。

📌 **2026-10-10 起只剩 04:00 一轮「日报」**，且回看窗口从 12h 变 24h ⇒ 单轮候选翻倍、
抓取时长升到 **75–400 分钟**（典型约 144）⇒ 草稿约 **06:35** 出现、最坏约 **10:50**。
（等待上限也早已不是这里的 150 分钟：现在是软 240 / 硬 400 分钟，
见 `src/lib/scheduler.ts` 与 AGENTS.md 的「定时任务」一节。）

#### Telegram 接入（原步骤，保留备查）

Telegram（t.me / api.telegram.org）在大陆网络不可达（本项目部署于微信云托管），
代码里已经留好了 **Cloudflare Worker 转发桥** 的接口，仓库里 `telegram-worker/worker.js`
就是现成的 Worker 源码（读 t.me 公开预览页，**不需要 Bot Token**，任何公开频道都能读）。
步骤、频道白名单、以及上面那条「workers.dev 不可达」的实测结论，见本节的说明。

> **只需要配 `TELEGRAM_WORKER_URL` 这一个变量。** 频道表在 `src/lib/telegram-channels.ts`
> 的 `DEFAULT_TELEGRAM_CHANNELS` 里已经有 12 个**实测可用**的频道，`TELEGRAM_CHANNELS`
> 只在要临时改名单时才需要写。配好后用 `GET /api/telegram-check` 验证，不要靠猜。

微信云托管在大陆网络连不上 `t.me`，代码里已经留好了 **Cloudflare Worker 转发桥** 的接口，
仓库里 `telegram-worker/worker.js` 就是现成的 Worker 源码（读 t.me 公开预览页，
**不需要 Bot Token**，任何公开频道都能读）：

1. 登录 [dash.cloudflare.com](https://dash.cloudflare.com) → Workers & Pages → Create Worker
2. 把 `telegram-worker/worker.js` 的内容整个贴进在线编辑器 → Deploy
3. 拿到形如 `https://xxx.yyy.workers.dev` 的地址
4. 云托管控制台加环境变量 `TELEGRAM_WORKER_URL = https://xxx.yyy.workers.dev`
5. 验证：`curl "https://xxx.yyy.workers.dev/?channel=@tengrinews"` 应返回 `{"posts":[...]}`

> **只需要配 `TELEGRAM_WORKER_URL` 这一个变量。** 频道表在 `src/lib/telegram-channels.ts`
> 的 `DEFAULT_TELEGRAM_CHANNELS` 里已经有 12 个**实测可用**的频道（见下表），
> `TELEGRAM_CHANNELS` 只在要临时改名单时才需要写。
>
> 本环境已有一个现成的 Worker：`https://telegram-proxy.cedriczhou777.workers.dev`
> （页面上的 `worker.js` 就是上面第 2 步贴的代码，已实测可返回文章）。

##### 已验证的频道名单（2026-09-19 逐个实测）

| 国家 | 可用频道 | 说明 |
|------|---------|------|
| kz | `@tengrinews` | 最大民营新闻社 |
| uz | `@kunuzofficial` `@gazetauz` `@spotuz` | Spot.uz 是商业财经口径 |
| kg | `@akipress` `@economist_kg` `@sputnik_kyrgyzstan` | Economist.kg 偏商业 |
| tj | `@asiaplus` `@sputnik_tajikistan` | Khovar 通讯社无公开频道 |
| az | `@apa_az` `@qafqazinfo` `@banker_az` | Banker.az 是金融财经 |

**实测拿不到内容的频道，别再往里加**（返回 `{"posts":[]}`）：
`@kabar_kg`、`@tazabek`、`@vesti_kg`、`@24kgnews`、`@khovar`、`@ozodi_org`、
`@tajikistan_news`、`@azertac`、`@trend_az`、`@modernaz`、`@haqqinaz`。
加进去不会报错，只会让 `sourceErrors` 里常年挂一条「Worker 返回 0 条」的噪音。

**每个频道只取最新 8 条**（`TELEGRAM_MAX_PER_CHANNEL`，见 `fetch-news/route.ts`）：
Worker 一次返回预览页最近 ~20 条，而且抓取端**不做截断**（每篇候选都要单独跑一次
LLM 翻译），不限量的话 12 个频道 = ~240 条原文进去，翻译费和一整轮耗时会翻几倍。

配好后怎么确认它真的在跑：`GET /api/fetch-news` 的 `lastRun.summary.sourceCounts` 里
会出现 `Telegram/@tengrinews(kz)` 这类源名；没配 Worker 时 `sourceErrors` 里会有一条
`Telegram（未启用）`。**不需要进控制台翻日志。**

**Instagram 没有等价的免认证公开接口**，不做伪造接入；需要的话走
Meta Graph API + 商业账号授权，另议。

#### 型号代号会过期（加凭据配置时必查）

**只加 Key、不管型号 = 通道等于没有**，而且**不会报错到你面前** ——
只在日志里留一行 `[deepseek/xxx] 请求失败 400`，然后翻译链直接判失败、文章不入库。

已踩过两次：

| 位置 | 写死的型号 | 现状 |
|------|-----------|------|
| `src/lib/translate.ts` | `deepseek-chat` | 已被官方下线。在售型号只剩 `deepseek-flash`（V4.1-Flash）和 `deepseek-v4-pro` |
| `src/app/api/daily-digest/route.ts` | `glm-4` | 不在免费档，且厂商换代号后会静默失效（已改成跟 `ZHIPU_MODEL` 同口径） |

所以规矩是：**代号永远以厂商控制台「模型与价格」页为准**，
智谱用 `ZHIPU_MODEL`、DeepSeek 用 `DEEPSEEK_MODEL` 覆盖，不必改代码。
型号只在 `src/lib/translate.ts` 的 `PROVIDERS` 里定义一处，`pnpm test:translate` 会打出实际用的型号。

> **推送不需要任何变量。** 代码走微信**云调用**：由云托管侧拦截 `api.weixin.qq.com`
> 完成鉴权，既不需要 `access_token`，也不需要 AppID / AppSecret。
> 所以 `WECHAT_APP_ID`、`WECHAT_APP_SECRET`、`USE_WECHAT_CLOUD_CALL`、`WECHAT_CLOUD_KEY`
> 这几个变量**代码根本不读**（`grep -r "WECHAT_APP_ID" src` 是空的），留着无害，
> 但别指望改它们能影响推送行为。真正要做的控制台配置见 6.4 节。

**关于翻译**：`COZE_API_TOKEN` 已随扣子 SDK 一并移除。Key 在 <https://open.bigmodel.cn> 控制台申请。

### 3. 上传代码

**方式一：Git 仓库（推荐）**
1. 将代码推送到 Git 仓库（GitHub/GitLab）
2. 在云托管控制台选择 **从 Git 仓库部署**
3. 填写仓库地址和分支

- 仓库地址：`https://github.com/cedriczhou777/central-asia-news.git`
- **控制台里绑定的那个「分支」决定了推哪里才会触发部署**，务必先在
  控制台 → 服务设置 → 部署配置里核对一遍。绑的是哪个分支，就推哪个分支，
  推错分支不会报错，只是「没有任何变化」——这是最容易白等一轮的地方。

**方式二：本地上传**
1. 在项目根目录执行：
```bash
# 打包代码（正常约 280KB / 139 个文件）
tar -czf deploy.tar.gz \
  --exclude=node_modules --exclude=.next --exclude=.git \
  --exclude=deploy.tar.gz --exclude=assets --exclude=dist \
  --exclude=tsconfig.tsbuildinfo .
```

> **`--exclude=assets` 不能省**：`assets/` 里是 49MB 的聊天截图和导出日志，
> 跟应用运行毫无关系，但它在 `.gitignore` 里**却已经被历史提交跟踪过**
> （gitignore 不会让已跟踪的文件失效），所以 tar 默认会把它全打进去 ——
> 打出来的包会是 **42MB** 而不是 280KB，上传和构建都白等。
> 打完顺手校验一下大小：`ls -lh deploy.tar.gz`。
>
> （另：`--exclude=deploy.tar.gz` 也必须加，否则 tar 会把上一次的包打进新包里，
> 报 `Can't add archive to itself` 并产生一个 42MB 的怪物包。）

```bash
# 在云托管控制台上传 deploy.tar.gz
```

### 4. 保活：靠「定时扩缩容」，**不是**触发器

> ⚠️⚠️ **2026-10-10 17:34 已确认：云托管控制台里没有「触发器」这个入口。**
> 服务设置下只有 基础信息 / 流水线 / 镜像仓库；顶层导航只有
> 部署发布 / 云端调试 / 运行日志 / 服务监控 / 服务设置。
> ⇒ 本节旧版写的「在控制台 → **触发器** → 创建触发器」**指向一个不存在的菜单**，
> `container.config.json` 里那三条 `warmup-daily-*` **平台从未读取过**。
> ⚠️ 我们当时把它当成「**兜底**」——**那是错的，它从来不是兜底。**
>
> **真正的机制是另一条：服务设置 → 定时扩缩容。** 现配置（2026-10-10 核实）：
>
> | 项 | 值 |
> |---|---|
> | 定时扩缩容 | **开**（绿色开关） |
> | 规则 | 每日 **03:45 → 11:15**，扩容至 **1** 个实例，状态「生效中」 |
> | 最小实例数 / 最大实例数 | **0 / 1** |
> | 扩缩容条件 | CPU 使用率 **≥ 95%** |
> | 容器规格 | **1 核 2G**（控制台 tooltip 原文：CPU 与内存比例 **1:2**） |
>
> ⇒ 窗口内实例被规则**钉住**（不需要任何 ping）；窗口外「30 分钟无入站请求缩容到 0」照常生效。
> ⚠️ **这是单点，没有任何兜底**：规则不生效 ⇒ 整轮不跑 ⇒ **一整天没草稿，而且失败是静默的**。
> ⇒ 草稿没出来时，**第一件事是确认 03:45 那一刻实例有没有起来**
> （服务监控 / 运行日志看有没有那次冷启动），**不是**先怀疑抓取或翻译。

业务时刻表（由**应用内调度器** `src/lib/scheduler.ts` 执行，与上面的窗口是两件事）：

> 真正的抓取 + 推送由**应用内调度器**负责（`src/lib/scheduler.ts`）。
> **2026-10-10 起每天只有一轮「日报」**（原来的 07:00 早报 + 19:00 晚报已合并成一轮，
> 合并的原因与代价见 `src/lib/publish-schedule.ts` 的头部注释）：
>
> | 时段 | 触发（北京时间） | 回看窗口 |
> |------|----------------|---------|
> | 日报 | **04:00** | 24 小时（昨日 04:00 → 今日 04:00） |
>
> 每次是**先抓取、等抓完再推送**。抓取一轮实测 75–185 分钟（不是几分钟；
> 2026-09-24 那轮 185 分钟，原因是上游 429 重试），而合并后单轮候选翻倍、
> 硬上限放到 400 分钟（见 `scheduler.ts`），再加推送 ~10 分钟，
> 所以**草稿通常在 06:35 左右出现，最坏 10:50**，而不是 04:00 整。
> 这段延迟是设计内的，别当成故障。
>
> ⚠️ 窗口必须**比业务时刻表更宽**：它要覆盖「冷启动 + 最坏轮次 + 推送 + 余量」。
> ⚠️ **窗口长度 = 计费时长**（实例被钉住的每一分钟都算钱）⇒ **收窄窗口是省钱的主要手段**，
> 但它只能跟着「最坏轮次」收窄，**不能贴着典型时长收**（收进去就是丢一整天）。
> ⚠️ 触发时刻与回看窗口**不再需要手工同步**：窗口由时刻表的钟点推导（`scheduledWindow()`），
> `hours` 只是交叉校验值。
> ⚠️ 改时刻表要**同步改控制台那条定时扩缩容窗口**（清单见 `src/lib/publish-schedule.ts` 头部）。

**历史（保留备查，别再照做）**：旧版这里挂着 4 条 `{"action":"fetch-and-push"}` 的触发器，
但**代码里没有任何地方处理这个 payload**——看着在定时抓取，实际什么都没干，已清理。
**看到旧名字就是没删干净。** 后来改成 3 条 `warmup-daily-*` 做「预热 / 保活」，
**但那同样是空转：平台根本没有触发器这个功能。**

<!-- 旧版正文（已作废）：下面是那段「创建触发器」的步骤表，留档说明它错在哪。 -->

**⛔ 以下步骤不要执行 —— 这个菜单不存在**（2026-10-10 17:34 确认）。

旧版写「在云托管控制台 → **触发器** → **创建触发器**」，并列出三条：

| 触发器名称 | Cron 表达式 | 旧版说明 |
|-----------|------------|------|
| `warmup-daily-head` | `45 19 * * *` | 北京时间 03:45（UTC 前一日 19:45），唤醒，给 04:00 的 cron 留出注册时间 |
| `warmup-daily-core` | `0,15,30,45 20,21,22,23,0,1,2 * * *` | 北京 04:00–10:45（UTC 20:00–02:45），主体保活 |
| `warmup-daily-tail` | `0,15 3 * * *` | 北京 11:00 / 11:15（UTC 03:00 / 03:15），覆盖硬上限 + 推送 |

**为什么作废**：控制台里**没有「触发器」入口**（服务设置下只有 基础信息 / 流水线 / 镜像仓库），
所以这三条**一条都没被创建过**，`container.config.json` 里那一段也从没被平台读取。
旧版还写着「这三条只有在控制台里真的存在才有用」—— 那句话是对的，**但它没有引出「那就去确认」这个动作**，
反而被当成了「保活有人做」。⇒ 保活实际由 **定时扩缩容** 承担（见本节开头）。

⚠️ 仍然成立的两条原则（**换任何机制都适用**）：
- **预热的请求必须打在无副作用的接口上** —— 绝不能指向 `/api/fetch-news` 或 `/api/wechat/push`，
  那两个是「一打就跑一轮」，会真的多抓一次 / 多建一份草稿。
- **提前量 ≥15 分钟**不是保守：`node-cron` 在**容器启动时**注册，而 `0 4 * * *`
  只在 **04:00:00 那一秒**触发；容器若 04:00:30 才起来，这一轮**整个被跳过**。
  合并成日报后跳过 = **一整天没有草稿**。⇒ 定时扩缩容窗口从 03:45 起，就是这个道理。
- ⚠️ **写在 `container.config.json` 里 ≠ 在平台生效**（本项目经典坑，这次又栽了一次，
  而且这次更彻底：那个字段对应的**功能本身就不存在**）。

**注意**：Cron 表达式使用 UTC 时间，北京时间 = UTC + 8。
如果窗口机制不可靠，兜底是把 `container.minNum` 改成 `1`（实例常驻）——
但那是**用钱买确定性**：常驻 1核2G ≈ **¥85.7/月**，是现方案（¥26.8/月）的 3.2 倍。

### 5. 配置数据库

如果使用 Supabase：
1. 在 Supabase 创建项目
2. 执行 `src/storage/database/shared/schema.ts` 中的建表语句
3. 将连接信息填入环境变量

### 6. 验证部署（在云托管上调试）

部署完成后，按这个顺序验，每一步都能定位到具体是哪一环坏了。
**全部看云托管的日志页，不要只看 HTTP 响应**。

#### 6.1 确认服务起来了

**访问地址怎么找**（控制台里没有叫「访问地址」的独立菜单）：

1. 进云托管控制台，左侧选到服务 `central-asia-news`
2. 顶部页签切到 **服务设置**（有的版本叫「设置」）
3. 往下找 **默认域名 / 公网访问** 一栏 —— 打开它旁边那个开关，域名就在同一行
4. 当前这个环境的域名是
   `https://central-asia-news-307705-12-1480606601.sh.run.tcloudbase.com`
   （结尾固定是 `.sh.run.tcloudbase.com`）

> 控制台提示「测试期间默认域名有效期至 2026/09/04」——**这条提示可以忽略**，
> 它只约束「小程序/公众号后台里回填请求域名」的场景，不影响直接用浏览器或 curl 访问。
> 要续期就点提示后面的「点击续期」。

如果服务不对外，就看日志里有没有：

```
> Server listening at http://central-asia-news-056:3000 as production
启动定时任务调度器...
已注册公众号推送任务：0 4 * * * (凌晨 04:00（日报）)，窗口 2026-10-09T20:00:00.000Z → 2026-10-10T20:00:00.000Z（24h，按时刻表固定）
共注册 1 个定时任务
```

（窗口两端的 ISO 时刻每次启动按当天算，所以那两个时间戳会逐日变化，**长度恒为 `（24h，按时刻表固定）`**。）

- 看到「共注册 **1** 个定时任务」= 版本对了（2026-10-10 合并成日报后只有一段）。
  **如果是 2 个（`0 7` / `0 19`）或 4 个，说明部署的还是旧代码。**
- 看到「`（24h，按时刻表固定）`」= 窗口由时刻表钟点推导这条设计已生效。
  **如果是「回看 12 小时」或「回看 24 小时」（老格式），说明跑的是旧版本。**
- 两行 `⚠️ 时刻表不一致` **不应该出现** —— 出现说明有人只改了 cron 没改 `hours`。
- 完全看不到这几行 = 实例被缩容到零了，发一次请求把它唤醒再看。

> 最省事的版本判据其实是 `GET /api/wechat/push` 响应里的 `schedules` 字段
> （它由路由直接报出代码里的时刻表）：新版是**一条** `{"cron":"0 4 * * *", ...}`，
> 老版是两条 `0 7` / `0 19`。一条 curl 就能确认，不用翻日志。

#### 6.2 探活接口（不写库）

```bash
curl https://central-asia-news-307705-12-1480606601.sh.run.tcloudbase.com/api/fetch-news
curl https://central-asia-news-307705-12-1480606601.sh.run.tcloudbase.com/api/pipeline
```

都该返回 `HTTP 200` + 一段 JSON 说明。

#### 6.3 真实抓一次（不推送，先验证抓取+翻译）

```bash
curl -X POST https://central-asia-news-307705-12-1480606601.sh.run.tcloudbase.com/api/fetch-news \
  -H 'Content-Type: application/json' \
  -d '{"minPerCountry": 3}'
```

> 这个接口是**立即返回、后台处理**，响应里只有「任务已启动」，
> **真正的结果要么在日志里、要么在 `lastRun` 里**。不知道这点会以为它没跑。
>
> 想看结果就 GET 同一个地址，读 `lastRun`（字段含义见下面「抓取到底跑完没有？」那条）。

```bash
# 轮询到 running=false 就是本轮跑完了
curl -s https://central-asia-news-307705-12-1480606601.sh.run.tcloudbase.com/api/fetch-news \
  | python3 -c 'import sys,json; s=json.load(sys.stdin)["lastRun"]; print(s["running"], s["finishedAt"], (s.get("summary") or {}).get("saved"), s.get("error"))'
```

日志里应出现完整的漏斗：

```
新闻抓取完成：日期=2026-09-16｜原始采集 312 篇 → 投资相关候选 87 篇
  → URL 去重剔除 41 篇 → 内容去重剔除 6 篇 → 实际入库 40 篇
各源采集量：The Astana Times=25 | Gazeta.uz=18 | ... | Asia-Plus=12
```

**怎么读这条日志：**

| 现象 | 说明 |
| --- | --- |
| `→ 实际入库 0 篇`，且候选数不为 0 | **翻译链路断了**。往上翻有没有 `ZHIPU_API_KEY` 相关报错、或者 429（欠费/限流） |
| 原始采集就是 0 | 抓取源全挂了，往上翻各源的报错 |
| 末尾出现 `N 个信息源采集失败：...` | 部分源失败，不影响其余，正常容忍 |
| 各源采集量里 Telegram 是 0 或多个频道未出现 | 看有没有 `Telegram 待抓取频道（共 N 个）` 这行，没有就是 `TELEGRAM_WORKER_URL` 没配 |

#### 6.4 全链路 + 推送

**推送前必须在控制台做两件事**（这是云调用，不是环境变量能解决的）：

1. 确认该服务已开通**微信开放接口服务**（云调用），并把公众号授权给这个环境
2. 把用到的接口路径加进白名单，一共两个：
   - `/cgi-bin/draft/add` —— 建草稿
   - `/cgi-bin/material/add_material` —— 上传正文图片/封面到微信素材库

> 少了第 2 步的典型症状：日志里能看到 `公众号推送失败`，或者草稿建出来了但正文图片全没了。

确认 6.3 能入库之后：

```bash
curl -X POST https://central-asia-news-307705-12-1480606601.sh.run.tcloudbase.com/api/pipeline \
  -H 'Content-Type: application/json' \
  -d '{"push": true}'
```

> **这个接口也是「立即返回、后台跑完」的**（和 fetch-news 一样）。响应里只有
> 「流水线已启动」，真正的进度和结果要 GET 同一个地址、读 `lastRun.steps`。
>
> ⚠️ **别对着公网域名等它跑完**：整条链是「抓取（十几分钟）→ 日报 → 推送」，
> 网关 65 秒就把连接切了，curl 只会拿到 `HTTP 504 Gateway Time-out`。
> 那**不代表任务失败** —— 请求在服务端照样继续跑到结束，只是响应送不回来。
> 判断成功与否的唯一办法是轮询 `lastRun`。

```bash
# 边跑边看进度：steps 是逐步日志，running=false 就是整条跑完了
curl -s https://central-asia-news-307705-12-1480606601.sh.run.tcloudbase.com/api/pipeline \
  | python3 -c 'import sys,json; s=json.load(sys.stdin)["lastRun"]; print("running=",s["running"]); [print(" ",l) for l in s["steps"]]; print("error=",s["error"])'
```

跑完后 `lastRun.steps` 应形如：

```
[2026-09-18T...] 开始采集新闻...
[2026-09-18T...] 采集已触发：{"success":true,...}
[2026-09-18T...] 采集完成：{"saved":40,"sourceCounts":{...}}
[2026-09-18T...] 开始生成各国日报...
[2026-09-18T...] 日报生成完成：5 个国家
[2026-09-18T...] 开始推送微信公众号草稿（按国别分组）...
[2026-09-18T...] 公众号推送完成：{"drafts":[...5 个...],"failures":[]}
```

> `steps` 里带的是**真实结果**，不是「已触发」。旧实现在异步接口出现后读的是启动响应，
> 日志会写成「采集完成：共入库 undefined 篇文章」——看着像成功，其实什么都没读到。

只补推送（不重跑抓取和日报）就直接调推送接口：

```bash
curl -X POST https://central-asia-news-307705-12-1480606601.sh.run.tcloudbase.com/api/wechat/push \
  -H 'Content-Type: application/json' \
  -d '{"hours": 24, "period": "manual"}'

# 结果同样靠 GET 拿
curl -s https://central-asia-news-307705-12-1480606601.sh.run.tcloudbase.com/api/wechat/push \
  | python3 -c 'import sys,json; s=json.load(sys.stdin)["lastRun"]; print("running=",s["running"],"dur=",s["durationMs"],"ms"); print("drafts=",[d["country_name"] for d in (s.get("summary") or {}).get("drafts",[])]); print("failures=",(s.get("summary") or {}).get("failures")); print("error=",s.get("error"))'
```

> **人工补推一律用 `{"hours": N, "period": "manual"}`。**
> `manual`（或干脆不带 `period`）走的是「执行时刻 − N 小时」的**浮动窗口** ——
> 「从现在往回数 N 小时」正是补推要的语义。
>
> ⚠️ **不要写 `"period": "morning"` / `"evening"`**：那两段定时时段已在 2026-10-10 取消，
> 现在它们**不在时刻表里** ⇒ `scheduledWindow()` 返回 `null` ⇒ **静默退回浮动窗口**，
> 但标题后缀仍会显示「早报 / 晚报」。也就是说：**跑起来看着正常，实际窗口是浮动的**
> （正是缺陷 19 那个形态）。定时那一轮的窗口（日报 24h）由应用内调度器自己传，不用手写。
>
> 一轮推送要做「逐篇下载外链图 → 转码 → 传微信素材库 → 建草稿」，实测远超 65 秒，
> 所以**手动调也一定会遇到 504**，照上面轮询 `lastRun` 即可。

然后去公众号后台的草稿箱确认。

**推送失败是本地必然、云上才通**：代码走的是微信云调用（免 IP 白名单、免 access_token），
依赖云托管侧拦截 `api.weixin.qq.com`。所以「本地推不出去」不代表代码有问题。

#### 6.5 等一次真实定时

上面都通了，再等下一个 **04:00**（北京时间）看是否自动触发。日志关键词：

```
触发公众号推送任务 (凌晨 04:00（日报）)
开始抓取当天新闻...
新闻抓取已触发: {"success":true,...}
新闻抓取完成: {"saved":40,"sourceCounts":{...}}
开始执行微信公众号推送任务（时段 daily，回看过去 24 小时）...
微信公众号推送：2026-10-11 日报，汇总 ...T20:00:00.000Z 至 ...T20:00:00.000Z（过去 24 小时）
微信公众号推送完成: {"drafts":[...],"failures":[]}
```

> 注意是「**已触发**」和「**完成**」两行 —— 调度器触发了异步接口后会轮询到这一轮真正结束
> 才往下走，所以日志里能看到 `drafts` / `failures` 的真实内容。
> 只有「已触发」没有「完成」，说明等超时了（抓取软上限 240 / 硬上限 400 分钟、
> 推送软上限 20 / 硬上限 40 分钟），日志里会有
> `等待...超过 N 分钟仍未结束，不再等待` 的 warn。
>
> ⚠️ 抓取没在**硬上限**内跑完时，`runPublishCycle` **整轮不推送**（宁可晚，也不推一份缺国家的稿子）。
> 所以那种情况下日志里**不会有「推送完成」那一行**，只有早退的 `console.error`
> 和「手工补推」指引 —— 看到它就去跑上面那条 `period: "manual"` 的 curl。

推送完成后到公众号草稿箱确认：一天应该只有 **5 个草稿**（5 个国家各 1 个），
标题形如 `哈萨克斯坦 - 2026-10-11 日报 投资资讯`；人工补推的是 `... 补报 ...`。

## 常见问题

### Q: 某个国家今天没推送？
A: 按顺序查三样（都能用 `GET` 拿到，不用进控制台）：

1. **该国有多少篇入库**：`GET /api/articles?country=<kz|uz|kg|tj|az>&date=<YYYY-MM-DD>&limit=200`。
   `count=0` → 问题在采集，看第 2 步；有文章 → 问题在推送，看第 3 步。
2. **该国的源死了没有**：`GET /api/fetch-news` 的 `lastRun.sourceCounts` / `sourceErrors`。
   RSS 源会死（404/410 是常态，媒体改版就断）—— 2026-09-19 吉尔吉斯两个源同时 410/404，
   断流 9 天才被发现。发现死源：找个活的 RSS 替换 `src/app/api/fetch-news/route.ts` 里
   `RSS_SOURCES` 的对应条目（先 curl 确认 200 且解析得出 item）。
3. **推送那一轮的失败记录**：`GET /api/wechat/push` 的 `lastRun.summary.failures`。

另外注意**时序**：调度器是「先抓取（实测 75–185 分钟）→ **等抓完** → 再推送」。
⚠️ 抓取没在**硬上限（400 分钟）**内跑完时，**整轮不推送**（2026-09-27 起就是这样：
宁可晚，也不推一份缺国家的稿子）。所以「该国没推」现在只可能是
① 采集侧没抓到这个国家的稿，或 ② 选稿判据把它挡了 —— **不再是「推送抢跑」**。
（想逐条看是哪一类，用 `pnpm diagnose:push`，见 6.6。）

### Q: 草稿箱里同一个国家出现两份标题相同的草稿？
A: 这是修复前的旧行为，三个成因已一并修掉：
1. 两次推送都用「过去 24 小时」窗口，中间 13 小时重叠 → 改成两段首尾相接不重叠
   （当时是 13h + 11h；2026-09-24 早报由 08:00 提前到 07:00 后改为 12h + 12h）；
   **2026-10-10 起进一步合并成一天一轮（04:00 日报、窗口 24h）**，重叠这件事在结构上消失了。
2. 标题里的日期取的是 **UTC 日期**，当年两次触发（北京 08:00 与 19:00）落在同一个 UTC 日 →
   改成按 `Asia/Shanghai` 出日期，并加上时段后缀。
3. **两段时段的后缀本身也是一个来源**：旧版同一份稿子可能既带「早报」又带「晚报」。
   合并后自动那轮是「日报」，人工补推是「补报」，一天里只有这两种。

⚠️ 版本判据（别记反了）：新版注册日志是 **`0 4 * * *` + `共注册 1 个定时任务`**。
看到 **`0 7` / `0 19`** 或「共注册 2 个」= 线上还是合并前的旧版本。

### Q: 云调用失败怎么办？
A: 检查控制台（**都不是环境变量**）：
1. 微信开放接口服务（云调用）是否已开通、公众号是否已授权给这个环境
2. 接口路径白名单是否加了 `/cgi-bin/draft/add` 和 `/cgi-bin/material/add_material`
3. 错误码对照：`40001/40014` = 未授权或走了普通 HTTP 调用（不是云调用）

> 注意：`USE_WECHAT_CLOUD_CALL=true` 这种写法**在代码里没有任何作用**，
> 云调用的开关只在控制台，不在环境变量。

### Q: 定时任务不执行？
A: 按顺序检查：
1. 日志里有没有 `共注册 1 个定时任务`。没有 = 实例被缩容到零，应用内定时器随进程一起没了。
   ⇒ 这时要查的是**控制台 → 服务设置 → 定时扩缩容**那条规则（现在应为
   「每日 **03:45 → 11:15**、扩容至 1 个实例」、开关为**开**），
   以及 **03:45 那一刻实例有没有真的起来**（服务监控 / 运行日志里有没有那次冷启动）。
   ⚠️ **别去查「触发器」—— 控制台没有这个入口**（2026-10-10 17:34 确认）。
   `container.config.json` 里那三条 `warmup-daily-*`（`45 19 * * *` /
   `0,15,30,45 20,21,22,23,0,1,2 * * *` / `0,15 3 * * *`）**平台从未读取过**，
   **它们不是兜底**（旧版这一段就是据此写的排查建议，方向是错的，已改）。
   ⚠️ **合并成日报后「没跑到」= 一整天没草稿**，所以窗口起点提前到 03:45 比原来更要紧。
2. 有这行但到点没动 = 看有没有 `触发公众号推送任务` 这行，再看后续报错。
3. **触发了、抓取也跑了，但推送迟迟不开始** → 看日志里有没有 `running=undefined`：
   那就是「状态读成了响应信封、完成判据永远为假、每轮干等到超时」那个坑
   （见上面「等待逻辑踩过的坑」一节）。正常应看到 `仍在等待XX（已等 N 分钟）: running=true`，
   抓取跑完后紧跟一行 `新闻抓取完成（等了 75 分钟）`，然后才开始推送。
4. 嫌窗口机制不可靠，可以让实例常驻：把控制台的**最小实例数改成 1**。
   ⚠️ 这是**用钱买确定性**：常驻 1核2G ≈ **¥85.7/月**，是现方案（¥26.8/月）的 **3.2 倍**。
   （旧版这里写「代价是免费额度 30 天就烧完」——**那个前提已经不成立**：
   额度是**一次性**的、**2026-10-08 就已用尽、不会再来**，所以现在就是全额付费。）
   推荐顺序是**先做「定时扩缩容」再关常驻**，完整三步与成本对照写在 `container.config.json` 上半部分。
5. 某一轮失败导致那一段新闻没推：手动补一次
   `curl -X POST https://central-asia-news-307705-12-1480606601.sh.run.tcloudbase.com/api/wechat/push -H 'Content-Type: application/json' -d '{"hours": 24, "period": "manual"}'`
   —— 这个接口是异步的，curl 很可能报 504，**别当成失败**，结果用 `GET` 读 `lastRun`（见 6.4）。
   ⚠️⚠️ **补推同样需要实例活着**（2026-10-10 补上的前置条件）：抓取全程是**出站**
   （拉 RSS/Telegram → 调翻译 API），平台侧看不到任何入站请求，`minNum=0` 时
   「30 分钟无请求就缩容到 0」照常生效 ⇒ 补推会死在中途。
   ⇒ **补推只有在窗口内（北京 03:45–11:15）才真正可行**。发现得晚、窗口已过时，
   顺序必须是：**① 先把定时扩缩容的时段临时放宽**（覆盖接下来 6 小时）**② 再**触发抓取 → 等 `finishedAt` → 再推。
   反过来（先推、后放宽）就是白跑一轮，而且**失败是静默的**（没有报错，只是草稿箱空着）。
   ⚠️ `"period": "manual"` 不是装饰：它让草稿标题带「补报」后缀
   （`哈萨克斯坦 - 2026-09-20 补报 投资资讯`），从而与当天自动跑的那一轮（「日报」）区分开。
   **不传 period 的旧写法会和上一次人工补跑完全同名**，草稿箱里就是两份同名草稿。
   ⚠️ 别写 `"period": "morning"` / `"evening"` —— 那两段已在 2026-10-10 取消，
   传了会**静默退回浮动窗口**（详见 6.4 的说明）。

### Q: 手动调推送/流水线返回 `504 Gateway Time-out`，是失败了吗？
A: **不一定是。** 微信云托管的网关（nginx）在 **65 秒**时切断连接，而推送一轮要在
5 个国家上「下载外链图 → 转码 → 传微信素材库 → 建草稿」，流水线更重（还串了抓取和日报），
**必然超过 65 秒** → 客户端拿到 504。

关键区别：

| | 表现 |
|---|---|
| 网关 65 秒切断 | 调用方 504；**服务端请求继续跑完** |
| 任务真的失败 | `lastRun.error` 有值，或 `summary.failures` 里列了国家和原因 |

所以 504 之后**先去查 `lastRun`**，别急着重推 —— 重推会建出重复草稿：

```bash
curl -s https://central-asia-news-307705-12-1480606601.sh.run.tcloudbase.com/api/wechat/push \
  | python3 -c 'import sys,json; s=json.load(sys.stdin)["lastRun"]; print(s["running"], s["finishedAt"], (s.get("summary") or {}).get("failures"), s.get("error"))'
```

`running=true` 说明还在跑，等着；`running=false` 且 `finishedAt` 已更新就是跑完了。

**定时推送不受此影响**：应用内调度器走 `http://localhost:PORT`（见 `lib/runtime.ts` 的
`resolveSelfBaseUrl`），不经过网关，没有 65 秒这回事。这个限制只影响「人工 curl 公网域名」。

### Q: 抓取到底跑完没有？推送为什么像是用的旧数据？
A: `POST /api/fetch-news` 是「**立即返回、后台跑完**」的：HTTP 200 只代表任务已启动，
真正的采集 + 翻译还在后台继续。一轮实测 **75–185 分钟**；2026-10-10 合并成日报后
单轮候选翻倍、硬上限放到 400 分钟（见 `scheduler.ts` 的等待预算）。
⚠️ 这一节早先写的是「实测一轮约 **4–5 分钟**（本机 255 秒）」—— 那是**只干跑采集、还没有翻译**
那个年代的数字。现在拿它判断进度会得出「早该跑完了」的错误结论，**以 `lastRun` 为准**。
所以「拿到 200 就立刻推送」，推的必然是上一轮的旧数据 —— 2026-09-18 之前就是这个毛病，
表现为把上一次推过的新闻再推一遍。

现在调度器改成「触发 → 轮询到这一轮跑完 → 才推送」：
到软上限（240 分钟）只打 ⚠️ 并**继续等**，到**硬上限（400 分钟）则整轮不推送** ——
不是「硬推」。这一点 2026-09-27 改过，别按旧描述理解。

查进度直接 GET（响应里的 `lastRun` 就是状态）：

```
curl https://central-asia-news-307705-12-1480606601.sh.run.tcloudbase.com/api/fetch-news
```

| 字段 | 含义 |
|------|------|
| `running` | 是否还在跑 |
| `startedAt` / `finishedAt` / `durationMs` | 开始 / 结束 / 本轮耗时 |
| `targetDate` | 本轮抓的是哪一天（北京时间） |
| `summary.saved` | **实际入库篇数 —— 排查时先看这个数** |
| `summary.totalFetched` | 各源取到的原始条数合计 |
| `summary.sourceCounts` / `summary.sourceErrors` | 每个源取到多少 / 报了什么错 |
| `error` | 整轮失败的原因（成功时为 null） |

同一时间只允许跑一轮：重复 POST 会返回「上一轮抓取仍在进行，本次跳过」，不会并发抓。

**推送接口 `/api/wechat/push` 和流水线 `/api/pipeline` 已经改成同一套模式**（2026-09-18），
`GET` 也都返回 `lastRun`，字段口径一致：

| 字段 | 含义 |
|------|------|
| `running` / `startedAt` / `finishedAt` / `durationMs` | 同抓取 |
| `lastRun.summary.drafts[]` | **本轮建成功的草稿**（含 `country_name` / `media_id` / `article_count`） |
| `lastRun.summary.failures[]` | **没建成的国家和原因** —— 排查「今天怎么没推」先看这个 |
| `lastRun.error` | 整轮失败的原因（单国失败不会写这里，会进 `failures`） |
| `lastRun.steps[]` | 仅流水线有：逐步日志（采集 / 日报 / 推送），一眼看出卡在哪一步 |

### Q: 抓取日志显示「实际入库 0 篇」，但候选数量正常？
A: 翻译链路断了，文章在入库前被丢弃。检查：
1. 环境变量里有没有 `ZHIPU_API_KEY`（旧的 `COZE_API_TOKEN` 已废弃，换成它了）
2. 智谱控制台里的余额/配额，429 就是欠费或超出免费档限制
3. 把 `ZHIPU_MODEL` 设成 `glm-4.7-flash`（免费档）

### Q: 推了代码但线上没变化？（按这三步查，别猜）

**先接受一个反直觉的事实：「没变化」有三种完全不同的成因，症状一模一样。**

| 成因 | 部署记录里的样子 |
|---|---|
| A. Git 触发链路断了（授权失效 / 自动部署关了 / 分支绑错） | **根本没有新记录** |
| B. 触发了，但构建失败 | 有一条**失败**状态的记录；旧版本继续接流量 |
| C. 构建成功，但生效版本没切过去 | 有成功记录，但「当前版本」还是老的 |
| D. 构建成功、镜像也推送成功，但**部署阶段失败**（pod 没就绪） | 有一条**失败**的记录，日志停在「等待pod启动就绪」 |

所以第一步永远是：**控制台 → 部署（页签）→ 部署记录**，
看最近一次构建的时间戳和状态。看到什么，再跳到对应那一步。

#### 第 0 步：先钉死「线上到底跑的是哪个版本」

别拿主观感觉或 CDN 缓存当证据。用**版本指纹** —— 挑一个「新代码独有的、
能在无副作用 GET 里看到」的字段：

```bash
# ★ 0. 首选用「行为开关指纹」：GET /api/wechat/push 的 codeVersion（2026-09-29 新增）
curl -s "$URL/api/wechat/push?cb=$(date +%s)" | python3 -c "import json,sys;print(json.load(sys.stdin).get('codeVersion'))"
# 期望（示例）：
#   {'dedupeLlmDefault': True, 'editorReviewDefault': True,
#    'editorPromptVersion': 'v1', 'editorGuards': {'maxDrops': 4, 'maxFixes': 6}}
# 这几个值都**从代码现算**，谁改了默认值/提示词/上限它自动跟着变 ⇒ 不会腐烂。
# ⚠️ 它当然也只能反映**已被部署的那一版**；`None` 说明线上那一版还没有这个字段。
```

```bash
# 本项目实测可用的其他指纹
curl -s "$URL/api/fetch-news?cb=$(date +%s)"     # 新代码含 lastRun；sources 里不应再有 tm
curl -s -X POST "$URL/api/wechat/push" -H 'Content-Type: application/json' -d '{"hours":0}'
                                                 # 新代码含 failures 字段
```

```bash
# 同时确认请求真打到了应用、而不是网关缓存
curl -s -D - -o /dev/null "$URL/api/fetch-news?cb=$(date +%s)" \
  | grep -iE 'cache-control|x-cloudbase-upstream-type'
# 期望：cache-control: no-store ...  且  x-cloudbase-upstream-type: Tencent-CloudBaseRun
```

**另一条「进程年龄」指纹（2026-09-29 实测，比字段存在性更可靠）：**

`GET /api/wechat/push` 与 `GET /api/fetch-news` 返回的 `lastRun` 是**纯内存态**
（见 `push/route.ts` 的 `pushRunState`），**容器一重启就归零**。所以：

```bash
curl -s "$URL/api/wechat/push?cb=$(date +%s)" | python3 -c "import json,sys;print(json.load(sys.stdin)['lastRun'])"
# startedAt 为 null / 空 ⇒ 进程是刚起的（说明确实换过版本）
# 一个几小时/几天前的 startedAt ⇒ 进程从那时起就没被替换过
```

⚠️ 这条的边界：`lastRun` 只能证明「进程没换」，**不能证明「代码是哪一版」**。
两者要一起看 —— 2026-09-29 的两次观测就是标准用法：
判断「没上线」时是「`lastRun` 停在 09-28 23:55（进程没换）**且** `summary` 里没有
`merges`/`judge`」；20 分钟后判断「已上线」时是「两个接口的 `lastRun` **同时**变成空」。
**两条证据同时翻转才算钉死。**

两个都满足，才能说「线上是旧版」。**只凭"感觉没变"就下结论，
会把构建失败误判成流水线坏了。**

#### A. 部署记录里没有新记录 → 触发链路断了

按这个顺序查，第 1 条最常见 **而且完全不报错**：

1. **GitHub 授权是否还有效。** 服务设置 → 部署配置（有的版本叫「Git 仓库」），
   看仓库连接状态是不是「已失效 / 需重新授权」。失效就重新授权一次。
   > 关联线索：如果近期在 GitHub 上清理过 PAT / OAuth 授权（比如迁 Deploy Key 时），
   > 微信云托管当年建立的那条授权**可能被一起吊销**。
2. **GitHub 侧那条 webhook 还在不在。** 仓库 → Settings → **Webhooks**，
   看有没有指向腾讯/微信云托管的条目，以及 **Recent Deliveries** 里最近一次投递
   是成功还是失败（这里直接给 HTTP 响应码）。条目消失、或持续 4xx/5xx = 就是它。
3. **绑定分支是否还是 `main`。** 推错分支不报错，只是「没有任何变化」。
4. **「自动部署」开关**是否被关了。关掉后必须手动点「部署」才会构建。

#### B. 有失败的构建记录 → 先在本地复现

点进那次构建的日志看失败步骤。同时本地跑三件套（能排掉大部分原因，省一轮往返）：

```bash
# ① lockfile 与 package.json 是否一致（--frozen-lockfile 不一致会硬失败）
#    pnpm v9 的 importers 段里 scoped 包名带引号，别用简单字符串包含判断
# ② 类型检查（云端 build 会跑 TS）
./node_modules/.bin/tsc --noEmit -p tsconfig.json
# ③ 真实构建，最接近云端行为
HOME=/tmp/wb-build NEXT_TELEMETRY_DISABLED=1 ./node_modules/.bin/next build
```

三项全绿 ⇒ 原因在构建环境差异（基础镜像、pnpm 版本、网络），不在代码里。

#### C. 构建成功但版本没切

看「当前生效版本」是不是最新那个；再看新版本的健康检查有没有过。
**探针失败会导致「不回滚、也不切流量」** —— 表现就是「构建成功、线上照旧」，
比直接失败更难察觉。回上面「探针端口」一问检查端口三处是否一致。

#### C″. ★ 推送成功了，但**根本没触发构建**（2026-10-05 实测）

**这是 A 类的一个瞬时变体，而且它和 A 类的处置不同。** 症状：

- `git ls-remote origin refs/heads/main` **确实是新 sha** ⇒ GitHub 侧没问题；
- 但线上 `codeVersion` 的哨兵**十几分钟不动**，而**同一套链路前一批只用了 4 分 30 秒**；
- 控制台部署记录里**没有任何新条目**（这一点只能在控制台看，所以务必去看一眼）。

**判断依据（不要只看时间，要看比值）**：
拿**同一会话里刚成功的那一批**当基线 —— 它 4 分 30 秒上线，这一批 12 分半、30 次轮询都没动，
**比值 3 倍以上**就足以判「这次没触发」，不用再等。

**处置（按这个顺序，别跳步）**：

1. **先复核远端 sha**（`git ls-remote`）—— 排除「push 没上去」。
   ⚠️ 本机 `git push` 有**无声失败**的历史（无输出、exit 0、远端 ref 不动），
   所以这一步不是走过场。
2. **原样重新触发一次**：`git commit --allow-empty` + `git push`。
   内容一个字都不改 ⇒ 与 C′ 第 1 步「原样重新部署」等价，但**不需要进控制台**。
   实测：13:51:30 推空提交 → **13:55:53 上线**（又是约 4 分半），问题消失。
3. 重触发**仍然不动** ⇒ 这次不是瞬时的，回上面的 **A 类**（授权失效 / 自动部署被关 /
   分支绑错）逐条查，或者走 D 节（本地上传）。

⚠️ **为什么值得单独记一条**：它的**沉默程度比 C′ 更高**。C′ 至少会在部署记录里留一条
失败记录；这一条**连记录都没有**，唯一能看见的就是「哨兵不动」。
而「哨兵不动」同时又正好是「代码写错了 / 字段没加」的症状 ——
两者的排查方向**完全相反**。所以：**哨兵不动时，先比一批成功基线的耗时，再去翻代码。**


#### C′. 构建成功、镜像也推成功，但部署失败在「等待 pod 启动就绪」（2026-09-28/29 实测）

**日志长这样**（三段，顺序固定）：

```
[16:56:14] Image pushed successfully.
-----------构建central-asia-news-120-----------
[16:47:11] create_build_image : creating
[16:56:18] check_build_image : succ
-----------服务central-asia-news部署central-asia-news-120-----------
[16:56:19] create_eks_virtual_service : creating
[16:56:19] check_eks_virtual_service : process, 等待pod启动就绪...   ← 停在这里，然后「部署失败」
```

> 📌 **别把 `central-asia-news-<n>` 当成「服务编号」。它是每次部署尝试的序号。**
> 证据就在上面这段**失败**日志里：编号 `-120` 出现在一次**没人操作、也没成功**的部署上，
> 而且段名是 `-----------构建central-asia-news-120-----------`。
> 所以「这次是 `-122`、上次是 `-120`」**不代表有人新建过服务或改过配置**——
> 它每次部署都会涨。（2026-09-29 实测：失败 `-120` → 成功 `-122`，
> 而用户确认**全程没碰过控制台**。曾据此误判「平台侧被人动过」，已推倒。）

**先排除代码，只要 3 分钟。** 依据是「服务入口的打包产物**完全没变**」：

```bash
# ① 本地复现云端的 tsup 步骤，与构建日志里的那三行逐字对比
npx tsup src/server.ts --format cjs --platform node --target node20 --outDir dist --no-splitting --no-minify
#   云端日志写的是「CJS dist/server.js 12.98 KB」；本地应当也是 12.98 KB
grep -oE 'require\("[^"]+"\)' dist/server.js | sort -u
#   期望（与 Dockerfile 第 22 行的注释一致）：http / next / node-cron / url —— 就这四个

# ② 非 Next 的启动链路能被加载吗（node-cron + 时刻表 + 端口口径）
HOME=/tmp/wb-start npx tsx -e "import('./src/lib/scheduler.ts').then(m=>{
  const S=m.default??m; console.log(S.waitBudgetCrossCheck());
  return import('./src/lib/publish-schedule.ts');
}).then(p=>console.log(p.scheduleHoursCrossCheck()))"
#   期望：两组自检 ok 全为 true。任何一条 false 都是真问题（不是环境问题）。

# ③ 老两样
npx tsc --noEmit        # exit 0（**放后台跑**，冷缓存 3 分钟）
```

> ⚠️ ①的结论最容易被人忽略：**`dist/server.js` 是 `tsup` 只从 `src/server.ts` 打包出来的，
> 而它不包含任何 `src/app/api/**` 路由代码**（路由由 Next 在请求时按需加载）。
> 所以「路由里改了什么」根本影响不到容器能不能启动 —— 只要 `dist/server.js` 的
> 大小与外部 require 没变，代码就不是 pod 起不来的原因。别再往这条路查。

三项都对 ⇒ **原因在平台侧**。

> ⚠️ **先记住 2026-09-29 的结论：这一类失败是瞬时的，不是内容决定的。**
> 当时的情形是**代码一行没改、控制台一下没碰**，原样重跑一次就 `succ` 了。
> 所以 —— **不要回头翻代码！** 第一件该做的事就是**原样重新部署一次**，
> 十分钟内还失败，再往下查下面的清单。顺序不能反，反了就是白花一小时。

按这个顺序查（全部在控制台，不用改代码）：

1. **原样「重新部署」一次** —— 这是 2026-09-29 真正解决问题的那一步。
   同样代码/镜像第二次就过 ⇒ 判为瞬时故障。仍失败再往下走。
2. **端口三处是否一致**（这一条历史上真的踩过，见 `container.config.json` 头部注释）：
   控制台「端口」 vs `container.config.json` 的 `container.port` vs Dockerfile 的 `EXPOSE 3000`。
   历史上出现过「文件 3000、控制台 5000 ⇒ 按 5000 起探针 ⇒ **Liveness probe failed 直接部署失败**」。
   `scripts/start.sh` 现在会优先吃平台注入的 `PORT`，所以不一致也未必炸 —— 但这是第 2 个要看的地方。
3. **那条失败记录的原因文案**：健康检查未通过 / 实例启动失败 / 拉取镜像失败 —— 三种对应完全不同的处置。
4. **服务 → 日志（按版本过滤）**：pod 真起来过才有日志。
   **一条日志都没有 ⇒ 卡在调度或拉镜像，跟应用无关**（应用侧的崩溃一定会留下 stdout）。
5. **规格与实例数**：`container.config.json` 里写的（0.5 核 1G、最小 0、阈值 60）与控制台实际
   （2026-10-10 17:17 截图：**1 核 2G、最小 0、最大 5、CPU 阈值 95%**）**对不上，控制台为准**。
   有人动过配置就会在这里露出来。
   📌 顺带钉死一条以前只能推断的事：控制台「容器规格 ⓘ」的原文是
   **「容器规格 CPU 与内存比例为 1:2」** ⇒ 下拉框**不是自由组合**，只有
   0.25核0.5G / 0.5核1G / 1核2G / 2核4G / 4核8G / 8核16G 这些配对可选。
   「1 核 1G」这种档**平台给不出来**，所以「只降内存」这条省钱路**不存在**。
6. **镜像 1.01GB**：构建日志会主动提示优化。冷节点拉一个 1GB 镜像 + 就绪超时，
   是这次**最可能**的成因 —— 也是**唯一能靠我们自己规避**的一条（瘦身镜像），
   其余几条都只能等平台。仍然失败就走下面的 D 节（本地上传）。

> ⚠️ **纪律：部署没恢复之前，不要对线上行为下任何「改动没生效」的结论。**
> 旧版本一直在正常服务，所以所有新字段（`merges` / `judge` / `review`）都不会出现 ——
> 那不是「改动写错了」，而是「改动没上线」。这两件事的排查方向完全相反。

**反过来：部署成功时长什么样（2026-09-29 11:57 实测，拿去对照）**

构建日志末行变成 `check_eks_virtual_service : succ`（失败那次是
`process, 等待pod启动就绪...`），然后**容器日志里出现完整的引导序列**：

```
> projects@0.1.0 start /app
> bash ./scripts/start.sh
Starting HTTP service on port 3000 for deploy...
启动定时任务调度器...
已注册公众号推送任务：0 4 * * * (凌晨 04:00（日报）)，窗口 … （24h，按时刻表固定）
共注册 1 个定时任务
> Server listening at http://<pod 名>:3000 as production
```

三件事要一起确认，缺一条都不能说「新版本生效了」：

1. 末行是 `succ`；
2. 引导序列走完（尤其是 **`Server listening`** 那一行，和**没有** `⚠️ 时刻表不一致`）；
3. `lastRun` 被清零（见第 0 步的「进程年龄」指纹）。

> 📌 另外会遇到一种**看着吓人其实正常**的日志：某个**别的**版本名（例如
> `central-asia-news-119`）单独一行 `ELIFECYCLE  Command failed.`，时间点在切换之后。
> 这是**旧实例被回收**时 `pnpm` 对被杀掉的生命周期脚本的常规报错
> （它只会打这一行，**不会**有 `> projects@0.1.0 start` 之类的引导行）。
> 判断依据：**线上还活着**（curl 还是 200、`lastRun` 是新的空态）⇒ 那就不是新版本启动失败。
> 反过来，如果**当前版本名**的引导序列半路断了再跟一行 `ELIFECYCLE`，那才是真的启动失败。

#### D. 兜底：绕开 Git 流水线

调查要时间，但线上不能一直跑旧代码。确定性路径是**本地上传**：

```bash
tar -czf deploy.tar.gz --exclude=node_modules --exclude=.next --exclude=.git .
# 控制台 → 部署 → 本地上传 deploy.tar.gz
```

打包后**一定校验三件事**，否则传上去才发现白跑：

```bash
tar -tzf deploy.tar.gz | wc -l                                            # 文件数是否合理
tar -tzf deploy.tar.gz | grep -cE '^(\./)?(node_modules|\.next|\.git)/'   # 必须为 0
tar -tzf deploy.tar.gz | grep -E 'Dockerfile|package.json|pnpm-lock\.yaml' # 构建必需文件在不在
```

⚠️ `*.gz` 常被 `.gitignore` 排除，**不能靠提交分发，得本地留着**；
`.dockerignore` 里排除的目录（本项目是 `assets`、`.coze`）打包时一并排掉，保持一致。

### Q: 构建日志报 `Cannot find module 'sharp'` / `TS2307`？

A: 这是 **pnpm 隔离式链接**导致的「传递依赖解析不到」，已在 2026-09-18 踩过一次 ——
当时线上连续 5 个提交一个都没部署上去，全卡在这里。

`sharp` 原本只是 `next` 的 `optionalDependency`。pnpm 只对 `package.json` 里**显式声明**的包
在根 `node_modules` 建软链，传递依赖只私有提升到 `node_modules/.pnpm/node_modules/`。
而 `src/app/api/wechat/push/route.ts` 里有 `await import('sharp')`，
`next build` 的类型检查解析不到 → `TS2307` → **整个构建失败，旧版本继续服务**。

**修法**：把 sharp 写进 `package.json` 的 `dependencies`（本仓库已这么做，别删）：

```json
"dependencies": { "sharp": "^0.34.5" }
```

**为什么本地测不出来**：本机 `node_modules` 被 npm 装过、依赖是拍平的，
`node_modules/sharp` 是个真实目录；而云端是纯 pnpm 装的全新依赖树。
**所以「本地 `pnpm build` 能过」不能证明云端能过。**

**想本地复现**（30 秒，能直接看到同一个报错）：

```bash
# 临时把根目录的 sharp 挪走，模拟 pnpm 的隔离布局
mv node_modules/sharp /tmp/sharp-backup
./node_modules/.bin/tsc --noEmit -p tsconfig.json   # 应报 TS2307（= 云端那个错）

# 复原成 pnpm 会建的那种软链，再验一次应该就过了
ln -s .pnpm/sharp@0.34.5/node_modules/sharp node_modules/sharp
./node_modules/.bin/tsc --noEmit -p tsconfig.json   # 无输出 = 通过
```

> 判断依据：根 `node_modules` 里的直接依赖**都是软链**，可以抽查一个
> （`node -e "console.log(require('fs').readlinkSync('node_modules/rss-parser'))"` → 指向 `.pnpm/...`）。
> 如果某个包在根目录是**真实目录**，那它多半是 npm 装的残留，会掩盖云端问题。

`scripts/build.sh` 现在会在装完依赖后自动跑一次 `require.resolve` 预检，
解析不到就打 `[FATAL]` 说明原因，不用再对着 TS2307 猜。

### Q: 网页访问慢？
A: 在云托管控制台调整：
1. 增加实例数量（`minNum`）
2. 选择更高配置（CPU/内存）

## 费用说明

微信云托管**只有按量付费，没有月付套餐**（原版这里写的「预估月费 ¥50-100」是 2026-10-08 之前的
旧口径，当时实例常驻，已作废）。列表价：

| 项 | 单价 |
|---|---|
| CPU | **0.055 元/核·小时** |
| 内存 | **0.032 元/GB·小时** |
| 构建 | 0.05 元/分钟 |
| 公网流量 | 0.8 元/GB |

免费额度：**720 核·小时 + 1440 GB·小时** —— ✅ **已核实（2026-10-10 17:34）：一次性。**

> 官方口径：这 720 核·小时是**首次赠送的一次性额度**，**有效期自环境创建之日起 3 个月**；
> 用完即按量付费；**到期未用完自动失效、不结转到下个周期**；**也不是每 3 个月重新给**。
> 而且只针对**首个环境**，重建环境可能不再享有。
>
> ⇒ **它已经在 2026-10-08 用尽，并且不会再来。** 从那之后就是**全额按量付费**。

📐 现方案（**1核2G，每天 7.5 小时 = 03:45–11:15**，见 `container.config.json` 的 💰 段）：
- **≈ ¥26.8/月**（CPU ¥12.38 + 内存 ¥14.40）—— **不是 ¥0**。
  ⚠️ 文档里此前所有「落在免费额度内 ⇒ ¥0」的表述**已作废**（它们都依赖「额度会循环赠送」
  这个当时未核实的前提）。
- 对照：**常驻** 1核2G = **¥85.7/月**。「常驻」正是当初把额度烧穿的原因
  （1 核 × 24 h × 30 天 = 720，正好用干，一天不剩）。

⚠️ **「降到 2G 以下能省钱吗」**：容器规格强制 **CPU:内存 = 1:2**，所以只有 0.5核1G 一条路，
**没有「只降内存」这个选项**。额度既然已耗尽，它**确实真省钱**（¥26.8 → ¥13.4/月），
但代价是轮次约翻倍（最坏 370 分钟 → 必撞 400 分钟硬上限 ⇒ **整轮不推送 = 一整天没草稿**，
且静默失败）。
★★ **同一笔钱有更好的走法：加翻译并发。** 因为**窗口长度 = 计费时长**，而窗口必须覆盖最坏
轮次 ⇒ 轮次越短、窗口就能收得越窄。并发把最坏压到 ~3.5 h ⇒ 窗口可收到 4.0 h/天 ⇒
**¥14.3/月**（≈ 降规格的价），**而且出稿时间提前**而不是拖后。
⇒ **顺序：先做并发，再考虑降规格。**

### 翻译要花多少钱、能不能做到全免费

#### 先纠正一个数：之前写的「≈¥115/月」是高估，真实量级小一档

那个数字是按「智谱 100% 挂掉、每篇都走付费」推的，而且单篇成本用的是 2026-09-19 那个
**病态日**的实测值 —— 那天 GLM-4.7 的 thinking 没关掉，输出里夹着大段思维链，
单篇输出 token 是正常值的十几倍，还叠加了超时重试。thinking 当天已修，这个前提不再成立。

**按实测重算**（2026-09-20；样本取 `/api/articles` 的 62 篇，提示词长度实测自 `translate.ts`）：

| 项 | 实测值 |
|---|---|
| 单篇输入 | 约 **1856 字符**（其中 **1426 字符**是固定说明 + 分类枚举，正文只占 400 上下） |
| 单篇输出 | 约 **490 字符**（中文标题 + 100 字摘要 + 300 字综述） |
| 折算 token | 输入约 1.2K、输出约 0.3K |
| DeepSeek 非高峰单篇 | ≈ **$0.0004 ≈ ¥0.003** |
| 日入库量（实测 9/16–9/20） | 20 / 292 / 423 / 139 / 62 篇，**典型 100–300** |

**结论：**

- **最坏情况**（智谱整月不可用、全部走付费）：约 **¥0.3–1.3/天 → ¥10–40/月**；
- **现实情况**（智谱多数时候能用，只为它挂掉的那部分付费）：**个位数到十几元/月**；
- 要核真实花费，看 DeepSeek 控制台的账单页（`platform.deepseek.com` → 用量信息），比任何估算都准。

#### 免费档的边界在哪

**账号/控制台侧没有可做的了**，几个必要条件本来就齐：
Key 已配、`glm-4.7-flash` 是**单价 0 元的永久免费模型**（不消耗资源包，所以「资源包到没到账」与它无关）、
`thinking` 已正确关闭、串行调用符合免费档的并发限制。
剩下的唯一瓶颈是 **1305「该模型当前访问量过大」**。
注意措辞 —— **是「该模型」不是「该账号」**：这是**按型号**计的拥挤，不是你的速率限制
（账号侧那是 **1302**），所以它配不了、也不该为它升级权益。
想靠[权益等级](https://bigmodel.cn/usercenter/equity-mgmt/user-rights)提并发同样走不通：
积分只能靠**花现金**获得（1 元 = 1 积分），V1 要 2000 积分、V2 要 10000，
且**消耗资源包/赠金不计积分** —— 对本项目用量完全不划算。

#### 付费基准（DeepSeek 官方价，`deepseek-flash`，2026-09-20 核对）

| | 非高峰 | 高峰 |
|---|---|---|
| 输入（未命中缓存）/1M | $0.15 | $0.30 |
| 输出 /1M | $0.60 | $1.20 |

高峰是 **01:00–04:00 与 06:00–10:00 UTC 的工作日**，即北京 09:00–12:00、14:00–18:00。

⚠️⚠️ **先分清这是谁的价**：下表是 **DeepSeek API 的分时段价**，
**不是云托管的分时段价** —— 云托管按量计费**不分时段**，所以「挪起跑时刻」对**实例成本**是零影响
（见 `publish-schedule.ts` 头部「起跑时刻挪动既不加钱也不省钱」）。
但**挪起跑时刻确实会影响这一项**，因为一轮会横跨时段。

现口径（**2026-10-10 起：04:00 起跑，一轮 144–400 分钟** ⇒ 收工 06:24–10:40）：

| 情形 | 起跑 | 收工 | 落在高峰的时长 |
|---|---|---|---|
| 典型 144 分钟 | 04:00 | 06:24 | **0 分钟**（整轮在非高峰）✅ |
| 最坏 400 分钟 | 04:00 | 10:40 | **100 分钟**（09:00–10:40 按 2 倍价）|

历史口径（2026-10-10 之前的两轮，供对照）：07:00 起跑典型到 09:24 ⇒ 24 分钟高峰、
最坏到 13:50 ⇒ 180 分钟高峰；19:00 起跑**整轮在非高峰**（0 分钟）。

⇒ **提前起跑能减少高峰段占比**（这跟「云托管侧不加钱」是两件事，别混起来）：
把起跑从 04:00 再提前到 **03:00**，最坏情况的暴露从 100 分钟降到 **40 分钟**（03:00+400min = 09:40）；
提前到 **02:00** 则最坏也是 **0 分钟**（02:00+400min = 08:40 < 09:00）。
⚠️ 但**量级很小**：付费通道只在两个免费通道都失败时才用（历史上有过单次 ¥3.42 的记录），
**真要省钱得先治 429**（见 AGENTS.md 缺陷 21）。

⚠️⚠️ **反过来也成立，而且这点更值得记**：**把容器规格调小若能拖慢一轮，高峰段反而变长** ——
降规格省下的实例钱，会被这里吃掉一部分。所以「降规格」和「提前起跑」应当**同时评估**，不是各算各的。

#### 进一步省钱的手段（按性价比排）

| 方案 | 做法 | 效果 | 状态 |
|---|---|---|---|
| **A. 加第二个智谱免费型号**（性价比最高） | 因为 1305 是**按型号**计的，`glm-4.7-flash` 被挤爆时，同为免费档的 `glm-4-flash-250414` 很可能还通。已加进 `PROVIDERS` 并排在付费通道**之前** | 多一次**不花钱**的机会：命中就省钱且内容不丢；没命中只多花几百毫秒，然后照旧降级 —— **行为超集，不会比原来更差** | ✅ 已上线 |
| **B. 加第二个免费厂商** | 魔搭 ModelScope（2000 次/天免费，Qwen 系列，国内直连、OpenAI 兼容）或硅基流动（注册送额度 + 部分模型永久免费） | 本项目每天 100–300 篇，额度完全够 —— 这是能真正做到「全免费」的一条 | 待注册拿 Key，接进 `PROVIDERS` 即可 |
| **C. 失败的留到下一轮再免费重试** | 现在逻辑是「这篇此刻翻不了 → 立刻花钱翻」；改成「先挂起，本轮结束后隔一段时间用免费通道重试，实在不行再付费」 | 免费命中率最大化 | 需要「待翻译队列」（DB 加状态），改动面最大 |
| **D. 给付费通道设硬上限** | 每天最多 N 篇走付费，超了就留到下一轮 | 月费**封顶且可预测**（比如封在 ¥10/月） | 可选，改动小 |
| **E. 摊薄固定开销** | 单篇输入里 **77% 是每篇都重发一遍的固定说明 + 分类枚举**。一次请求翻 5 篇，固定开销就摊薄 5 倍 | 付费时能省一半左右 | 需改提示词与 JSON 解析，中等改动 |

**⚠️ 不建议**：把 `DEEPSEEK_API_KEY` 删掉换取「0 花费」。
代码是**中文优先**策略 —— 翻译失败的文章**直接不入库**（`translate.ts` 里
「所有翻译通道均失败，本篇将不入库」），智谱忙时当天内容可能少一大半，
等于把「草稿箱有内容」这件事又打回去。

## 后续优化

1. **添加监控** - 配置云监控告警
2. **日志分析** - 使用云托管日志服务
3. **自动扩缩容** - 根据流量自动调整实例数
4. **CDN 加速** - 静态资源使用 CDN
