# 本地验证手册

从「拉下代码」到「确认能跑」，按顺序做。分三档，**先跑第 1 档**（不需要任何 API Key，30 秒出结果），
再按需往后走。

> 全部命令都在项目根目录 `central-asia-news/` 下执行。

---

## 0. 一次性准备

```bash
cd central-asia-news

# 1) 确认 node / pnpm
node -v      # 需要 >= 20，本项目在 22 上验证
pnpm -v

# 2) 装依赖
pnpm install
```

### 如果 `pnpm install` 卡住不动

大概率是 corepack 在等你回答一个**交互式确认**：

```
! Corepack is about to download https://registry.npmjs.org/pnpm/-/pnpm-9.0.0.tgz
? Do you want to continue? [Y/n]
```

`package.json` 里锁了 `packageManager: pnpm@9.0.0`；本机 pnpm 版本不一样时 corepack 就要下载它，
并且会先问一句。在脚本或非交互环境里没人回答，就永久停住。

任选一种解决（推荐第一种，一次到位）：

```bash
# ① 一次性把锁定版本装进 corepack 缓存，之后再也不会问
corepack prepare pnpm@9.0.0 --activate

# ② 或者给当前 shell 关掉这个确认
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
```

---

## 第 1 档 · 冒烟验证（不需要任何 Key）

只验证「代码是好的」：类型检查 + 纯函数用例。

```bash
pnpm verify:local
```

它等于依次跑：

| 命令 | 验证什么 |
| --- | --- |
| `pnpm ts-check` | 全量 TypeScript 类型检查，零错误才算过 |
| `pnpm test:channels` | `TELEGRAM_CHANNELS` 解析的 12 条用例 |

期望输出末尾是：

```
通过 12 项，失败 0 项
✓ 全部通过。
```

再单独跑一下 lint：

```bash
pnpm lint:build    # = eslint . --quiet，只报 error，通过时无任何输出
pnpm lint          # = eslint 全量，会多出 7 条 warning
```

> 两条命令的区别只在 `--quiet`：`lint:build` 把 warning 吞掉了，所以**通过时安静得像没跑**，
> 这是正常的（exit code 0）。想看到那 7 条 warning 就用 `pnpm lint`。
>
> 那 7 条都在 `storage/database/*`、`lib/db-articles.ts` 等历史文件里（未使用的导入与变量），
> 是接手前就存在的，**0 error 即为正常**，不用管。

---

## 第 2 档 · 翻译链路（需要一个模型 Key）

翻译是这条流水线里最容易整体断掉的一环，也是接手时**唯一真的断了**的地方，
所以单独有自测脚本。

### 2.1 填 Key

```bash
cp .env.local.example .env.local
```

编辑 `.env.local`，**至少填一个**：

```ini
# 通道 1：智谱 GLM，glm-4.7-flash 当前免费
ZHIPU_API_KEY=你的key

# 通道 2：DeepSeek，按量付费，作为降级（账号余额为 0 时会 402）
DEEPSEEK_API_KEY=你的key
DEEPSEEK_MODEL=deepseek-flash
```

- 智谱 Key：<https://open.bigmodel.cn> → 控制台 → API Keys
- DeepSeek Key：<https://platform.deepseek.com> → API keys（**要先充值**）
- `.env.local` 已在 `.gitignore` 里，不会被提交
- `DEEPSEEK_MODEL` 建议显式写上：代码默认值已经跟着官方调整过（`deepseek-chat` 已下线），
  显式写死可以避免厂商再换代号时踩坑。型号默认值定义在 `src/lib/translate.ts` 的 `PROVIDERS`。

### 2.2 跑

```bash
pnpm test:translate
```

脚本会拿一段真实的英文新闻（乌兹别克斯坦-塞尔维亚 5 亿美元能源协议）走一遍完整的
`translateNews()`：不碰数据库、不碰微信，只验证「模型能不能调通 + 返回的中文能不能解析」。

**成功**长这样：

```
已配置的翻译通道：zhipu（模型 glm-4.7-flash）
开始翻译测试样本...

──────── 结果（耗时 3.2s）────────
translated : true
provider   : zhipu
投资相关   : true
标题       : 乌兹别克斯坦与塞尔维亚签署5亿美元能源合作协议
...
✓ 翻译链路正常。可以放心部署了。
```

**失败**怎么读：

| 现象 | 原因 |
| --- | --- |
| `没有检测到任何翻译通道的 API Key` | `.env.local` 没建，或变量名拼错 |
| 走到下一个 provider 才成功 | 前一个通道的 Key 无效/欠费，日志里会打原因 |
| `所有通道都没能返回合格的中文` | 两个 Key 都不行。往上翻错误日志定位 |

> 退出码 0 = 通过，1 = 失败，可以直接接进任何 CI。

---

## 第 3 档 · 起服务 + 真实抓取（需要 Supabase，推送还需部署环境）

### 3.1 起服务

```bash
pnpm dev
```

看到这些就是好了：

```
Port 3000 is free.
Starting HTTP service on port 3000 for dev...
✓ Ready in 426ms
```

访问 <http://localhost:3000>。

### 3.2 探活（不写库，纯确认路由通）

另开一个终端：

```bash
curl -s http://localhost:3000/api/fetch-news | head -c 200
curl -s http://localhost:3000/api/pipeline
```

两个都该返回 `HTTP 200` 和一段 JSON 说明。

### 3.3 真实抓一次（需要 Supabase 配置）

先在 `.env.local` 补上：

```ini
SUPABASE_URL=...
SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...   # 可选，有则优先用于写入
```

然后：

```bash
# skipTranslation: true —— 先跳过翻译，单验抓取+入库链路（省 Key 额度）
curl -s -X POST http://localhost:3000/api/fetch-news \
  -H 'Content-Type: application/json' \
  -d '{"skipTranslation": true, "minPerCountry": 3}'
```

> **重要：这个接口是「立即返回、后台处理」。**
> 响应里只会告诉你「任务已启动」，真正的采集结果**不会**出现在 curl 的输出里，
> **要看 `pnpm dev` 那个终端的日志**。
>
> 修好之后日志会打印一条完整的漏斗，一眼能看出卡在哪一层：
>
> ```
> 新闻抓取完成：日期=2026-09-16｜原始采集 312 篇 → 投资相关候选 87 篇
>   → URL 去重剔除 41 篇 → 内容去重剔除 6 篇 → 实际入库 40 篇
> 各源采集量：The Astana Times=25 | Gazeta.uz=18 | ... | Asia-Plus=12
> ```
>
> 如果某几个源挂了，末尾会补一行：
> `3 个信息源采集失败：Newtimes.kz、24.kz、Khovar`

（旧版这里永远打印「共保存0篇」，是修的 bug 之一，现在数字是真的。）

### 3.4 验证 Telegram 抓取（可选）

微信云托管在大陆直连不了 `t.me`，必须经境外 Worker 代理。本地要测需要：

```ini
TELEGRAM_WORKER_URL=https://你的worker域名
TELEGRAM_CHANNELS=kz:@tengrinews, uz:@kunuzofficial@gazetauz
```

保留默认值时**不要**设 `TELEGRAM_CHANNELS`。抓取时日志会出现：

```
Telegram 待抓取频道（共 5 个）：kz:@tengrinews、uz:@kunuzofficial、uz:@gazetauz、kg:@akipress、tj:@asiaplus
```

看到几个频道就是解析对了几个——**配错会在这里立刻暴露**，不会再默默抓 0 篇。

### 3.5 公众号推送（本地跑不了）

推送走微信「云调用」鉴权，**只在微信云托管里能通**，本地必然失败。这是设计如此，不是 bug。
验证推送只能推到云托管环境后用 `POST /api/pipeline` 配合 `{"push": true}`。

---

## 提交/部署前的检查清单

- [ ] `pnpm verify:local` 全过
- [ ] `pnpm lint:build` 无 error
- [ ] `pnpm test:translate` 通过（有 Key 的话）
- [ ] `.env.local` 里的值**没有**被写进任何会被提交的文件
- [ ] 微信云托管控制台的环境变量已同步：`ZHIPU_API_KEY`（必填）、
      `DEEPSEEK_API_KEY` + `DEEPSEEK_MODEL=deepseek-flash`（降级通道，建议）、
      `SUPABASE_SERVICE_ROLE_KEY`（建议）、`TELEGRAM_WORKER_URL`（可选）。
      **改完别忘了「新建版本并部署」—— 只保存不部署，跑的还是旧值。**
- [ ] 型号代号已按厂商控制台「模型与价格」页核对过（`deepseek-chat` 已下线，现用 `deepseek-flash`）

---

## 常见报错速查

| 报错 | 原因 / 处理 |
| --- | --- |
| `? Do you want to continue? [Y/n]` 卡住 | corepack 交互确认，见第 0 节 |
| `EPERM: operation not permitted, rename '.../Library/Preferences/nextjs-nodejs/config.json'` | Next 想往 HOME 写配置但没权限。`scripts/dev.sh` 已内置 `NEXT_TELEMETRY_DISABLED=1` 规避 |
| `preinstall: npx only-allow pnpm` 相关失败 | 项目强制 pnpm，别用 npm/yarn 装依赖 |
| 翻译结果 `translated: false` | 所有通道都失败，看日志里的具体 HTTP 状态（429 = 欠费/限流） |
| 抓取日志显示入库 0 篇 | 看那条漏斗日志，判断是采集没拿到、还是全被去重剔掉 |
| 端口不是 3000 | 代码口径是 `DEPLOY_RUN_PORT` → `PORT` → `3000`，检查你是否 export 了 `PORT` |
