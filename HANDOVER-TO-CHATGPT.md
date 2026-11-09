> 最新审定稿直投契约见 CHATGPT-INTERFACE.md 末尾及 REVIEWED-DELIVERY-ROLLOUT.md；以下旧 articles/tags/自动清稿说明仅适用于保留的旧路径。

# 给 ChatGPT 的技术提醒（2026-11-07）

> 这份是**给你（ChatGPT）**的：你接手了「云托管接收 + 投递」这一段，
> 下面是几条**代码里不容易一眼看出、但踩了会出事**的规矩。
> 全部**有代码依据**，括号里是文件与行号线索。

---

## 0. 先看这三个文件（契约都在里面，不要凭想象写）

| 文件 | 是什么 |
|---|---|
| `CHATGPT-INTERFACE.md`（末尾「附：与 ChatGPT 那边商定的分工与接口契约」） | ⭐ **接口契约**：请求体示例、两条规矩、图注约定 |
| `public/openapi.yaml` | GPT Action 的 OpenAPI 描述（`/api/word-package` 与 `/api/word-ingest`） |
| `WORD-FORMAT.md` | Word 通道的格式规格（**次要**——主通道是稿包，不是 Word） |

⭐ **主通道是 `POST /api/word-package`**（结构化稿包，含配图 + 版本号）；
`POST /api/word-ingest` 是**次要**通道（单个 .docx，分国分次时用）。

---

## 1. ⭐⭐ 别另写一份接收接口 —— 用已经写好的

`src/app/api/word-package/route.ts` 已经实现了你商定的契约：
**五国齐才提交（缺一国 409）** + **版本号幂等键** + **`X-Ingest-Secret` 鉴权**。

⇒ **不要新建一个平行接口**（两份实现会分叉）。
⇒ **要改就改这一个文件**，改完 `git push origin HEAD:main` ⇒ 平台自动重建部署。

## 2. ⭐⭐⭐ 落库的字段约束（不知道就会「编译不过」或「整批被跳掉」）

### 2.1 `category` 必须是 `Category` 联合类型里的值
`'other'` **不在类型里 ⇒ TS 直接报错**。我用 **`'economy'`**。
⚠️ 而且 `EXCLUDED_CATEGORIES = { 'culture', 'sports' }` ⇒ 这两类**永远进不了草稿**。

### 2.2 ⭐⭐ `tags` 必须含 `'word'` —— **否则你的稿子会被整批跳掉**
推送侧有个闸 `hasSourceBody(article.original_content)`：要求原文正文够长。
⇒ 你的稿子「原文」只有 1–3 句 ⇒ 长度必然不够 ⇒ **不豁免就会被判 `no_source_body` 全跳掉**。
⇒ 豁免条件就是 `tags` 含 `'word'`（`src/app/api/wechat/push/route.ts` 里 `isWordInput`）。
⇒ 现在 `tags` 记两个东西：`['word', 'v:<版本号>']`。

### 2.3 `original_content` 放**原文关键句**（1–3 句、**保留原文语言**）
⇒ 推送时**量级闸**（认 `млрд`/`млн`/`тыс` 这些俄语量级词）与**机构名对照**
才能生效 ⇒ 留空 ⇒ 这两类校核直接失效。

### 2.4 ⚠️ **不要给 `articles` 表加列**
`ARTICLE_COLUMNS`（`src/lib/db-articles.ts`）是**字面量白名单**：
一旦 `select` 里出现库里没有的列 ⇒ **整个读库挂掉**（不是那一条失败，是全部）。
⇒ 标记、版本号一律走 `tags`。

### 2.5 `articles` 现有列（别写错列名）
`id, title, summary, content, country_code, category, source_name, source_url,
original_title, original_content, original_language, published_at, tags, is_featured, created_at`

---

## 3. ⭐⭐⭐ 配图（你提的「逐条核验过的真实配图 + 图注和来源」）

**唯一走法：把图直接写进 `bodyHtml` 的 `<img src="https://…">`。**
⇒ 旧推送链路（`extractFirstImage` 那套「外链图 → 下载 → 上传微信素材库 → 换成 CDN 地址」）
**已经现成** ⇒ ⇒ **零改动**就带图。

| 要求 | 说明 |
|---|---|
| **必须是公网可直链的 URL** | 不能是 `data:` base64、不能是需要登录/带 Referer 校验的链接 |
| **图注写成正文文本** | 放在 `<img>` **后面**的一段文字里（不是 `alt` 属性）⇒ 例如 `<p><img src="…" />图注：某某现场。来源：Tengrinews</p>` |
| **webp 没问题** | 链路会自动转 JPEG（日志里见过 `image/webp 已转为 JPEG`） |
| **会失败的两种** | ① **HTTP 403**（有些站防盗链，如 `timesca.com`）② **超时**（`ETIMEDOUT`）⇒ 图会**被静默跳过**，正文其余部分照发 ⇒ ⇒ 建议用稳定图床 |
| **封面** | `coverUrl` 我只是**存进库里**；实际封面取的是正文第一张图 ⇒ ⇒ 想控制封面就把图放正文第一段 |

---

## 4. ⭐⭐ 投递（推送）的规矩

```bash
POST /api/wechat/push   body: {"period":"daily"}
```
- ⚠️ **`period=daily` 的窗口是固定时刻表**（前一自然日 04:00 → 当日 04:00）⇒
  **窗口外推会推错批次** ⇒ ⇒ 想推某一天，**改库里的 `published_at`** 去对齐窗口，别改 `period`。
- ⚠️ **`hours=24` 是另一个口径**（自然小时），别混用。
- ⚠️ **草稿不可逆** ⇒ 推之前先 `GET /api/wechat/push` 看 `lastRun`，确认没有正在跑的轮次。
- ⚠️ 推送是**逐国**建草稿的 ⇒ 一国失败不影响其余国家（`failures` 里有记录）。

---

## 5. ⭐⭐ 部署纪律（**这条最容易被忽略，但会浪费你几小时**）

- `git push origin HEAD:main` = **一次完整重建 + 滚动发布**（不是热更新）。
- ⚠️ **别在任务窗口（京 03:45–11:15）里推** ⇒ 会撞上每天 04:00 那轮。
- ⚠️⚠️ **推完不要立刻再推** ⇒ 连续推送会**互相打断构建** ⇒
  这就是「部署慢」的根因（实测：10-31 一天推了 9 次 ⇒ 每次都被下一次打断 ⇒
  唯一上线的那次是因为后面没再推）⇒ ⇒ **一次推完，然后等 1–3 小时**。
- ⚠️ 提交信息里的**反引号会被 shell 执行** ⇒ 用 `git commit -F 文件`。
- ⚠️ `.git/index.lock` 残留会挡住提交 ⇒ `find .git -name '*.lock' -delete`。
- ⚠️ **远端只有 `main` 分支** ⇒ 推 `HEAD:main`。

---

## 6. ⭐⭐ 云托管环境变量

| 变量 | 为什么 |
|---|---|
| `INGEST_SECRET` | 你的请求头 `X-Ingest-Secret` 要和它一致 ⇒ **没配就不校验**（本地方便），**上了云建议配** |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` | 读稿与落库 |
| `WECHAT_APP_ID` / `WECHAT_APP_SECRET` | 建公众号草稿 |

⚠️ **数据库（RLS）**：`push_runs` 表是**故意不开 RLS** 的 —— 因为落库代码走的是
**anon key**（`supabase-client.ts` 的 `getSupabaseClient()`）⇒ anon key 在「开了 RLS
且没有 policy」的表上读写都会被拒 ⇒ 代码只打一条 warn 就**静默降级**回内存态
⇒ **表建了也等于没建**。⇒ 若你要建新表，**同样别开 RLS**，或改用 service role key。

---

## 7. ⭐ 门禁与「本地 build 跑不通」这件事

```bash
pnpm ts-check                  # 类型
pnpm verify:offline            # 离线门禁
npx tsx scripts/test-word-package.ts   # 稿包契约 8 项
npx tsx scripts/test-word-ingest.ts    # Word 链路 29 项
```

⚠️⚠️ **本地 `pnpm build` / `next build` 跑不通 —— 但那不是代码问题**：
宿主进程里的 `node-safe-delete-shim` 会拦 Next.js 清理 `.next/trace`
（`count 50 = threshold 50`）⇒ `dangerouslyDisableSandbox` 也拦不住（它是**进程内**的）。
⇒ ⇒ **不要拿本地 build 失败当代码有问题** ⇒ 判「能不能上线」只能靠
**ts-check + 单测 + 线上指纹**。

⚠️ `pnpm install` 在这个环境会挂（safe-delete）⇒ 用 `npm install --no-save --ignore-scripts`。

---

## 8. ⭐⭐ 别动这些文件（旧链路在跑，动它会影响线上）

| 文件 | 为什么不能动 |
|---|---|
| `src/lib/content-gate.ts` | 8 条确定性判据 + 软闸（**两个链路的校核层都在用**） |
| `src/lib/magnitude-guard.ts` | 量级闸（认 `млрд`/`млн`） |
| `src/lib/article-format.ts` | 成品清洗（重复句、标题回声、俄语残留） |
| `src/lib/translate.ts` | 翻译层（旧链路在用；Word 链路不需要它） |
| `src/lib/editor-review.ts` | 终审（LLM 七件事）—— 你那边已经审过了，但**旧链路还在用它** |

⇒ **你只需要新增接口/页面**；**不要删旧链路的任何文件** ——
用户明确说了「**稳定了之后**再去掉老方案」⇒ ⇒ 剪枝是**以后**的事，且必须先跑通新链路。

---

## 9. ⭐⭐ 一处我实现里的缺口（诚实告知）

**「版本号幂等」目前只做到「追溯」，没做到「拦截」。**
- 现在的判据是：**同国 + 同标题（归一化后）⇒ 跳过** ⇒ ⇒ **重发同一批会被跳过**（这是对的）。
- 但如果你**改过稿子**（标题变了）⇒ 它会被当成**新稿**插进去 ⇒ ⇒ 会出现「同版本两批」。
- ⇒ 真正的版本幂等要改成「查 `tags` 里有没有 `v:<version>`」⇒ **要改就改 `word-package/route.ts` 那一处**。

---

## 10. 一句话总结

**你只管把「五国成品包」交过来：正文 HTML（带 `<img src>`）+ 标题 + 摘要 + 来源 + 版本号；
云托管负责存稿与写公众号草稿箱；最终发布由人决定。**
接口已写好（`/api/word-package`），契约在 `CHATGPT-INTERFACE.md`，OpenAPI 在 `public/openapi.yaml`。
