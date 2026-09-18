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
| `TELEGRAM_WORKER_URL` | Cloudflare Worker 代理地址；不配则不抓 Telegram |
| `TELEGRAM_CHANNELS` | 频道配置，格式 `国家:频道[@频道...]`，逗号分隔。留空用内置默认值 |
| `ZHIPU_MODEL` | 覆盖翻译型号，留空即用默认值 `glm-4.7-flash` |
| `DEEPSEEK_MODEL` | 覆盖降级型号，留空即用代码默认值 |

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
# 打包代码
tar -czf deploy.tar.gz --exclude=node_modules --exclude=.next --exclude=.git .

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
> 每次是**先抓取、等抓完再推送**（抓取本身要 4–5 分钟，所以实际出草稿时间在
> 08:05 / 19:05 左右）。顺序很关键，原因见文末「抓取到底跑完没有」一条。
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
> **真正的结果在日志里**。不知道这点会以为它没跑。

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

> 这个接口不带 `period`，按老口径汇总**过去 24 小时**，生成的草稿标题没有「早报/晚报」后缀。
> 它适合用来人工补跑；日常的两次定时推送由应用内调度器按 13h / 11h 的增量窗口跑。

日志里应有：

```
公众号推送完成：成功创建 N 个草稿（共 M 篇）
```

然后去公众号后台的草稿箱确认。

**推送失败是本地必然、云上才通**：代码走的是微信云调用（免 IP 白名单、免 access_token），
依赖云托管侧拦截 `api.weixin.qq.com`。所以「本地推不出去」不代表代码有问题。

#### 6.5 等一次真实定时

上面都通了，再等下一个 08:00 / 19:00 看是否自动触发。日志关键词：

```
触发公众号推送任务 (早上 08:00（早报）)
开始执行微信公众号推送任务（时段 morning，回看过去 13 小时）...
微信公众号推送：2026-09-18 早报，汇总 ...T19:00:00.000Z 至 ...T00:00:00.000Z（过去 13 小时）
```

推送完成后到公众号草稿箱确认：同一天应该只有 **5 个草稿**（5 个国家各 1 个），
标题形如 `哈萨克斯坦 - 2026-09-18 早报 投资资讯`，晚报是 `... 晚报 ...`。

## 常见问题

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
3. 嫌预热不可靠，把 `container.config.json` 的 `minNum` 改成 `1` 让实例常驻。
4. 某一时段失败导致那一段新闻没推：手动补一次
   `curl -X POST https://central-asia-news-307705-12-1480606601.sh.run.tcloudbase.com/api/wechat/push -H 'Content-Type: application/json' -d '{"hours": 24}'`

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

## 后续优化

1. **添加监控** - 配置云监控告警
2. **日志分析** - 使用云托管日志服务
3. **自动扩缩容** - 根据流量自动调整实例数
4. **CDN 加速** - 静态资源使用 CDN
