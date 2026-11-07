# ChatGPT ↔ 本系统 的接口与协作方式（2026-11-07）

> 回答三个问题：① 我的角色 ② 有没有接口 ③ 代码跑在哪。

---

## ① 我的角色：**定期产出「审稿意见」的人**，不是链路上自动改稿的人

你的判据已经进了 ChatGPT 的提示词 ⇒ ⇒ 链路上**不需要**我替你做判断、再回喂 ChatGPT。
⇒ 正确的分工：

```
ChatGPT 写稿（已含你的判据）
   ↓
【我定期审稿】⇒ 产出一份「修改意见清单」（人话、带条目、带建议改法）
   ↓
你把清单贴给 ChatGPT ⇒ 它逐条改 ⇒ 输出定稿 Word
   ↓
上传 ⇒ 系统做第二道保险（抓漏网之鱼）⇒ 落库 ⇒ 推送微信草稿
```

⇒ **代码里那层自动校核**（`src/lib/word/audit.ts`）**不是主流程**，是**第二道保险**：
它的价值是「ChatGPT 没改干净的那几条」会被自动抓出来，而不是让你人工再翻一遍。

⇒ 而且它**零边际成本**：判据是确定性的 ⇒ 每天跑一遍不花钱、不调模型、不改稿。

---

## ② 接口：**有**，而且是为 ChatGPT Action 准备的

### 已就绪的东西

| 文件 | 作用 |
|---|---|
| `src/app/api/word-ingest/route.ts` | 上传接口：解析 → 校核 → 返回报告 + 修正清单 |
| `public/openapi.yaml` | **GPT Action 的 OpenAPI 描述**（可直接贴进 ChatGPT 的 Action 配置） |
| `src/app/word/page.tsx` | **网页上传页**（`/word`）：拖文件进去 ⇒ 看报告 ⇒ **一键复制修正清单** |

### 接口契约

```http
POST /api/word-ingest
Content-Type: application/json          ← 或 multipart/form-data
X-Ingest-Secret: <INGEST_SECRET>        ← 配了环境变量就必带

{ "fileBase64": "<base64 的 .docx>", "date": "2026-11-07", "persist": "1" }
```

返回：
```json
{ "ok": true,
  "parsed": { "articles": 17, "warnings": [...] },
  "audit":  { "total": 17, "findings": [...], "byCountry": {...} },
  "fixList": "# 五国日报稿件校核报告 …（可直接贴回 ChatGPT）",
  "persisted": { "inserted": 17, "skipped": 0 } }
```

### ⚠️ 关于「ChatGPT 自动传文件」的真实限制

**ChatGPT 的自定义 GPT Actions 传文件是不可靠的**（不同版本、不同模型行为差别大）。
⇒ ⇒ 我做了**两种输入形态**，你按实际情况选：

| 形态 | 什么时候用 | 怎么调 |
|---|---|---|
| **A. 网页上传**（推荐，最稳） | ChatGPT 给你 Word，你下载后拖到 `/word` 页面 | 浏览器 |
| **B. JSON + base64** | 你有个脚本/自动化能把文件转 base64 | `curl -H 'X-Ingest-Secret: …' -d '{"fileBase64":"…"}'` |
| **C. Action 直接传文件** | 你的 GPT 版本支持 | 在 Action 里配 `multipart/form-data` |

⇒ ⇒ **最可能的现实答案**：用 **A**（网页上传）做日常，**C** 作为可选的「全自动」通道。
⇒ ⇒ **不建议**把「自动落库 + 自动推送」完全交给 ChatGPT 触发 —— 草稿不可逆，
⇒ ⇒ 建议**始终保留「校核 → 你过目 → 再落库/推送」这一道人工闸**。

### 配 GPT Action 的步骤（在 ChatGPT 里）

1. 建一个 GPT → **Actions** → **Add an action**
2. 导入 `https://<你的域名>/openapi.yaml`（部署后这个 URL 就能公开访问）
3. 认证选 **API key** / 自定义头 `X-Ingest-Secret`，值 = 云托管环境变量 `INGEST_SECRET` 的值
4. 在 GPT 的指令里写：「生成完五国日报 Word 后，调用 `ingestWordDaily` 上传并把 `fixList` 原样返回给我」

---

## ③ 代码跑在哪：**微信云托管**（不是腾讯云 TCB）

| 项 | 值 |
|---|---|
| 平台 | **微信云托管**（腾讯 CloudBase 的云托管 run 形态） |
| 域名 | `central-asia-news-307705-12-1480606601.sh.run.tcloudbase.com` |
| 服务名 | `central-asia-news` |
| 规格 | 0.25 核 / 512 MB（`--max-old-space-size=320`） |
| 部署方式 | 微信云托管从 **GitHub `main` 分支**自动构建 ⇒ **push = 一次重建 + 滚动发布** |
| 定时 | 每天 **04:00**（窗口 = 前一自然日 04:00 → 当日 04:00） |

### ⚠️ 新旧两条链路怎么共存（**这是要你拍板的一件事**）

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| **A. 同一个服务，两种输入源**（⭐ 我推荐） | 部署新代码到同一个服务，用环境变量 `INPUT_SOURCE=word\|auto` 切换 | 一个域名、GPT Action 不用改；回退只要改环境变量 | 部署新代码会**替换**旧版本 ⇒ 但旧代码在 git 里 ⇒ 可回退 |
| **B. 新建一个服务** | `canews-word` 独立部署 | 两条链路完全隔离 | 要新域名、新环境变量、GPT Action 要换 URL；**成本翻倍**（两个实例都在跑 ⇒ 每天多一份实例时长） |
| **C. 先不部署** | 本地跑 Word 链路，推送仍用旧链路的云服务 | 零成本、零风险 | 「自动上传」这件事做不了 |

⚠️ **成本提醒**：日成本 = `T × (0.055×核数 + 0.032×内存GiB)`，T = 实例存活小时
⇒ ⇒ **多一个服务 = 每天多一份实例时长** ⇒ ⇒ 方案 B 要么多花约 13.6 元/月，要么让旧服务**按需起停**。
⇒ ⇒ **方案 A 更划算**（一个实例，按模式切换）。

---

## 下一步（按顺序）

1. **部署新代码到同一个服务**（方案 A）⇒ 先在本地/预发验一遍 `/word` 页面
2. **云托管加环境变量**：`INGEST_SECRET`（给 GPT Action 用）、`INPUT_SOURCE=word`
3. **配 GPT Action** ⇒ 先只做「上传 + 返回 fixList」，**不自动落库**
4. **推送侧接线**（还没做）：`db-articles.ts` 的 `getArticles({country_code, date})` 已经能用
   ⇒ 改动量 = 一个来源分支 + 跳过判组/总审两段
5. **稳了之后**再考虑剪枝（删抓取/翻译/定时那些用不上的）


---

## 附：与 ChatGPT 那边商定的分工与接口契约（2026-11-07 12:37 对齐）

### 分工（双方一致）
| 谁 | 做什么 |
|---|---|
| **ChatGPT** | 取源、筛选、去重、**事实核实的正文**、**独立审稿 + 复核后的终版**、**逐条核验过的真实配图**（附图注与来源）、国别标题/摘要/封面/完整排版/来源链接 ⇒ 产出「待你终检发布」的成品包 |
| **云托管（这里）** | **接收 + 投递**：存稿、存图、写入公众号草稿箱 ⇒ **不再调模型改写或审核**；最终发布仍由你决定 |

### ⭐ 两处我方与 ChatGPT 的差异及理由

1. **交付形态：结构化稿包（不是 Word）** —— 因为**图片塞不进 Word** ⇒ Word 稿收不到配图
   ⇒ 草稿会没有图。⇒ 所以正文 HTML 里**直接带 `<img src="https://…">`**，
   ⇒ **旧推送链路零改动**就会把它上传到微信素材库并换成 CDN 地址（`extractFirstImage` 那套现成）。
2. **云托管这层保留「确定性校核」，但不调模型、不改稿、只出报告** ——
   零成本、零延迟，能跨天跨实例核对（这是链路上唯一能做这件事的地方）⇒ 定位是**第二道保险**。

### 接口（**直接用已实现的，不要另写一份**）

仓库地址（**去密钥的**—— 仓库里本来就没有 `.env.local`）：
```
git@github.com:cedriczhou777/central-asia-news.git
```
⭐ 分支：**`main`**（= 线上那个服务在跑的分支）⇒ 部署 = push 到 main。

| 接口 | 用途 | 形态 |
|---|---|---|
| `POST /api/word-package` | ★ **五国成品稿包**（正文含图 + 版本号） | JSON |
| `POST /api/word-ingest` | 单个 .docx 上传（分国分次时用） | multipart **或** JSON+base64 |
| `GET /openapi.yaml` | **GPT Action 的 OpenAPI 描述**（直接贴进 ChatGPT 的 Action 配置） | — |

鉴权：请求头 `X-Ingest-Secret: <INGEST_SECRET>`（云托管环境变量；没配就不校验）。

#### `word-package` 的请求体
```json
{
  "version": "2026-11-07",
  "countries": {
    "kz": { "title": "…", "summary": "…",
            "bodyHtml": "<p>正文…</p><p><img src=\"https://…/a.jpg\" />图注：…</p>",
            "sourceName": "Tengrinews", "sourceUrl": "https://…", "coverUrl": "https://…" },
    "uz": { … }, "kg": { … }, "tj": { … }, "az": { … }
  }
}
```
- ★ **五国必须齐** ⇒ 缺任一国返回 **409**，不落库（半套稿子不进生产）
- ★ **幂等**：同 `version` + 同国 + 同标题 ⇒ 不重复插入（`tags` 里记 `word` 与 `v:<version>`）
- ★ **配图只走 `bodyHtml` 的 `<img src>`** ⇒ 旧链路自动上传到微信素材库
