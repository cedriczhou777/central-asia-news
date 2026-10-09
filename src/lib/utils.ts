import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// 从含图片的 content 中提取第一张图片 URL（支持 <img src> 标签）
export function extractFirstImage(content: string): string | null {
  const m = content.match(/<img[^>]*?\ssrc=["']([^"']+)["']/i);
  return m ? m[1] : null;
}

// 提取首图 URL，并从剩余正文中剥离图片标签
export function splitContentImage(content: string): { coverImage: string | null; textContent: string } {
  const coverImage = extractFirstImage(content);
  const textContent = coverImage
    ? content.replace(/<img[^>]*?>/gi, '').trim()
    : content.trim();
  return { coverImage, textContent };
}

// ---------------------------------------------------------------------------
// 语言与书写系统判定
// ---------------------------------------------------------------------------

/**
 * 「这段文本已经是中文产物」所需的**最少汉字个数**。
 *
 * ⚠️ **两个值都是在真实语料上定标出来的，别凭感觉改**（2026-09-23，7 天 × 5 国 1757 篇）：
 *
 * | 阈值 | 语料上被判「未翻译」的篇数 |
 * |---|---|
 * | `MIN_HAN_CONTENT = 60` | **106 篇（6.03%）** ← 危险，会静默丢稿 |
 * | `MIN_HAN_CONTENT = 30` | 11 篇（0.63%） |
 * | **`MIN_HAN_CONTENT = 20`（现值）** | **2 篇（0.11%）** |
 * | `MIN_HAN_CONTENT = 10` | 1 篇（0.06%） |
 *
 * 语料实测：正文汉字个数 min=4 / p1=34 / 中位=143；标题 min=6 / p1=12 / 中位=24。
 * 标题取 4（比语料下界 6 还低两个，留余量），正文取 20。
 *
 * 那 2 篇的正文汉字只有 11 个和 4 个 —— 是**正文残缺**的稿子（正文只有一两句），
 * 从「可推送」变成「未翻译」是**正确行为**，不是误杀。抽查过。
 *
 * 为什么刻意取低：本判据要区分的是「**0 个汉字**（模型把原文回显了）」和
 * 「译成了中文」，源语言 ru/kk/ky/az 的原文汉字个数恒为 0，
 * 所以 4 / 20 这个量级完全够用。阈值取高只会换来一种后果：**合格译文被静默丢弃**。
 */
export const MIN_HAN_TITLE = 4;
export const MIN_HAN_CONTENT = 20;

/** 去 HTML 标签、空白与常见标点，只留真正参与语言判定的字符。 */
function stripForLangCheck(text: string): string {
  return (text || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[\s，。、；：,.!?…\-"'“”‘’()·%$《》「」【】—–]+/g, '');
}

/** 汉字个数（先剥掉标签与标点）。 */
export function hanCount(text: string): number {
  return (stripForLangCheck(text).match(/[\u4e00-\u9fa5]/g) || []).length;
}

/** 汉字占比（保留给需要「比例」语义的调用方；语言判定不要用它，见 isChineseText）。 */
export function hanRatio(text: string): number {
  const cleaned = stripForLangCheck(text);
  if (!cleaned) return 0;
  return hanCount(cleaned) / cleaned.length;
}

/**
 * 词切分：空白 + 中英文常见标点。
 *
 * ⚠️ **`mixedScriptTokens` 与 `mixedScriptTokensLatin` 必须共用这一份。**
 * 两条判据的边界必须一致，否则「同一个词」在一边是一个 token、在另一边被切成两个，
 * 结论就会分叉 —— 本项目已经因为「同一条判据两处各写一份」栽过三次
 * （体检与生产不一致、闸 2 与闸 3 不一致、`isPushableText` 与 `pushExclusionReason` 分家）。
 */
const TOKEN_SPLIT_RE = /[\s，。、；：（）()「」“”"'·—\-–/《》【】!?！？]+/;

/**
 * 找出「一个词里同时含汉字和西里尔字母」的片段。返回空数组 = 干净。
 *
 * 为什么这条值得单独成函数：这种写法**结构上不可能正确** ——
 * 一段中文里不可能合法地出现 `米尔зиёё夫`／`肯еш`／`议员Владимир`。
 * 2026-09-23 实测 7 天 × 5 国 1757 篇里 **3.2% 的篇目**含这种词（156 种），
 * 全部是坏的，**没有一例误报**。所以它可以当**硬判据**用（判不合格 → 重试）。
 *
 * ⚠️ **故意不把「汉字 + 拉丁字母」也算进来**。看着对称，实际会误伤：
 * `60kg`／`100kg`／`center私立诊所` 这类是完全正常的写法，
 * 而这条判据的下游是「重试 → 三次都不过就丢弃该篇」，误报的代价是**静默丢稿**，
 * 不是排版难看。宁可少抓一种（`霍贾and` 那类交给提示词去要求）。
 */
export function mixedScriptTokens(text: string): string[] {
  const out: string[] = [];
  for (const tok of (text || '').split(TOKEN_SPLIT_RE)) {
    if (!tok) continue;
    if (/[\u4e00-\u9fff]/.test(tok) && /[\u0400-\u04ff]/.test(tok)) out.push(tok);
  }
  return out;
}

/**
 * 找出「一个词里同时含汉字和**拉丁字母**」的片段 —— 与 {@link mixedScriptTokens} 互补的那一半。
 *
 * ## 为什么这条曾经被明确否掉，2026-09-24 又拿回来
 *
 * `mixedScriptTokens` 的注释里写着「**故意**不把汉字+拉丁算进来」，理由是
 * `60kg`／`center私立诊所` 这类写法完全正常，而它的下游是「重试 → 三次不过就丢弃该篇」，
 * 误报的代价是**静默丢稿**。当时把 `霍贾and` 这一类判给了提示词去管。
 *
 * ⚠️ **这个假设被证伪了两次**：用户先报 `霍贾and`，2026-09-24 又报 `斯皮塔梅en区`
 * （`id=4492`）。而提示词第 6 条**早就逐字写着**这两个词作为反例
 * （`translate.ts` 的「绝不允许出现『霍贾and』『斯皮塔梅en』…这种写法」）——
 * 也就是说**反例被写进了提示词，模型照犯**。提示词管不住，就只能上闸。
 *
 * ## 判据：**汉字后面紧跟一段「全小写」的拉丁片段**，再加三条确定性排除
 *
 * 这个结构对应的是**专名被译了一半**：模型把 `Спитамен`/`Spitamen` 的前半截音译成
 * `斯皮塔梅`、后半截忘了处理，于是留下 `斯皮塔梅en`。所以判据只认「汉字在前、拉丁在后」。
 *
 * | 放行（正常写法） | 命中（译文缺陷） |
 * |---|---|
 * | `CEO表示`、`GDP增长`、`B超`、`维生素C`、`3D打印`、`pH值`、`iPhone手机`、`60kg`、`Egemen.kz` | `斯皮塔梅en`、`霍贾and`、`阿克tau市`、`哈萨克mys`、`沙霍比丁hon` |
 *
 * 放行靠**结构**而不是白名单，四条规则：
 * 1. 拉丁片段必须**全小写**（`run === run.toLowerCase()`）⇒ 大写缩写与驼峰专名（`CEO`/`GDP`/`iPhone`）全部放行。
 *    引号类字符（`‘ ’ ʻ ʼ`）算进拉丁片段一起匹配，所以 `G‘aniyev` 是一个整体、不会被切成 `G`+`aniyev`。
 * 2. 片段**前一个字符必须是汉字**。这一条同时排掉 `aniyev`（引号被当分隔符切开后的残段）与
 *    整词漏译的 `şəbəkəsi`，代价是漏掉「片段在词首」的形态（如 `aktau市`）—— 实测语料里没有。
 * 3. 片段**两侧紧邻的字符不是 `.`** ⇒ 排掉域名（`Egemen.kz`、`inbusiness.kz`、`现代.az`）。
 * 4. 片段**前一个字符不是数字** ⇒ 排掉计量（`60kg`、`100kg`、`50km`）。
 *
 * ⚠️ **2026-09-24 实测**：只用「小写片段」一条时误报 44%（4/9 篇）；补上规则 4 之前的中间版本
 * 在 7 天语料上仍有 3 个误报类（见上表右列的 `60kg`/`G‘aniyev`/`inbusiness.kz`）。
 * 四条规则齐备后，**1977 篇语料上误报 0**（23 处命中逐条人工看过，全是真缺陷）。
 * 这达到了 `mixedScriptTokens` 当年进闸的同一标准（156 种词、0 误报）。
 *
 * ⚠️ 仍**看不见**「整个词漏译成西里尔」那一类（`Mirlan Жеенчороев`），那是另一个盲区。
 */
export function mixedScriptTokensLatin(text: string): string[] {
  const HAN = /[\u4e00-\u9fff]/;
  const out: string[] = [];
  for (const tok of (text || '').split(TOKEN_SPLIT_RE)) {
    if (!tok) continue;
    // 必须含汉字 —— 纯拉丁/纯数字词（`60kg`、`AIIB`）不是本判据的对象
    if (!HAN.test(tok)) continue;
    // 用 `\p{Script=Latin}` 而不是 `[A-Za-z]`：后者会把带变音符的拉丁名切碎
    // （`Alagözov` → `Alag` + `zov`，后半段误命中）。引号并入片段，见规则 1。
    for (const m of tok.matchAll(/[\p{Script=Latin}'\u2018\u2019\u02bb\u02bc]+/gu)) {
      const run = m[0];
      if (run.length < 2) continue;
      if (run !== run.toLowerCase()) continue; // 规则 1
      const at = m.index ?? 0;
      const prev = at > 0 ? tok[at - 1] : '';
      const next = tok[at + run.length] ?? '';
      if (!HAN.test(prev)) continue; // 规则 2
      if (prev === '.' || next === '.') continue; // 规则 3
      if (/[0-9]/.test(prev)) continue; // 规则 4
      out.push(tok);
    }
  }
  return out;
}

/**
 * 找出「汉字后面紧跟一段**首字母大写**的拉丁片段」的片段 —— 覆盖 {@link mixedScriptTokensLatin}
 * 够不着的那一半：`卡赫拉莫恩·库罗诺Boyev`（用户 2026-09-28 报的）。
 *
 * ## ⚠️⚠️ 这个函数**只做体检、不能进闸**。原因必须看完再考虑用它做判据
 *
 * `mixedScriptTokensLatin` 用「片段必须**全小写**」这一条，顺便把
 * `CEO表示`／`GDP增长`／`维生素C` 这类正常写法全放行了（规则 1）。
 * 而用户报的 `库罗诺Boyev` 是**大写开头**的，被规则 1 顺手放过 —— 这是那个判据的已知缺口。
 *
 * 直觉上「把规则 1 从『全小写』放宽到『首字母大写也算』」就能补上。**实测不行**：
 * 2026-09-28 在 500 篇真实语料上跑放宽版，命中 49 种 / 25 篇，逐条人工过目后
 * **绝大多数是正常的**，因为按现行口径「职务中文 + 人名拉丁」是**规定写法**：
 *
 * | 命中（**正常**，不能拦） | 命中（真缺陷） |
 * |---|---|
 * | `哈萨克斯坦国际象棋联合会主席Timur`、`临时负责人Romanos`、`美国国务卿Rubio` | `库罗诺Boyev` |
 * | `阿塞拜疆总统Ilham`、`任命由曼吉斯套州州长Nurdaulet`、`企业家兼收藏家Timur` | `朱纳奥Zen市` |
 * | `作为Freedom`、`XRG和TotalEnergies`、`白俄罗斯High`、`铁路建设将覆盖Zabrat` | |
 *
 * ⇒ 放宽后**必然误伤**「中文职务/连接词 + 拉丁人名」——而那是产品**要求**的写法。
 * 而这条判据的下游是「重试 → 三次不过就丢弃该篇」，误报的代价是**静默丢稿**，
 * 500 篇里 25 篇（5%）的量级不可接受。所以**放宽版只能当体检指标，不能当闸**。
 *
 * ## 那 `库罗诺Boyev` 怎么防？
 *
 * 只能靠**提示词**（见 `translate.ts` 提示词第 6 条的人名两类规则 + 反例），
 * 并把本函数的命中数当作「提示词有没有生效」的观测量盯着。
 * 想真正把它变成闸，需要能区分「`库罗诺` 是音译残段」和「`主席` 是中文词」——
 * 那是**词义判断**，正则做不到；可行方向是拿原文比对（拉丁原文里 `Boyev` 只是
 * `Quronboyev` 的后缀，而 `Tokayev` 是原文里的独立词），但西里尔原文的语料覆盖不到。
 *
 * ⚠️ 判据构造与 {@link mixedScriptTokensLatin} **共用同一个 `TOKEN_SPLIT_RE`**，
 * 边界必须一致（理由见那个常量的注释）。
 */
export function mixedScriptTokensLatinCapitalized(text: string): string[] {
  const HAN = /[\u4e00-\u9fff]/;
  const out: string[] = [];
  for (const tok of (text || '').split(TOKEN_SPLIT_RE)) {
    if (!tok) continue;
    if (!HAN.test(tok)) continue;
    for (const m of tok.matchAll(/[\p{Script=Latin}'\u2018\u2019\u02bb\u02bc]+/gu)) {
      const run = m[0];
      if (run.length < 2) continue;
      // 与 `mixedScriptTokensLatin` 的差别只有这一条：全大写缩写（CEO/GDP/KFB）仍然放行，
      // 「首字母大写」不再放行 —— 代价见上面的表格。
      if (/[\p{Lu}]{2}/u.test(run)) continue;
      const at = m.index ?? 0;
      const prev = at > 0 ? tok[at - 1] : '';
      const next = tok[at + run.length] ?? '';
      if (!HAN.test(prev)) continue;
      if (prev === '.' || next === '.') continue;
      if (/[0-9]/.test(prev)) continue;
      out.push(tok);
    }
  }
  return out;
}

/**
 * 找出「一个词里同时含**拉丁字母**和**西里尔字母**」的片段 ——
 * 上面三条判据全都够不着的那个盲区。
 *
 * ## 为什么前三条都抓不到它
 *
 * | 函数 | 判据的锚点 | 对 `Kaрабалиева` 的反应 |
 * |---|---|---|
 * | `mixedScriptTokens` | **汉字** + 西里尔 | ✗ 没有汉字 |
 * | `mixedScriptTokensLatin` | **汉字** + 小写拉丁片段 | ✗ 没有汉字 |
 * | `mixedScriptTokensLatinCapitalized` | **汉字** + 拉丁片段 | ✗ 没有汉字 |
 *
 * 三条判据的锚点都是汉字 ⇒ 一整类「名字被翻译了一半、且那半截旁边**没有汉字**」的
 * 缺陷全部漏过：`Kaрабалиева`、`Natалья`、`KTЖ`、`BUТБ`、`Guly Kожокулова`。
 * 2026-09-24 首次量出这一类（当时以 `analyze:nouns` 的 T2 报告段呈现）。
 *
 * ## 判据：同一个 token 里既有拉丁字母又有西里尔字母
 *
 * 与前三者同族 —— 都是「**书写系统层面**自相矛盾」，不是风格问题：
 * 一段中文译文里的**一个词**要么是汉字、要么是**一种**字母的完整转写；
 * 一半拉丁一半西里尔，不可能对应任何正确的写法。
 *
 * 用 `\p{Script=Latin}` 而不是 `[A-Za-z]`，理由与 `mixedScriptTokensLatin` 相同：
 * 后者会把带变音符的拉丁名切碎（`Alagözov` → `Alag` + `zov`）。
 * 分隔符复用 `TOKEN_SPLIT_RE`（理由见那个常量的注释）：判据之间的边界必须一致。
 *
 * ## ⚠️ 2026-09-29 进闸前的实测（**这条判据的进闸依据，别凭印象推翻**）
 *
 * 样本 = 线上 6 天 2837 篇（`/api/articles?date=` 逐日抓，同 `analyze:cover-gaps` 的做法），
 * 跑 `pnpm analyze:mixed-script`：
 *
 * | 指标 | 值 |
 * |---|---|
 * | 命中篇数 | 49 / 2837 = **1.73%** |
 * | 不同词种 | 60（其中 **53 种不含汉字** ⇒ 现有闸完全看不见） |
 * | 现有两条闸在同一样本上 | 汉字+西里尔 17 篇 / 汉字+拉丁 6 篇 |
 * | 逐条人工判读 | **60/60 全是真缺陷，误报 0** |
 *
 * 命中样例（全部是「名字/机构名被翻了一半」）：
 * `Aйдос Мырзахметов`（标题级）、`Kosанов`、`Мырзахметov`、`TОО`、`MЧС`／`MЧS`、
 * `Akorда`／`Aкорду`、`Kazselezащиты`、`ENPФ`、`NПЗ`、`MFCА`、`Kыргызалтын`、
 * `«Khовар»`／`«Xовар»`、`BUТБ`、`Tоксанбаева`、`dastorкон`、`Kuruлtyа`。
 *
 * 这个量级与 `mixedScriptTokens` 当年进闸的证据持平（1757 篇 / 156 种 / 0 误报），
 * 所以按同一标准可以当**硬判据**。
 *
 * ## ⚠️ 两条**必须**保留的结构性排除（都是实测出来的，不是预防性加码）
 *
 * 排除只可能让判据**漏**、不会让它**多杀** —— 在下游是「重试→丢稿」的前提下，
 * 这是唯一安全的方向（项目纪律：宁漏不误杀）。
 *
 * 1. **`@`** ⇒ 邮箱／句柄（`info@почта.кз` 这种会被 `@` 之外的规则粘连成一个 token）。
 * 2. **结尾是 `.<2–4 个拉丁字母>`** ⇒ 文件扩展名。
 *    ⚠️ 这一条是**真的要**：同一样本 2837 篇里有 **2445 个 `<img src>`，其中 6 个的文件名含西里尔**
 *    （`Изображение-JPEG-4AF0-A230-E1-0.jpeg`、`фото-2-1.jpeg`、`foto-№-1-2-1536x1025.jpg`）。
 *    这一次它们没被误杀，只是因为 `-` 恰好在 `TOKEN_SPLIT_RE` 里把名字切开了；
 *    同一个站换个命名（`фото.jpeg`，不带连字符）就会变成「`фото` + `.jpeg`」一个 token ⇒ **误杀一篇好稿**。
 *    判据靠「恰好」活着是不行的，所以按结构排掉。
 */
export function latinCyrillicTokens(text: string): string[] {
  const out: string[] = [];
  for (const tok of (text || '').split(TOKEN_SPLIT_RE)) {
    if (!tok) continue;
    if (tok.includes('@')) continue; // 邮箱/句柄，见上「排除 1」
    if (/\.[A-Za-z]{2,4}$/.test(tok)) continue; // 文件扩展名，见上「排除 2」
    if (/\p{Script=Latin}/u.test(tok) && /[\u0400-\u04ff]/.test(tok)) out.push(tok);
  }
  return out;
}

/**
 * 找出「下降类动词 + 数字 + 倍」这类**在中文里逻辑不成立**的说法（用户 2026-09-28 报的）。
 *
 * ## 为什么这是一个「结构性」判据，而不是阈值
 *
 * 「下降 N 倍」在中文里没有合法语义：1 元下调 1.5 倍 = 1 − 1×1.5 = −0.5 元，是负数。
 * 它来自俄语/中亚语言的两种表达式被**直译**：
 *   - `снижение в 1.5 раза`（в N раза = 变成原来的 1/N）
 *   - `понижающий коэффициент 1.5`（按系数除，不是乘）
 * ⇒ 反过来说，**任何**「下降类动词 + 数字 + 倍」的搭配都是错的，
 * 不存在「有时对」的情况 —— 这正是它比 `mixedScriptTokensLatin` 更适合当闸的原因。
 *
 * ## ⚠️ 刻意**不**跨过「至 / 到」
 *
 * `下降至 / 降低到` 与 `下降了` 语义不同（「降至 1.5 倍」是「变成 1.5 倍」，
 * 不是「减少了 1.5 倍」）。为把误报压到 0，判据**在动词与数字之间不接受「至 / 到」**：
 * `下降至 1.5 倍` 不命中，`下降 1.5 倍` 命中。
 * 代价是「下降至 1.5 倍」这种别扭写法漏掉 —— 可接受的漏，
 * 因为误报的代价是**静默丢稿**，而漏报只是少拦一条。
 *
 * ## 增长方向**不管**
 *
 * 「增长 2 倍」「翻一番」是合法中文，一律放行。本函数只认下降方向。
 *
 * ## 覆盖不到的部分（写清楚，免得误判疗效）
 *
 * - 中文数字写法「下调一点五倍」不命中；
 * - 只说「按 1.5 倍系数下调」而**不交代是乘还是除**的，判据抓不到 ——
 *   那属于**信息缺失**而非逻辑错误，靠提示词第 7 条要求「必须说清乘除」。
 */
export function descendingMultiplePhrases(text: string): string[] {
  const out: string[] = [];
  // 下降类动词（**只收下降方向**）。动词与数字之间最多容一个「了 / 的」，
  // 不放行「至 / 到」——理由见上面那一段。
  const RE =
    /(下降|下跌|下调|调低|降低|减少|下滑|跌幅|降幅|降价|调降|削减|缩减)(了|的)?\s*(\d+(?:\.\d+)?)\s*倍/g;
  for (const m of (text || '').matchAll(RE)) out.push(m[0].trim());
  return out;
}

/**
 * 删掉「含西里尔字母、而且一个汉字都没有」的**括注**（`（…）` / `(…)`）。
 *
 * ⚠️ **这是确定性后处理，不是判据。** 它不判合格/不合格、不触发重试、**没有丢稿风险** ——
 * 这正是它存在的理由：同类问题如果做成闸，代价是「重试 ×3 不过 ⇒ 静默丢稿」，
 * 而它的危害只是读者看到一个多余的括注。两者的分量不匹配，所以只能这么解。
 *
 * ## 它修的是哪一类（2026-09-29 定量，样本 = 线上 7 天 3528 篇）
 *
 * 提示词第 6 条**早就逐字写着**「除引用原文标题（放在《》里）外，译文里不得出现西里尔字母」，
 * 而实测仍有 210 篇（5.95%）留着西里尔。其中**括注**形态是整齐的一类，形态只有两种：
 *
 * | 形态 | 例 |
 * |---|---|
 * | 机构名 + 括注原文缩写 | `吉尔吉斯斯坦国家税务局（ГНС）`、`增值税（НДС）`、`议会（Жогорку Кенеш）` |
 * | 中文译名 + 括注原文全称 | `基础设施发展基金（Фонд инфраструктурного развития）` |
 *
 * **实测本函数会改动 113 篇（3.20%）/ 142 个字段、共 162 处括注**
 * （`pnpm analyze:cyrillic-note`，数字一律来自本文件的生产判据，仪器不另写正则）。
 *
 * **为什么删它是安全的**：干跑逐处过目，100 余种括注**全部**是「中文名（原文全称/缩写）」，
 * 中文名**一定**在括注前面（161 处紧邻汉字，另 8 处隔着 `」`/`”`/`’`/空格）——
 * **0 处删完会丢信息**，删完读起来还更干净。
 * 反面样例是**内含汉字**的括注（实测 3 处：`（当地称「аркар」和「кулжа」）` id=4307、
 * `（成员为 Arina Malinovskaya, Sofia Shulzhенко…）` id=5906、`（阿克亚к特）` id=3530），
 * 那些**在提供信息**，判据里的「不含汉字」这一条就是为它们设的，三个都钉成了反例。
 *
 * ⚠️ **本函数只管括注那一半。** 另有 **904 处西里尔裸露在括注之外**
 * （`外交部长 Жээнбек Кулубаев`、`Жапаров：到2026年底…`），这一半**删不得** ——
 * 删了读者就不知道是谁了，等于用「不出现西里尔」换「丢事实」。
 * 它的解法是一张「西里尔专名 → 中文」的表，属**另一件**没做的事。
 *
 * ## 为什么**只**动 `（）`/`()`，不动 `「」`/`“”`/`《》`
 *
 * 实测 `【】`／`[]`／`〔〕` 里含西里尔的是 **0 处**（不用管）；`「」` 有 55 处、`“”` 19 处、
 * `《》` 1 处。这四类**故意不碰**：
 * - `《》` 是提示词第 6 条**明确允许**放原文标题的地方（那 1 处 `《Q2 2026: …》` 是对的）；
 * - `「」`／`“”` 在中文新闻里还有「引用原话」的用法，删掉引号内容可能删掉真信息，
 *   而判据无法区分「机构名的原文」和「引用的原话」⇒ **按「宁漏不误杀」不动它**。
 *
 * 按此口径，本函数能**整篇清干净**「只含这一种形态」的那些篇（113 篇里有 12 篇
 * 同时还有括注外的裸露西里尔，那 152 篇只有裸露西里尔 —— 见上面那句「只管括注那一半」）。
 *
 * ## 两条结构性排除（都不是预防性加码）
 *
 * 1. **HTML 标签内部不碰**：`content` 里有 `<img src="...">`，同批样本 2445 个 `<img src>`
 *    中有 6 个文件名含西里尔（`Изображение-JPEG-4AF0…jpeg`）。标签是**代码**不是译文，
 *    动它会直接损坏正文结构。
 * 2. **`《》` 内部不碰**：理由如上。
 *
 * 实现上这两处用**等长以外**的占位符暂时摘出来（`\u0000N\u0000`），
 * 并把 `\u0000` 排除在括注内部的字符类之外 —— 于是「括注里套着一个标签」这种病态写法
 * **压根不会匹配**（宁可漏，不可误删）。
 *
 * ⚠️ **别把本函数接到闸门上**（`translated:false` 那条路）。它的定位是「交付前的清理」，
 * 当前唯一的调用点是 `translate.ts` 的 `normalizeResult`。要改成闸，先回去读本注释第一段。
 */
const CYRILLIC_RE = /[\u0400-\u04ff]/;
const HAN_RE = /[\u4e00-\u9fff]/;
/** 占位符前缀：`\u0000` 不会出现在真实正文里，也不会出现在括注内部的字符类里。 */
const STASH_PREFIX = '\u0000';
/**
 * 括注匹配。**这份正则必须只有一份** —— `stripCyrillicParentheticals`（生产）
 * 与 `cyrillicParentheticalNotes`（仪器/体检）共用它。
 *
 * 两侧可选的 `[ \t]?`（**半角**空格）是顺手吃掉删掉括注后留下的那个空格：
 * 半角形态写作 `公司 (УТЙ) 管理层`，只删 `(УТЙ)` 会留下**两个**空格；
 * 全角形态 `公司（НДС）收入` 两侧没有空格，不受影响。
 * 未删时返回的是整个 `whole`，所以「匹配到但保留」的情况下空格一个不少。
 */
const CYRILLIC_NOTE_RE = /[ \t]?[（(]([^（()）\u0000]*)[）)][ \t]?/g;

/** 把「不许动」的区段（HTML 标签、`《》` 引文）摘成占位符，并给出还原函数。 */
function maskProtected(text: string): { masked: string; restore: (s: string) => string } {
  const stashed: string[] = [];
  const masked = text
    .replace(/<[^>]*>/g, (m) => {
      stashed.push(m);
      return `${STASH_PREFIX}${stashed.length - 1}${STASH_PREFIX}`;
    })
    .replace(/《[^》]*》/g, (m) => {
      stashed.push(m);
      return `${STASH_PREFIX}${stashed.length - 1}${STASH_PREFIX}`;
    });
  return {
    masked,
    restore: (s) =>
      s.replace(new RegExp(`${STASH_PREFIX}(\\d+)${STASH_PREFIX}`, 'g'), (_m, i) => stashed[Number(i)]),
  };
}

/**
 * **体检用**：列出这段文本里「会被 {@link stripCyrillicParentheticals} 删掉」的括注内容。
 *
 * ⚠️ 存在的理由是「**判据只能有一份**」。仪器脚本若要自己写一条正则去数命中，
 * 就会与生产函数分叉 —— 本项目已经因为「同一条判据两处各写一份」栽过三次
 * （体检与生产不一致、闸 2 与闸 3 不一致、`isPushableText` 与 `pushExclusionReason` 分家）。
 * 所以数命中、做干跑、写报告一律调这个函数，**不要另写正则**。
 */
export function cyrillicParentheticalNotes(text: string): string[] {
  if (!text || !CYRILLIC_RE.test(text)) return [];
  const { masked } = maskProtected(text);
  const out: string[] = [];
  for (const m of masked.matchAll(CYRILLIC_NOTE_RE)) {
    if (isRedundantCyrillicNote(m[1])) out.push(m[1].trim());
  }
  return out;
}

export function stripCyrillicParentheticals(text: string): string {
  if (!text || !CYRILLIC_RE.test(text)) return text;

  const { masked, restore } = maskProtected(text);

  // 括注内部的字符类里排除 `\u0000` ⇒ 括注含占位符（即内含标签/引文）时整个不匹配。
  const stripped = masked.replace(CYRILLIC_NOTE_RE, (whole: string, inner: string) =>
    isRedundantCyrillicNote(inner) ? '' : whole,
  );
  if (stripped === masked) return text; // 没有任何改动 ⇒ 原样返回，不做无谓还原

  return restore(stripped);
}

/** 括注内容是否「纯冗余的西里尔原文」——判据见 `stripCyrillicParentheticals` 注释。 */
function isRedundantCyrillicNote(inner: string): boolean {
  const s = inner.trim();
  if (!s) return false;
  if (HAN_RE.test(s)) return false; // 括注里已有汉字 ⇒ 它在提供信息，不是冗余原文
  // 要求 **≥2 个**西里尔字母：单个西里尔字母的括注（如 `（Б）` 指选项）含义不明，
  // 按「宁漏不误杀」放过。
  return (s.match(/[\u0400-\u04ff]/g) || []).length >= 2;
}

/**
 * 检测文本是否为中文：**汉字个数 ≥ minHan** 即视为已翻译为中文。
 *
 * ## ⚠️ 2026-09-23 改过判据（占比 → 绝对个数），改之前先读完
 *
 * 旧实现是「汉字**占比** ≥ 0.4，拉丁字母计入分母」。在「人名保留拉丁」的旧口径下
 * 实测余量只有 0.005（min 0.405），注释里就写着「改动上线后要复查这个分布」。
 * 2026-09-23 口径扩成**人名/地名/国名/公司名/机构名一律保留拉丁**之后，
 * 占比会掉到 **0.27–0.36**，**低于 0.4** ——
 * 于是「翻译完全正确」的稿件会被判成「未翻译」，重试三次后**静默丢弃**。
 * 更隐蔽的是 `article-format.ts` 的 `isPushableText()` 也用这个判据，
 * 那意味着**稿子入库了却永远推不出去**。
 *
 * 换判据的理由：要回答的问题是「**有没有真的翻译**」，而不是「汉字占多大比例」。
 * 源语言只有 ru / kk / ky / az，**原文里的汉字个数恒为 0**，
 * 而只要译了，标题就有十来个汉字。区分度是「0 vs 十几个」，绝对个数完全够。
 * 占比这个仪器在这里**从根上选错了**：它惩罚的恰好是产品上正确的行为。
 *
 * ⚠️ 调用方请用 `article-format.ts` 的 `isPushableText()` / `pushExclusionReason()`，
 * 或 `translate.ts` 的 `normalizeResult`，**不要**再在这里写裸调用：
 * 这个表达式曾在两处各写一份，就是历史上三次「体检与生产不一致」的起点。
 */
export function isChineseText(text: string, minHan = MIN_HAN_TITLE): boolean {
  const cleaned = stripForLangCheck(text);
  if (!cleaned) return false;
  return hanCount(cleaned) >= minHan;
}

// ----- 内容级去重工具（基于语义化归一化 + n-gram 相似度）-----

// 归一化文本：统一小写、去标点/空白、去停用词，保留主体信息
export function normalizeText(text: string, maxLen = 120): string {
  const t = (text || '')
    .replace(/<[^>]+>/g, ' ')                       // 去 HTML 标签
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')              // 仅保留字母/数字/空白（Unicode 属性支持）
    .replace(/\s+/g, ' ')
    .trim();
  return t.split(' ').slice(0, maxLen).join(' ');
}

// 字符级 bigram 集合（Jaccard 用）
function charBigrams(text: string): Set<string> {
  const set = new Set<string>();
  const cleaned = text.replace(/\s+/g, '');
  if (cleaned.length <= 1) {
    set.add(cleaned);
    return set;
  }
  for (let i = 0; i < cleaned.length - 1; i++) {
    set.add(cleaned.substring(i, i + 2));
  }
  return set;
}

// Jaccard 相似度（0-1）
export function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (na === nb) return 1;
  const sa = charBigrams(na);
  const sb = charBigrams(nb);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const g of sa) if (sb.has(g)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

// 两条新闻是否为重复内容（标题+正文综合相似度超过阈值即视为重复）
//
// ⚠️ 2026-09-29 删除。保留注释是为了**防止它被重新写回来**（不是忘了删）：
// 实测在 200 篇与 1000 篇两份线上快照上**零触发**，却会误合并
// 「金价下跌」与「金价上涨」这类**方向相反**的新闻。
// 真正的去重入口是 `same-event.ts` 的 `dedupeStories`（L0/L1/L1.5/L2 四层），
// 别把这条阈值判据接回去。历史说明见 AGENTS.md 的「抓取放宽与内容去重」。

// ----- 链接归一化（「同一原文」的唯一指纹）-----

/** 已知的追踪类查询参数：只影响统计，不影响指向哪篇文章。 */
const TRACKING_PARAM = /^(?:utm_[a-z0-9_]*|from|ref|referrer|referer|fbclid|gclid|yclid|_ga|_gl|spm|share_[a-z0-9_]*|source|src|sharer|s|si)$/i;

/**
 * 把指向同一篇原文的不同链接形式归一到同一个字符串。
 *
 * 为什么必须有这个函数：原项目的去重是对 `source_url` 做**精确字符串比较**，
 * 而同一个源站的同一条新闻在不同抓取路径下链接会变形 ——
 * RSS 里带 `?from=rss`、带末尾斜杠、带 `#anchor`、带 `utm_*` 追踪参数、
 * 带或不带 `www.`。这些形式字符串不相等，去重就漏过去了，
 * 结果是**同一条新闻被翻译两次、入库两次、在公众号草稿里连着出现两遍**
 * （2026-09-21 用户在预览里截到的那对阿斯塔纳桥梁新闻就是这么来的：
 * 两篇的 source_url 逐字相同，却都在库里）。
 *
 * 归一化规则（只做「显然指向同一篇」的等价变换，不做任何猜测）：
 *   - 去掉协议与 `www.`（http/https、有无 www 不改变指向）
 *   - 去掉 fragment（`#...`）
 *   - 去掉已知追踪参数，保留其余查询参数并排序
 *     （**不能**粗暴删掉整个 query：Tazabek 这类站的 query 里可能带文章号）
 *   - 去掉末尾斜杠，host/path 小写
 *
 * 非法 URL（相对路径、脏数据）退化为「去 fragment、去末尾斜杠的小写串」，
 * 至少还能做到大小写/末尾斜杠的等价合并。
 */
export function canonicalUrl(url: string): string {
  const raw = (url || '').trim();
  if (!raw) return '';

  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return raw.toLowerCase().replace(/[#?].*$/, '').replace(/\/+$/, '');
  }

  const params = [...u.searchParams.entries()]
    .filter(([k]) => !TRACKING_PARAM.test(k))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const host = u.host.toLowerCase().replace(/^www\./, '');
  const path = u.pathname.replace(/\/+$/, '');
  const query = params.map(([k, v]) => `${k}=${v}`).join('&');
  return `${host}${path}${query ? '?' + query : ''}`;
}

// ----- 「同一篇原文」的指纹 -----

/**
 * 原文标题归一化后作为「同一篇原文」的指纹（`''` 表示没有可用指纹）。
 *
 * 用途：同一条 feed 项在同一站点可能有多个链接（聚合页 / 带参链接 / 转载），
 * 链接归一化挡不住「不同链接指向同一篇原文」，但**原文标题是逐字相同的**，
 * 所以它比中文译名可靠得多 —— 译名会因翻译波动而不同，原文标题不会。
 *
 * 只保留字母/数字/汉字（丢掉标点与空白：不同轮次抓取可能套上不同空白或零宽字符），
 * 长度不足 10 的直接返回空 —— 短标题极易撞车（「新闻」「摘要」之类），
 * 宁可放过不要错并（把两条不同新闻合成一条是**丢信息**，比留重复更糟）。
 *
 * 注意：`db-articles.ts` 与 `same-event.ts` 必须用**同一个**指纹函数，
 * 否则「入库时判重」与「选稿时判重」会各自为政。
 */
export function originalTitleKey(title: string): string {
  const cleaned = (title || '')
    .replace(/<[^>]*>/g, ' ')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
  return cleaned.length >= 10 ? cleaned : '';
}

/**
 * 文本指纹：**用来回答「两次调用看到的是不是同一段文本」**。
 *
 * ## 为什么需要它（2026-10-08 实测的空白）
 *
 * `GET /api/dedupe-check?...&llm=1` 的响应把判定结果**按结论分桶**
 * （`pairs` 判是、`declined` 判否、`vetoed` 极性拦下），**既不保留提问顺序、
 * 也不回显提示词**。于是同一窗口内重复跑、答案却变了这件事，**分不出因与果**：
 *   · 因——提示词组成/编号漂了（文章列表按 `id` 升序取，但窗口锚点是每次请求
 *     现算的 `now-3d`，两次之间文章集合差几行就会整体改号）；
 *   · 果——通道在 `temperature=0` 下仍不确定。
 * 实测：10-07 的 uz 三次判是分别是 9/15/9（6 对翻转），kg 14/11/14（3 对），
 * 而且三次的**题目集合完全相同**（只差答案）。
 *
 * ⇒ 把这个指纹在 `debug=1` 时回显出来，**两次调用一比就能定案**：
 *   指纹相同 ⇒ 提示词逐字相同 ⇒ 只能赖通道。
 *
 * ⚠️ 但「指纹**不同**」**不足以**说是「提示词漂了」—— 它分不清「题目换了」还是
 * 「题目没换、只是顺序变了」（它当然包含顺序，因为提示词就是按问序渲的）。
 * 所以 2026-10-08 又补了 {@link askedPairsFingerprint}：两个指纹一起看才是三分。
 *
 * ## 口径
 *
 * FNV-1a 32 位 + `-` + 字符数。**不是密码学哈希**，只做相等性对照，不做安全用途。
 * 带上长度是有意的：长度变了肉眼立刻能看见（提示词长短变化），
 * 也顺带把 32 位空间里「长度不同却撞指纹」的概率再压低一档。
 *
 * 与 {@link originalTitleKey} 的区别：那个是**归一化后**的键（要容忍空白/大小写差异）；
 * 这个**一个字符都不许差** —— 它要证明的是「逐字相同」，容忍差异就直接失去意义。
 */
export function textFingerprint(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ((h >>> 0).toString(16).padStart(8, '0') as string) + '-' + text.length;
}

/**
 * 「被问到的题目**集合**」的指纹 —— **顺序无关、下标无关**，
 * 用来补 {@link textFingerprint} 缺的那一半。
 *
 * ## 为什么不能只用 `textFingerprint`
 *
 * `textFingerprint(prompt)` 是整个提示词的字节指纹，**它已经包含顺序**
 * （`renderPairs` 按 `asked` 的数组序渲）。于是它只能**二分**：一样 / 不一样。
 * 而「不一样」里混着两件完全不同的事 —— 题目**换了** vs 题目**没换、只是排法变了**。
 * 前者是数据漂移、后者是排序不稳；对「同一窗口」这句话的含义天差地别。
 * 两个指纹一起看才是**三分**：
 *
 * | `promptHash` | `askedSetHash` | 结论 |
 * |---|---|---|
 * | 相同 | （必相同） | 两次提问**逐字一样** ⇒ 答案不同只能赖通道 |
 * | 不同 | **相同** | **只是顺序变了** |
 * | 不同 | 不同 | **题目集合变了**（有题进 / 出） |
 *
 * ## 为什么按标题、不按下标
 *
 * 题目身份若拿下标（`a` / `b`）表示，**文章集合差一行就会让下标整体改号**，
 * 同一批题会被算成「不同的集合」—— 那正是本项目推翻过的机制①（见
 * {@link textFingerprint} 的注释）。所以这里：取两篇的**标题**、
 * 对内排序归一（把无序对化成一个规范形式）、再对整集合排序。
 * 结果只取决于「问了哪些题」，与下标、与提问顺序都无关。
 *
 * ## 口径
 *
 * 对内的两篇用 NUL（`\u0000`）连接，集合用换行连接。用 NUL 而非 `||` 之类：
 * 标题里可能出现任意可见字符，只有 NUL 不会出现在标题里，
 * 这样相邻两对之间不会拼出歧义（`"a b" + "c"` 与 `"a" + "b c"` 不能同串）。
 */
export function askedPairsFingerprint(pairs: Array<[string, string]>): string {
  const keys = pairs.map(([t1, t2]) => (t1 <= t2 ? `${t1}\u0000${t2}` : `${t2}\u0000${t1}`));
  keys.sort();
  return textFingerprint(keys.join('\n'));
}

// ----- 日期口径（唯一出口）-----

/**
 * 当天日期，按北京时间算，返回 `YYYY-MM-DD`。
 *
 * **不要再写 `new Date().toISOString().split('T')[0]`** —— 那是 UTC 日期，
 * 北京 00:00–08:00 会算成前一天。本项目所有「今天」的语义都是北京时间的今天：
 * 草稿标题（曾因 UTC 日期导致同一天两次推送生成同名草稿）、
 * 日报的日期区间（本来就用 `+08:00` 圈范围）、抓取的 targetDate。
 */
export function beijingDate(d: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}
