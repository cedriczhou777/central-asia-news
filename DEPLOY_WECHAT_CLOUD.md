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
| `ZHIPU_MODEL` | 覆盖翻译型号，留空即用默认值 `glm-4.7-flash` |
| `DEEPSEEK_MODEL` | 覆盖降级型号，留空即用代码默认值 |

#### 翻译走了哪个通道、花了谁的钱？（一轮抓取后必看）

`GET /api/fetch-news` 的 `lastRun.summary.translation` 里有：

| 字段 | 含义 |
|------|------|
| `providerCounts` | 每个通道成功翻了几篇，如 `{"zhipu": 40, "deepseek": 126}` —— **deepseek 的数字就是花钱的篇数** |
| `errors` | 每个失败通道的第一个报错（如 `zhipu: HTTP 401: invalid key`），智谱免费档为什么没生效看这里 |

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

即 **约 16 秒/篇**。两个变量任一个变大都会顶穿等待上限：篇数（400 篇 ≈ 105 分钟）、
单篇耗时（智谱免费档拥挤时段单次要 17–25 秒，见 `/api/translate-check`）。

所以 `src/lib/scheduler.ts` 的 `FETCH_WAIT_TIMEOUT_MS` 已提到 **150 分钟**
（流水线 `STEP_TIMEOUT_MS` 同口径）。这个值**必须显著高于实测耗时**：
等待超时后调度器会「硬推」，而此时抓取可能刚跑到一半 → 推送出一份缺国家的草稿。

> 取舍是刻意的：**宁可草稿晚一点（08:00 触发 → 最晚 10:30 出），也不要在库半空时推。**
> 真要压缩周期，唯一有效的手段是**让翻译并发**（现在是严格串行）——
> 但智谱免费档只允许 1 个并发，提并发会把它逼到 429 并降级到付费 DeepSeek，
> **这是钱换时间的选择，改之前先和用户确认**。

##### ⚠️ 等待逻辑踩过的坑：状态要取 `body.lastRun`，不是整个响应体（2026-09-20 已修）

`GET /api/fetch-news` / `GET /api/wechat/push` 返回的是一个**信封**：
`{ message, usage, dryRunHint, sources, lastRun }`。
调度器（`lib/scheduler.ts`）和流水线（`api/pipeline/route.ts`）原先都把整个响应体当状态用，
于是 `state.running` / `state.finishedAt` **恒为 undefined**，完成判据永远为假 ——
不报错，只是**每一轮都干等到超时上限**。

实测症状（19:00 那轮）：抓取 19:00 启动、20:13 就跑完了，但到 20:19 推送那一步还没开始，
**草稿箱自然是空的**；日志里只有「已触发」，后面什么都没有（旧代码等待期间一行都不打）。

排查口诀：日志里出现 `running=undefined` 就是这个问题。修完的判据是
`body.lastRun`，并带 `?cb=` 破坏缓存；等待期间每 2 分钟打一行
`仍在等待XX（已等 N 分钟）: running=... finishedAt=...` 作为哨兵。

修好之后，典型一轮是「抓取 73–90 分钟 + 推送 ~10 分钟」，
即 **08:00 那轮的草稿约 09:25 出现、19:00 那轮约 20:25**（修之前是 09:40 / 20:40）。
（等待上限同时放到 150 分钟 —— 宁可晚，也不要在库半空时推一份缺国家的草稿。）

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

### 4. 配置定时触发器

> **重要变更**：这里**只配预热触发器，不配业务触发器**。
>
> 真正的抓取+推送由**应用内调度器**负责（`src/lib/scheduler.ts`）。每天两次，
> 两段回看窗口**首尾相接、互不重叠**：
>
> | 时段 | 触发（北京时间） | 回看窗口 |
> |------|----------------|---------|
> | 早报 | 08:00 | 13 小时（昨日 19:00 → 今日 08:00） |
> | 晚报 | 19:00 | 11 小时（今日 08:00 → 今日 19:00） |
>
> 每次是**先抓取、等抓完再推送**。抓取一轮实测约 **75 分钟**（不是几分钟），
> 再加推送 ~10 分钟，所以**草稿实际出现时间在 09:25 / 20:25 左右**，
> 而不是 08:00 整。这段延迟是设计内的，别当成故障。
>
> 云托管在 `container.minNum: 0` 时会把实例缩容到零，进程一停应用内定时器也就没了，
> 所以需要提前 5 分钟把实例唤醒。
>
> 旧版这里挂着 4 条 `{"action":"fetch-and-push"}` 的触发器，但**代码里没有任何地方处理这个
> payload**——看着在定时抓取，实际什么都没干，已清理。**看到旧名字就是没删干净。**

在云托管控制台 → **触发器** → **创建触发器**：

| 触发器名称 | Cron 表达式 | 说明 |
|-----------|------------|------|
| `warmup-morning` | `55 23 * * *` | 北京时间 07:55（UTC 前一日 23:55），预热 |
| `warmup-evening` | `55 10 * * *` | 北京时间 18:55（UTC 10:55），预热 |

payload 留空 `{}` 即可，不需要传任何业务参数。

**注意**：Cron 表达式使用 UTC 时间，北京时间 = UTC + 8。
如果预热不稳定，可以把 `container.config.json` 的 `container.minNum` 改成 `1`（实例常驻，
代价是按量计费），这样就不再依赖预热。

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
已注册公众号推送任务：0 8 * * * (早上 08:00（早报）)，回看 13 小时
已注册公众号推送任务：0 19 * * * (晚上 19:00（晚报）)，回看 11 小时
共注册 2 个定时任务
```

- 看到「共注册 **2** 个定时任务」= 版本对了。**如果是 4 个，说明部署的还是旧代码。**
- 看到「回看 13 小时 / 11 小时」= 代码里「两次推送窗口不重叠」的修复已生效。
  **如果两行都是「回看 24 小时」，说明跑的是修复前的旧版本。**
- 完全看不到这几行 = 实例被缩容到零了，发一次请求把它唤醒再看。

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
  -d '{"hours": 11, "period": "evening"}'

# 结果同样靠 GET 拿
curl -s https://central-asia-news-307705-12-1480606601.sh.run.tcloudbase.com/api/wechat/push \
  | python3 -c 'import sys,json; s=json.load(sys.stdin)["lastRun"]; print("running=",s["running"],"dur=",s["durationMs"],"ms"); print("drafts=",[d["country_name"] for d in (s.get("summary") or {}).get("drafts",[])]); print("failures=",(s.get("summary") or {}).get("failures")); print("error=",s.get("error"))'
```

> 推送不带 `period` 时按老口径汇总**过去 24 小时**，草稿标题没有「早报/晚报」后缀，
> 适合人工补跑；日常两次定时推送由应用内调度器按 13h / 11h 的增量窗口跑。
> 一轮推送要做「逐篇下载外链图 → 转码 → 传微信素材库 → 建草稿」，实测远超 65 秒，
> 所以**手动调也一定会遇到 504**，照上面轮询 `lastRun` 即可。

然后去公众号后台的草稿箱确认。

**推送失败是本地必然、云上才通**：代码走的是微信云调用（免 IP 白名单、免 access_token），
依赖云托管侧拦截 `api.weixin.qq.com`。所以「本地推不出去」不代表代码有问题。

#### 6.5 等一次真实定时

上面都通了，再等下一个 08:00 / 19:00 看是否自动触发。日志关键词：

```
触发公众号推送任务 (早上 08:00（早报）)
开始抓取当天新闻...
新闻抓取已触发: {"success":true,...}
新闻抓取完成: {"saved":40,"sourceCounts":{...}}
开始执行微信公众号推送任务（时段 morning，回看过去 13 小时）...
微信公众号推送：2026-09-18 早报，汇总 ...T19:00:00.000Z 至 ...T00:00:00.000Z（过去 13 小时）
微信公众号推送完成: {"drafts":[...],"failures":[]}
```

> 注意是「**已触发**」和「**完成**」两行 —— 调度器触发了异步接口后会轮询到这一轮真正结束
> 才往下走，所以日志里能看到 `drafts` / `failures` 的真实内容。
> 只有「已触发」没有「完成」，说明等超时了（抓取 25 分钟 / 推送 20 分钟上限），
> 日志里会有 `等待...超过 N 分钟仍未结束，不再等待` 的 warn。

推送完成后到公众号草稿箱确认：同一天应该只有 **5 个草稿**（5 个国家各 1 个），
标题形如 `哈萨克斯坦 - 2026-09-18 早报 投资资讯`，晚报是 `... 晚报 ...`。

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

另外注意**时序**：调度器是「先抓取（实测 40 分钟）→ 再推送」。如果等抓取超时
（60 分钟上限），推送会用当时的库硬推 —— 库还没填满时就表现为「该国没推」。

### Q: 草稿箱里同一个国家出现两份标题相同的草稿？
A: 这是修复前的旧行为，两个成因已一并修掉：
1. 两次推送都用「过去 24 小时」窗口，中间 13 小时重叠 → 改成 13h + 11h 首尾相接；
2. 标题里的日期取的是 **UTC 日期**，北京 08:00 与 19:00 落在同一个 UTC 日 →
   改成按 `Asia/Shanghai` 出日期，并加上「早报 / 晚报」后缀。

看到「回看 24 小时」的注册日志 = 线上还是旧版本。

### Q: 云调用失败怎么办？
A: 检查控制台（**都不是环境变量**）：
1. 微信开放接口服务（云调用）是否已开通、公众号是否已授权给这个环境
2. 接口路径白名单是否加了 `/cgi-bin/draft/add` 和 `/cgi-bin/material/add_material`
3. 错误码对照：`40001/40014` = 未授权或走了普通 HTTP 调用（不是云调用）

> 注意：`USE_WECHAT_CLOUD_CALL=true` 这种写法**在代码里没有任何作用**，
> 云调用的开关只在控制台，不在环境变量。

### Q: 定时任务不执行？
A: 按顺序检查：
1. 日志里有没有 `共注册 2 个定时任务`。没有 = 实例被缩容到零，应用内定时器随进程一起没了。
   看预热触发器（`55 23 * * *` / `55 10 * * *`）是否已启用、时区是否按 UTC 填。
2. 有这行但到点没动 = 看有没有 `触发公众号推送任务` 这行，再看后续报错。
3. **触发了、抓取也跑了，但推送迟迟不开始** → 看日志里有没有 `running=undefined`：
   那就是「状态读成了响应信封、完成判据永远为假、每轮干等到超时」那个坑
   （见上面「等待逻辑踩过的坑」一节）。正常应看到 `仍在等待XX（已等 N 分钟）: running=true`，
   抓取跑完后紧跟一行 `新闻抓取完成（等了 75 分钟）`，然后才开始推送。
4. 嫌预热不可靠，把 `container.config.json` 的 `minNum` 改成 `1` 让实例常驻。
5. 某一时段失败导致那一段新闻没推：手动补一次
   `curl -X POST https://central-asia-news-307705-12-1480606601.sh.run.tcloudbase.com/api/wechat/push -H 'Content-Type: application/json' -d '{"hours": 24, "period": "manual"}'`
   —— 这个接口是异步的，curl 很可能报 504，**别当成失败**，结果用 `GET` 读 `lastRun`（见 6.4）。
   ⚠️ `"period": "manual"` 不是装饰：它让草稿标题带「补报」后缀
   （`哈萨克斯坦 - 2026-09-20 补报 投资资讯`），从而与当天自动跑的早报/晚报区分开。
   **不传 period 的旧写法会和上一次人工补跑完全同名**，草稿箱里就是两份同名草稿。

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
真正的采集 + 翻译还在后台继续。实测一轮约 **4–5 分钟**（本机 255 秒，云托管上更慢）。
所以「拿到 200 就立刻推送」，推的必然是上一轮的旧数据 —— 2026-09-18 之前就是这个毛病，
表现为早报把前一晚推过的新闻再推一遍。

现在调度器改成「触发 → 轮询到这一轮跑完 → 才推送」，等待上限 25 分钟，超时会打 warn 后硬推。

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

所以第一步永远是：**控制台 → 部署（页签）→ 部署记录**，
看最近一次构建的时间戳和状态。看到什么，再跳到对应那一步。

#### 第 0 步：先钉死「线上到底跑的是哪个版本」

别拿主观感觉或 CDN 缓存当证据。用**版本指纹** —— 挑一个「新代码独有的、
能在无副作用 GET 里看到」的字段：

```bash
# 本项目实测可用的三条指纹
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

微信云托管按量计费：
- **计算资源**：约 ¥0.00013/秒（2核2G）
- **定时任务**：免费
- **流量**：约 ¥0.8/GB

**预估月费**：¥50-100（根据访问量）

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
本项目的两次定时（北京 08:00 / 19:00 = UTC 00:00 / 11:00）**都落在非高峰**，按半价计。

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
