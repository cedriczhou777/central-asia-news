/**
 * 推送前的「成品化」与「相关性」规则。
 *
 * 为什么单独成模块：这里的每一条规则都是**从线上真实样本反推出来的**，
 * 注释里都带着样本出处。散在 750 行的推送路由里时，下一个人只能看到
 * 一堆正则、看不到它为什么存在，很容易在「清理代码」时删掉。
 */

import { isChineseText, MIN_HAN_TITLE, MIN_HAN_CONTENT } from './utils';

// ---------------------------------------------------------------------------
// 一、正文清洗
// ---------------------------------------------------------------------------

/**
 * 模型把提示词里的图片说明原样抄进正文时留下的抬头。
 *
 * 2026-09-20 样本（9/200 篇）：
 *   `…为农业生产者提供必要的资金支持。原文中的图片 URL 保留为 HTML：
 *    <img src='图片 URL' style='width:100%; border-radius:8px; margin:15px 0;' />`
 * 用户在 2026-09-21 反馈截图里明确圈出这段「删除该类文本，读者并不需要知道」。
 * 根因在提示词（图片规则写在了会被抄的正文要求里），那里也一并改了；
 * 这里留一道兜底，因为**库里已经存了一批带这个抬头的老数据**。
 */
const LEAKED_IMAGE_HEADER = /原文中的图片\s*URL\s*保留为\s*HTML\s*[:：]?/g;

/**
 * 判定 src 是不是「地址形状的东西」。
 *
 * 不用「必须以 https 开头」来判 —— 微信公众号素材库回给我们的正文图地址是
 * **http**（`http://mmbiz.qpic.cn/...`），只认 https 会把所有正文图误删。
 * 协议相对的 `//host/...` 也要留。所以判据是「有 scheme，或者有协议相对前缀」。
 */
function isRealImageSrc(src: string): boolean {
  return /^(?:https?:)?\/\//i.test(src.trim()) || /^data:image\//i.test(src.trim());
}

/**
 * 提示词示例里那段 style 的**逐字指纹**（单引号、无空格）。
 *
 * 这是判「这张图是不是模型自己写的」最可靠的证据，比看 URL 形状可靠得多 ——
 * 因为模型编造 URL 时会写得**很像真的**。2026-09-21 在 200 篇真实数据上实测，
 * 带这个指纹的图共 128 张，其中：
 *   - 103 张 src 直接是占位文字 `图片 URL`；
 *   - 25 张 src 是模型编出来的地址，包括
 *     `https://example.com/image.jpg`、`https://picsum.photos/seed/interpay/800/400.jpg`
 *     （随机图服务）、`https://images.unsplash.com/photo-...`（图库图），
 *     以及 `https://egemen.kz/uploads/2023/11/事故名.jpg` 这种「域名对、路径编」的。
 * 而爬虫从原文抽出来的**真图一张都没有这个指纹**（它们带 `referrerpolicy`、没有 style）。
 *
 * ⚠️ 依赖一个前提：**提示词不要授权模型自己写 style**。
 * 提示词里已经改成让模型只输出 `<img src="地址">`，样式由推送模板统一加
 * （见 push/route.ts 的 normalizeImages）。要是哪天提示词又把带 style 的示例塞回去，
 * 这条判据就会开始误删合法图片。
 */
const PROMPT_IMG_STYLE = /style\s*=\s*['"]\s*width\s*:\s*100%\s*;\s*border-radius\s*:\s*8px\s*;\s*margin\s*:\s*15px\s*0\s*;?\s*['"]/i;

/**
 * 这张 `<img>` 是不是模型自己编的（占位图 / 编造 URL）。
 *
 * 是的话必须删掉，理由有两个，都是实测出来的：
 *   1. **草稿里会出现破图**：`example.com`、`picsum.photos` 这类地址取不到图，
 *      推送时下载失败只能保留原地址，读者看到的就是一个裂开的图标；
 *   2. **可能显示一张完全无关的图**：`picsum.photos` / `unsplash` 是能返回真实图片的，
 *      一张随机风景照配在「央行加息」的新闻上比没图更糟。
 */
function isModelMadeImage(tag: string): boolean {
  const src = tag.match(/\bsrc\s*=\s*["']([^"']*)["']/i)?.[1] ?? '';
  if (!isRealImageSrc(src)) return true;
  return PROMPT_IMG_STYLE.test(tag);
}

/** 删掉模型自己编的并且可能取不到的 `<img>`；爬虫抽出来的真图一律原样保留。 */
function stripPlaceholderImages(html: string): string {
  return html.replace(/<img\b[^>]*>/gi, (tag) => (isModelMadeImage(tag) ? '' : tag));
}

/**
 * 句子在**谈论图片本身**（而不是谈论新闻）的信号词。
 *
 * 只认「图片 + URL/链接/地址/信息」这种组合，**不认光秃秃的「图片」** ——
 * 真实新闻里「事故现场的图片」「图片展」都会出现，收进来会误杀。
 * `HTML 代码` 是模型交代自己生成了什么时用的词，新闻里不会出现。
 */
const IMAGE_URL_TALK = /(?:图片|配图)\s*(?:URL|url|链接|地址|信息)|HTML\s*代码/i;

/**
 * 「源材料里没有…」这类**自我交代**用语。
 *
 * ⚠️ `无`/`没有` 必须跟「图片/配图」绑定，不能单独作为备选 ——
 * 2026-09-21 实测：单收 `无` 会让 `未完工`（火灾新闻）、`无关`（任意正文）
 * 这类词命中，把正常句子当元描述删掉。
 */
const META_LACK =
  /(?:未(?:提供|包含|附上?|给出|披露|找到|发现)|无(?:相关|具体|任何)?(?:的)?(?:图片|配图)|没有(?:相关|具体|任何)?(?:的)?(?:图片|配图)|不涉及图片|缺少图片|仅(?:提供|有|含))/;

/**
 * 这一句是不是模型在**交代自己的工作**（「原文没给图」），而不是在报新闻。
 *
 * 2026-09-21 在 200 篇真实数据上实测，命中 10 处、去重 8 种写法，全部是元描述，
 * 零误杀。样本：
 *   `目前，原文中未提供相关图片URL。`
 *   `无相关图片URL。`
 *   `原文未提供具体奖牌项目、奖牌数量或相关图片URL。`
 *   `原文中未包含图片 URL。`
 *   `目前无图片信息。`
 *   `原文未提供具体图片URL，故无相关HTML代码。`
 *   `原文仅提供标题信息，未披露…也未附图片链接。`
 *   `原文中未提供具体数字和图片URL，但该事件表明…带来积极影响。`（半句元描述 + 半句评论）
 *
 * ⚠️ 这类句子**不一定在文末**（实测 5/19 在中间）。留在末尾的还有一种更坏的作用：
 * 它会成为「末句」却不是评论句，导致 `stripTrailingCommentary` 直接 break，
 * 把**紧挨在它前面的那句评论**一起保下来。用户截图里那句
 * `该事件反映了…对投资者而言，此类事件可能影响当地社会治安环境。`
 * 就是这么漏掉的。所以这一步必须在删评论句**之前**跑。
 */
function isImageMetaSentence(sentence: string): boolean {
  const text = sentence.replace(/<[^>]*>/g, '');
  if (!IMAGE_URL_TALK.test(text)) return false;
  return META_LACK.test(text);
}

/**
 * 删掉正文里所有「自我交代型」元描述句。
 *
 * 保底：删完之后正文（去掉标签）不足 40 字就整个回退，宁可留一句废话也不能删空。
 */
function stripImageMetaSentences(text: string): string {
  const kept = splitSentences(text).filter((s) => !isImageMetaSentence(s));
  const result = kept.join('');
  if (result.replace(/<[^>]*>/g, '').trim().length < 40) return text;
  return result;
}

// ---------------------------------------------------------------------------
// 一之二、尾部噪声判据（用户需求 #4：「删去每个新闻最后的评论部分」）
//
// 这一节判据是**四轮迭代**的结果，每一轮都是被真实数据的误删/漏删逼出来的，
// 所以每一档的注释都写清了「为什么不能更宽」。改动前请先读 `stripTailNoise`。
// ---------------------------------------------------------------------------

/**
 * 元描述信号词 —— **无论出现在句子哪里**都算。
 *
 * 为什么敢放宽位置：这些话描述的是**模型自己的取材局限**，新闻正文里不可能出现。
 * 实测在 200 篇里命中 40+ 处，零误杀。
 *
 * ⚠️ `尚未`/`暂未` **不在这里**。它们是第二轮迭代从这一档挪走的：
 *   `据当地媒体报道，火灾由屋顶引发，具体原因尚未公布。`
 * 「火灾由屋顶引发」是事实，只因为后半句「尚未公布」就被整句删掉。
 * 现在它们归到 `META_NEAR_START`（位置约束）里。
 */
const META_ANYWHERE =
  /无法(?:核实|确认|提取|评估)|仍有?待|原文(?:未|没有|仅)|正文缺失|不构成对原文内容的转述|属推断|未涉及具体(?:金额|数字|数据|经济)/;

/**
 * 元描述信号词 —— **只有出现在句首 8 字以内**才算。
 *
 * 为什么必须加位置约束：这一档的词会以从句形式混进**事实句**。实测的两条误杀：
 *   `该安排覆盖已取得对方国家永久居留身份的两国公民，不适用于持商务签证、
 *    旅游签证的短期停留人员，且未提及跨境货运企业车辆资质、投资准入或税收待遇方面的配套条款。`
 *   `该建筑位于阿斯塔纳市郊，具体面积和投资规模未披露。`
 * 它们的主要信息是事实，只因为尾巴上挂了半句「未提及/未披露」就被整句删掉 ——
 * 那比留着半句废话更糟。约束之后，`具体进口规模…未详细披露。` 这类**纯元描述**
 * 仍然删得掉，上面两条事实句保住了。
 *
 * ⚠️ `具体…未…` 的间隔从 {0,16} 放宽到 {0,20}：为了收住
 * `目前，具体实施时间、投资规模、能源类型等细节尚未公布。`（间隔 17 字）。
 * 再宽就会碰到 `该建筑位于阿斯塔纳市郊，具体…`（「具体」在第 10 字，已超句首 8 字窗口）。
 */
const META_NEAR_START =
  /未[^。！？]{0,4}(?:披露|提及|说明|公布|明确|给出|提供|包含|附上|找到|发现)|(?:尚未|暂未)[^。！？]{0,8}(?:公布|披露|明确|说明|提供)|具体[^。！？]{0,20}(?:未|没有|不明|不详|缺失)|由于(?:原文|信息|细则|数据)[^。！？]{0,10}(?:未|不|有限)/;

/**
 * 直接「对投资者说话」。
 *
 * 中亚本地媒体的原文**不会**对「投资者」说话 —— 那是本项目提示词给模型设定的
 * 读者身份，所以出现这种句式就是模型自己加的：
 *   `该事件凸显了地缘政治冲突对制造业的冲击，对国际投资者而言，需关注相关行业的供应链重组风险。`
 *   `从投资者角度看，此项监管处置的直接含义是…`
 *   `这一趋势可能对关注农产品贸易的投资者产生影响，需进一步观察市场动态及政策走向。`
 *
 * ⚠️ 这一档改过三次，每次的教训都一样：**不能写成裸的 `投资者`**。
 * 只能在**话语结构**里认（`对…投资者` / `从投资者角度看` / `需…关注` / `提醒投资者`）。
 * 实测 24 条幸存句里，裸词写法会误删这些**正经事实**：
 *   `中国投资者在卡拉卡尔帕克斯坦乌鲁索伊矿发现了4吨黄金的储量。`
 *   `乌兹别克斯坦政府同期推进UzAuto汽车制造商私有化，计划引入战略投资者…`
 *   `该节日旨在推广当地葡萄种植业和文化旅游资源，吸引游客和投资者。`
 *   `…并为来自美国的投资者提供协助。`（总统讲话的转述）
 *
 * ⚠️ `为/向…投资者` **只收紧邻写法**（`为投资者提供稳定的营商环境`）。
 * 因为「为投资者提供 X」和「为来自美国的投资者提供协助」在字面上同构，
 * 唯一的区别是**中间有没有限定语**：前者是模型抽象地替读者算账（评论），
 * 后者是在转述某国总统讲话（事实）。实测 2026-09-21 的 27 条幸存句，
 * 按「紧邻」切分能把两族干净地分开，一条事实都没误伤。
 */
const INVESTOR_TALK =
  /(?:对|对于)[^。！？]{0,24}(?:投资者|投资人)|(?:为|向)(?:投资者|投资人)|从(?:投资者|投资人)(?:角度|视角)|(?:需|应|须|建议|值得|可)[^。！？]{0,4}(?:关注|注意|警惕|评估|考虑|把握|观察)|(?:关注|注意|警惕)后续|(?:提醒|告诫)(?:投资者|投资人)|(?:投资者|投资人)[^。！？]{0,8}(?:需|应|须)[^。！？]{0,4}(?:关注|注意|警惕|确保|评估|考虑|把握)|对[^。！？]{0,20}(?:企业|商界|经营者|客户)而言/;

/**
 * 评价词 —— 模型自己加的价值判断。
 *
 * 用户 2026-09-21 反馈（截图红框）：「删去每个新闻最后的评论部分」。
 * 样本：`为区域贸易和投资创造更有利的物流环境。`
 *       `该举措有助于促进农业生产…为投资者提供稳定的农业投资环境。`
 *
 * ⚠️ 刻意**不收** `旨在` / `该项目` / `这一举措` / `上述`：
 * `该工程由当地政府主导，旨在提升区域交通基础设施质量，改善居民出行条件。`
 * 这类句子源报道里就有（就是「这条新闻在讲什么」），删掉会丢掉新闻本身。
 * 同理不收 `将成为`（`该工厂建成后将成为中亚地区最大的聚乙烯生产基地` 是事实）。
 */
const EVALUATIVE =
  /有助于|不利于|有利于|有望|积极意义|重要意义|关键举措|重要举措|重要一步|迈出的|迈出了|奠定了|凸显|标志(?:着|性)|预示着|反映了|反映出|体现了|表明|提供了新的|新契机|新机遇|新渠道|创造了条件|具有(?:积极|重要|参考|重大)/;

/**
 * 展望/推测词 —— 模型替读者预判未来。**这一档最弱，要过 `hasConcreteData` 才能删。**
 *
 * ⚠️ `意味着` 刻意不收：`相关法律条款适用于金融欺诈行为，但缓刑判决意味着其仍可自由活动。`
 * 是一句**事实**（讲的是判决结果），实测被它误删。
 *
 * ⚠️ `可能…` 后面必须跟**判断性动词**，不能光收 `可能` 两个字。
 * `增强|提振|削弱` 是 2026-09-21 补的，为了收住
 * `此次胜利可能增强国际投资者对哈萨克斯坦体育事业…的信心。`
 * （这句里的 `对…投资者` 是「对…的信心」的介词短语，`INVESTOR_TALK` 认不出，
 * 得靠这里的 `可能增强`）。
 */
const OUTLOOK =
  /将(?:显著|有效|极大|进一步(?:提升|推动|改善))|预计(?:将|于)|可能(?:影响|保持|推动|带来|成为|引发|产生|吸引|改变|促进|加剧|增强|提振|削弱|为|使|导致|继续)|短期内|长期(?:看|而言)|未来(?:将|有望|可能)|可能与[^。！？]{0,24}有关|可能是由于|或与[^。！？]{0,24}有关|或受[^。！？]{0,14}影响/;

/** 「图片如下」这类悬空指代 —— 图已经被我们删了，指代就落空了。 */
const DANGLING_IMAGE_REF = /(?:图片|配图|照片)(?:如下|见图|如上|所示)|如下图|如图所示|见图\d/;

/**
 * 数字/单位 —— 出现即认为「这句在报事实」。
 *
 * 这是**整节判据里最有效的一条护栏**。第三轮迭代发现：`预计将` 在真实报道里
 * 大量用于**计划与工期**，是事实而不是评论 ——
 *   `项目预计将在招标结束后6个月内完成建设，为当地学生提供更好的学习环境。`
 *   `目前已有10家本地制药企业获得生产许可，预计将创造约3000个就业岗位。`
 * 加了这个护栏之后，含数字的句子一律不按「展望」删（只有元描述那一档例外，
 * 因为 `原文未披露 2026 年的具体金额` 这类句子里本来就带数字）。
 */
const NUMERIC_FACT =
  /[0-9０-９][^。！？]{0,8}(?:亿美元|亿|万美元|万元|万|%|％|吨|公里|千米|兆瓦|万千瓦|千瓦时|人次|辆|台|列|家|个|倍|卢布|美元|欧元|坚戈|索姆|马纳特|月|年|天|小时|分钟|人|户|座|条)|20[0-9]{2}年/;

/**
 * 具体计划动词 —— 同为护栏，但没有数字。
 *
 * 收的是「这句话在陈述某个已被确定的动作」：`将用于` / `将投入` / `将建成`……
 * 样本：`这些投资将用于建立新的工厂和扩大现有企业的产能，预计将创造数千个就业岗位。`
 * （「数千个」是中文数词，`NUMERIC_FACT` 拦不住，靠这条救回来。）
 *
 * ⚠️ 不能收 `将实施`/`将启动` 这类泛化动词 —— 模型评论里也常用
 * （`该项目的实施预计将显著提升…`），收了会把评论一起保住。
 */
const CONCRETE_PLAN = /将(?:用于|投入|建设|新建|扩建|采购|安装|购置|开工|交付|投产|建成|完成)/;

/** 这句是不是在陈述具体事实（有数字，或描述了已确定的动作）。 */
function hasConcreteData(sentence: string): boolean {
  return NUMERIC_FACT.test(sentence) || CONCRETE_PLAN.test(sentence);
}

/**
 * 这一句是不是「该删的尾巴」。返回 `'strong'`（必删）/ `'weak'`（需过护栏）/ `''`（留）。
 *
 * 分档而不是简单布尔：`OUTLOOK` 一档误伤率明显高于其它，必须单独过护栏；
 * 将来出问题也能一眼看出是哪一档干的。
 */
function classifyTailNoise(sentence: string): 'strong' | 'weak' | '' {
  const s = sentence.replace(/^[\s，,、；;：:]+/, '');

  // 元描述：无论带不带数字都要删（「未披露 2026 年金额」本身就是元描述）。
  const nearStart = s.search(META_NEAR_START);
  if (META_ANYWHERE.test(s) || (nearStart >= 0 && nearStart <= 8)) return 'strong';

  // 投资者话语 / 评价 / 悬空图：带具体事实就放过。
  if (INVESTOR_TALK.test(s) || EVALUATIVE.test(s) || DANGLING_IMAGE_REF.test(s)) {
    return hasConcreteData(s) ? '' : 'strong';
  }

  // 展望：最弱的一档，同样要过护栏。
  if (OUTLOOK.test(s)) return hasConcreteData(s) ? '' : 'weak';

  return '';
}

/** 至少有字母或数字，才算「一句有内容的话」。 */
const HAS_CONTENT = /[\p{L}\p{N}]/u;

/**
 * 按中文句末标点切句（保留分隔符）。
 *
 * ⚠️ 必须把**不含任何文字的空碎片**丢掉。这是踩过两次的同一个坑，
 * 两次的症状都一样致命 —— 末句不匹配任何评论特征 → 直接 break →
 * **整篇一句评论都删不掉，而且不报错**：
 *
 *   ① 删掉正文末尾的占位图后，文本以 `。" ` 结尾 → 末项是 `" "`（纯空白）；
 *   ② 有些文章的结构是 `…评论句。原文中的图片 URL 保留为 HTML：<img />。`
 *      → 抬头和图都删掉后变成 `…评论句。。` → 末项是 `"。"`（纯标点）。
 *
 * 2026-09-21 离线实测：修掉这两处后，200 篇里的残留评论句从 14 篇降到 4 篇；
 * 再把标点整理提到删句之前（见 sanitizeArticleContent），降到 0 篇。
 */
function splitSentences(text: string): string[] {
  return (text.match(/[^。！？]*[。！？]|[^。！？]+$/g) || []).filter((s) => HAS_CONTENT.test(s));
}

/**
 * 删掉正文尾部的噪声句。分两步，缺一不可（第四轮迭代才把两步凑齐）。
 *
 * **第一步：连续剥离** —— 从末句往前，连着删掉噪声句，最多 5 句。
 * 为什么是 5：模型加的评论经常是**一整段**（`该事件反映出…。对投资者而言…。后续需关注…。`
 * 三句连排），只删 2 句会留下半截。
 *
 * **第二步：3 句窗口** —— 在最后 3 句里，把噪声句挑出来删掉，**事实句原地保留**。
 * 为什么需要它：连续剥离遇到「噪声、事实、噪声」这种交错排列会失效 ——
 * 末句是事实 → 立刻 break → 前面那句噪声永远删不掉。实测样本：
 *   `…此举有助于提升机场的竞争力，吸引更多国际航班和旅客。（噪声）
 *    该事件未涉及具体经济数据或政策变动。（噪声）`         ← 连着，第一步能处理
 *   `这一变化可能与吉尔吉斯斯坦国内市场需求波动…有关。（噪声）
 *    数据显示，尽管出口量减少，但中国仍是吉尔吉斯斯坦的主要水果供应国之一。（事实）`
 *                                                          ← 交错，只有第二步能处理
 * 实测：第一步单独跑只能清掉 2 句，加上第二步能清 63 句，而**含数字的删除句数都是 0**。
 *
 * **窗口为什么正好是 3**：实测 W=3 时含数字的误删为 0；W=4 开始出现 3 条，
 * 例如 `招标文件未披露具体预算金额，但项目规模涉及23个新建学校，每个学校将配备
 * 现代化的教学设施。` —— 那是事实。窗口再放大的收益低于代价，就停在 3。
 *
 * 保护措施（宁可留一句多余，也不能把正文删空）：
 *   - 少于 2 句直接不动；
 *   - 删完剩下的正文不足 20 字就不删了。
 *     20 比一开始用的 40 小 —— 40 会**放过短文章的评论句**：实测
 *     `2026年8月，吉尔吉斯斯坦自中国进口电动汽车数量同比增加2.9倍。` 只有 33 字，
 *     最后那句 `这一增长表明该国电动汽车市场正在快速发展…` 因此删不掉。
 */
export function stripTailNoise(text: string, maxRounds = 5, windowSize = 3): string {
  const plainLength = (s: string) => s.replace(/<[^>]*>/g, '').trim().length;

  // 第一步：连续剥离
  let result = text;
  for (let round = 0; round < maxRounds; round++) {
    const sentences = splitSentences(result);
    if (sentences.length < 2) break;
    if (!classifyTailNoise(sentences[sentences.length - 1])) break;

    const rest = sentences.slice(0, -1).join('');
    if (plainLength(rest) < 20) break;
    result = rest;
  }

  // 第二步：在最后 windowSize 句里挑着删
  const sentences = splitSentences(result);
  if (sentences.length >= 2) {
    const splitAt = Math.max(0, sentences.length - windowSize);
    const kept = [
      ...sentences.slice(0, splitAt),
      ...sentences.slice(splitAt).filter((s) => !classifyTailNoise(s)),
    ];
    const trimmed = kept.join('');
    if (kept.length > 0 && plainLength(trimmed) >= 20) result = trimmed;
  }

  return result;
}

/** 向后兼容的别名（旧调用点仍在用这个名字）。 */
export const stripTrailingCommentary = stripTailNoise;

/**
 * 收尾标点整理：清理上面两步删掉内容后留下的孤立/重复标点。
 *
 * ⚠️ 只处理**紧挨着的**重复标点，不要顺手把标点后面的空白也吃掉 ——
 * 那会连正文里的换行一起抹掉，把整篇挤成一坨（旧写法 `[。！？\s]*` 就有这个 bug）。
 */
function tidyPunctuation(text: string): string {
  return text
    // 句末标点前面孤零零的冒号/顿号：`…保留为 HTML：。` → `…。`
    .replace(/[，,、；;：:]{1,}\s*(?=[。！？])/g, '')
    // 紧挨着的重复句末标点：`…支持。。该举措` → `…支持。该举措`
    .replace(/([。！？])[。！？]+/g, '$1')
    // 正文开头的孤立标点
    .replace(/^[\s。！？、，；：]+/, '');
}

/**
 * 推送前对一篇正文做成品化清洗。幂等，可重复调用。
 *
 * ⚠️ 调用时机：要在**图片上传替换之前**调用。否则占位图 `src='图片 URL'`
 * 会先被当成待上传的图片去下载一次（白跑一趟网络请求，虽然会被 catch 住）。
 */
export function sanitizeArticleContent(raw: string): string {
  let text = (raw || '').trim();
  if (!text) return '';

  text = text.replace(LEAKED_IMAGE_HEADER, '');
  text = stripPlaceholderImages(text);
  // 图片类元描述句（「原文未提供图片URL」）要在删评论句**之前**摘掉：
  // 它一旦落在末句，就会让 stripTrailingCommentary 的末句判据失效、直接 break。
  text = stripImageMetaSentences(text);
  // 再整理标点、最后删评论句 —— 顺序反了会漏。
  // 抬头和图被删掉后常留下 `。` 或 `。。`，先合掉它们，末句才是真正的最后一句。
  text = tidyPunctuation(text);
  text = stripTrailingCommentary(text);
  // 删句之后又可能出现孤立标点，再来一次（tidyPunctuation 幂等）
  text = tidyPunctuation(text);

  return text.trim();
}

// ---------------------------------------------------------------------------
// 二、题材过滤
// ---------------------------------------------------------------------------

/**
 * 不上推送的题材。
 *
 * 2026-09-19 用户的要求是「文体新闻少一些」（当时每国限量 3 篇），
 * 2026-09-21 改成「演艺娱乐，体育类新闻全部取消」—— 是**全删**，不是限量。
 * 所以这里用硬排除，不再有存量上限。
 *
 * 刻意**不动** translate.ts 的 CATEGORY_IDS：LLM 仍然要把文体文章识别成
 * culture/sports，这样这里才拦得住。把枚举删掉的后果是那些文章会被硬塞进
 * economy/policy 之类，反而混进推送里、还看不出来。
 *
 * 实测占比：2026-09-20 那批 200 篇里 sports 24 + culture 4 = 14%。
 */
export const EXCLUDED_CATEGORIES: ReadonlySet<string> = new Set(['culture', 'sports']);

/**
 * 源正文缺失：模型拿不到原文，只能写一篇「我拿不到原文」的说明。这种整个不要。
 *
 * 2026-09-20 样本（az 频道，3 篇）：
 *   `阿塞拜疆货币市场周度回顾：原文正文缺失，马纳特汇率与央行数据无法提取`
 *   `阿塞拜疆贵金属市场周度回顾：原始报道仅存标题，正文内容缺失`
 * 正文是一整段「按常规体例，此类周度回顾通常覆盖…但上述项目均属推断，
 * 不构成对原文内容的转述」—— 通篇没有一条信息。这类文章靠清洗救不回来
 * （没有事实可留），只能在选稿阶段丢掉。
 *
 * ⚠️ **只查标题，不查正文**。2026-09-21 实测：查正文会误伤
 *   `阿塞拜疆外交部：国家主权恢复已在南高加索形成新政治现实`
 * —— 它 285 字全是实内容，只因为中段有一句「原文仅提供标题信息」就被判成空壳。
 * 真正的空壳文**标题里就自曝了**，标题足够。
 */
const MISSING_SOURCE =
  /正文(?:内容)?缺失|原文(?:正文)?缺失|原文为空|无正文|无法提取|无法获取原文|仅存标题|仅包含标题|仅提供标题/;

/** 这篇是不是「源正文缺失」的空壳文（标题自曝）。 */
export function hasMissingSource(title: string): boolean {
  return MISSING_SOURCE.test(title || '');
}

// ---------------------------------------------------------------------------
// 三、国家相关性
// ---------------------------------------------------------------------------

/**
 * 本国关键词：国名 + 首都 + 主要城市/地区 + 国家级公司。
 *
 * ⚠️ 城市/地区名不是可选项 —— 只写国名会**误杀本国的地方新闻**。
 * 2026-09-21 离线实测踩到的真实案例：
 *   `[uz] 中国投资者在卡拉卡尔帕克斯坦发现4吨黄金储量`
 * 卡拉卡尔帕克斯坦（Karakalpakstan）是乌兹别克斯坦的一个自治共和国，
 * 标题里没出现「乌兹别克斯坦」，却出现了「中国」→ 被判成外国新闻直接丢掉。
 * 这是一条**真·乌兹别克投资新闻**，丢掉它比放进来一条外国新闻更糟。
 */
const SELF_KEYWORDS: Record<string, string[]> = {
  kz: [
    'kazakhstan', 'kazakh', '哈萨克斯坦', '哈萨克', 'astana', '阿斯塔纳', 'almaty', '阿拉木图',
    '努尔苏丹', '奇姆肯特', 'shymkent', '卡拉干达', 'karaganda', 'tengiz', '田吉兹',
    'kashagan', '卡沙甘', 'kazatomprom', 'kazmunaigas',
    '阿特劳', 'atyrau', '阿克套', 'aktau', '曼格斯套', 'mangystau',
    '阿克托别', 'aktobe', '克孜勒奥尔达', 'kyzylorda', '塔拉兹', 'taraz',
    '厄斯克门', 'oskemen', '巴甫洛达尔', 'pavlodar', '科斯塔奈', 'kostanay',
    '突厥斯坦', 'turkistan', '杰兹卡兹甘', 'jezkazgan', '巴尔喀什', 'balkhash',
  ],
  uz: [
    'uzbekistan', 'uzbek', '乌兹别克斯坦', '乌兹别克', 'tashkent', '塔什干',
    'samarkand', '撒马尔罕', 'bukhara', '布哈拉', 'navoi', '纳沃伊',
    'andijan', '安集延', 'fergana', '费尔干纳', 'namangan', '纳曼干',
    '卡拉卡尔帕克斯坦', 'karakalpakstan', '努库斯', 'nukus',
    '花拉子模', 'khorezm', '乌尔根奇', 'urgench', '铁尔梅兹', 'termez',
    '吉扎克', 'jizzakh', '苏尔汉河', 'surkhandarya', '纳沃伊州',
  ],
  kg: [
    'kyrgyzstan', 'kyrgyz', '吉尔吉斯斯坦', '吉尔吉斯', 'bishkek', '比什凯克',
    'osh', '奥什', 'jalal-abad', '贾拉拉巴德', 'issyk-kul', '伊塞克湖', 'kumtor', '库姆托尔',
    '塔拉斯', 'talas', '纳伦', 'naryn', '巴特肯', 'batken', '楚河', 'chuy', '卡拉科尔', 'karakol',
  ],
  az: [
    'azerbaijan', 'azeri', 'azerbaijani', '阿塞拜疆', 'baku', '巴库',
    'ganja', '甘贾', 'sumqayit', '苏姆盖特', 'nakhchivan', '纳希切万', 'socar',
    '连科兰', 'lankaran', '舍基', 'sheki', '明盖恰乌尔', 'mingachevir',
    '舒沙', 'shusha', '卡巴拉', 'qabala', '占贾',
  ],
  tj: [
    'tajikistan', 'tajik', '塔吉克斯坦', '塔吉克', 'dushanbe', '杜尚别',
    'khujand', '苦盏', 'khatlon', '哈特隆', 'roghun', '罗贡', 'tursunzoda',
    '库利亚布', 'kulob', '博赫塔尔', 'bokhtar', '伊斯法拉', 'isfara',
    '彭吉肯特', 'panjakent', '瓦赫达特', 'vahdat', '戈尔诺-巴达赫尚', 'gorno-badakhshan',
  ],
};

/**
 * 区域/合作框架信号：命中即放行。
 *
 * 存在的理由：有些新闻不点具体国名，但对中亚投资者是有价值的（区域走廊、
 * 欧亚经济联盟政策）。**必须在「外国」判断之前检查** ——
 * `中国—中亚天然气管道` 同时含「中国」和「中亚」，先判外国就会误杀。
 *
 * ⚠️ 刻意**不收**「欧盟」「欧洲」「南高加索」：
 * 用户 2026-09-21 反馈的正是阿塞拜疆频道里出现欧洲新闻，
 * 把「欧洲」当放行信号会把这类新闻全放进来。
 */
const RELEVANT_REGION_KEYWORDS: string[] = [
  '中亚', '中亚地区', '中亚五国', '中亚国家',
  '欧亚经济联盟', 'eaeu', 'eurasian economic union',
  '独联体', 'cis', '里海', 'caspian',
  '丝绸之路', 'silk road', '一带一路', 'belt and road',
  '中国—中亚', '中国-中亚', '中国中亚',
];

/**
 * 「讲的是别国」信号。命中即排除（除非本国或区域信号先命中）。
 *
 * 2026-09-20 实测：旧实现只列了 5 个目标国，导致 9/20 那批有 11 篇纯外国新闻
 * 全部走到「均未提及具体国家 → 放行」的兜底：
 *   蒙古 4 篇（吉尔吉斯频道）、格鲁吉亚 3 篇 / 土耳其 2 篇 / 俄罗斯 2 篇（阿塞拜疆频道）。
 * 用户原话：「与本国无任何关联」。
 *
 * 全部小写；文本比对前统一小写。**故意不收 `us`/`eu`/`uk` 这类两字母缩写** ——
 * 它们会命中 `Europe`、`reunion`、`Ukraine` 等词的内部，误杀率远高于收益。
 */
const FOREIGN_KEYWORDS: string[] = [
  // 亚洲
  '蒙古', 'mongolia', 'mongol', '乌兰巴托', 'ulaanbaatar',
  '日本', 'japan', '东京', 'tokyo',
  '韩国', 'south korea', 'korea', 'seoul', '首尔',
  '朝鲜', 'north korea', 'pyongyang',
  '越南', 'vietnam', '河内',
  '泰国', 'thailand', 'bangkok',
  '马来西亚', 'malaysia', '印度尼西亚', 'indonesia', '新加坡', 'singapore',
  '菲律宾', 'philippines', '缅甸', 'myanmar', '尼泊尔', 'nepal',
  '孟加拉', 'bangladesh', '斯里兰卡', 'sri lanka',
  '印度', 'india', 'indian', '新德里', 'new delhi',
  '巴基斯坦', 'pakistan', 'islamabad', '伊斯兰堡',
  '阿富汗', 'afghanistan', 'kabul', '喀布尔',
  '中国', 'china', 'chinese', '北京', 'beijing', '上海', 'shanghai',
  '中国香港', '中国台湾', '中国澳门',
  // 中东
  '伊朗', 'iran', 'iranian', '德黑兰', 'tehran',
  '伊拉克', 'iraq', 'baghdad', '巴格达',
  '叙利亚', 'syria', '黎巴嫩', 'lebanon', '约旦', 'jordan',
  '以色列', 'israel', '特拉维夫', '巴勒斯坦', 'palestine', '加沙', 'gaza',
  '沙特', 'saudi', '利雅得', 'riyadh',
  '阿联酋', 'uae', 'emirates', '迪拜', 'dubai', '阿布扎比', 'abu dhabi',
  '卡塔尔', 'qatar', 'doha', '多哈', '科威特', 'kuwait', '阿曼', 'oman', '巴林', 'bahrain',
  '也门', 'yemen', '埃及', 'egypt', 'cairo', '开罗',
  // 欧洲
  '欧洲', 'europe', 'european', '欧盟', 'european union', 'eurozone', '欧元区', '布鲁塞尔',
  '德国', 'germany', 'german', '柏林', 'berlin', '慕尼黑', '法兰克福',
  '法国', 'france', 'french', '巴黎', 'paris',
  '英国', 'britain', 'british', 'england', 'london', '伦敦',
  '意大利', 'italy', 'italian', '罗马', 'rome',
  '西班牙', 'spain', 'spanish', '马德里', 'madrid', '葡萄牙', 'portugal', 'lisbon',
  '荷兰', 'netherlands', 'dutch', 'amsterdam', '阿姆斯特丹',
  '比利时', 'belgium', '卢森堡', 'luxembourg',
  '瑞士', 'switzerland', 'geneva', '日内瓦', 'zurich',
  '奥地利', 'austria', '维也纳', 'vienna',
  '瑞典', 'sweden', 'stockholm', '挪威', 'norway', 'oslo',
  '芬兰', 'finland', 'helsinki', '丹麦', 'denmark', 'copenhagen',
  '冰岛', 'iceland', '爱尔兰', 'ireland', 'dublin',
  '波兰', 'poland', 'warsaw', '华沙',
  '捷克', 'czech', 'prague', '布拉格', '斯洛伐克', 'slovakia',
  '匈牙利', 'hungary', 'budapest', '布达佩斯',
  '罗马尼亚', 'romania', 'bucharest', '布加勒斯特',
  '保加利亚', 'bulgaria', 'sofia', '希腊', 'greece', 'athens', '雅典',
  '塞尔维亚', 'serbia', 'belgrade', '贝尔格莱德',
  '克罗地亚', 'croatia', '斯洛文尼亚', 'slovenia',
  '波黑', 'bosnia', '黑山', 'montenegro', '北马其顿', 'macedonia', 'albania', '阿尔巴尼亚',
  '摩尔多瓦', 'moldova',
  '爱沙尼亚', 'estonia', '拉脱维亚', 'latvia', '立陶宛', 'lithuania',
  '格鲁吉亚', 'georgia', 'georgian', '第比利斯', 'tbilisi', '巴统', 'batumi',
  '亚美尼亚', 'armenia', 'armenian', '埃里温', 'yerevan',
  '俄罗斯', 'russia', 'russian', '莫斯科', 'moscow', '西伯利亚', 'siberia',
  '白俄罗斯', 'belarus', 'minsk', '明斯克',
  '乌克兰', 'ukraine', 'ukrainian', '基辅', 'kyiv', 'kiev', '敖德萨', 'odesa',
  // 美洲
  '美国', 'united states', 'america', 'american', '华盛顿', 'washington',
  '纽约', 'new york', '白宫', '特朗普', 'trump', '拜登', 'biden',
  '加拿大', 'canada', 'ottawa', '墨西哥', 'mexico',
  '巴西', 'brazil', '阿根廷', 'argentina', '智利', 'chile', '秘鲁', 'peru',
  '哥伦比亚', 'colombia', '委内瑞拉', 'venezuela', '古巴', 'cuba',
  // 非洲 / 大洋洲
  '南非', 'south africa', '尼日利亚', 'nigeria', '肯尼亚', 'kenya',
  '埃塞俄比亚', 'ethiopia', '摩洛哥', 'morocco', '阿尔及利亚', 'algeria',
  '突尼斯', 'tunisia', '利比亚', 'libya', '苏丹', 'sudan', '索马里', 'somalia',
  '坦桑尼亚', 'tanzania', '加纳', 'ghana',
  '澳大利亚', 'australia', '悉尼', 'sydney', '新西兰', 'new zealand',
];

/**
 * 把**另外四个目标国**的关键词也算作「别国」。
 *
 * 这是 2026-09-21 截图复核时抓出来的漏网：吉尔吉斯频道头条是
 * `哈萨克斯坦8月通胀率达12.5%，主要受燃料价格飙升推动`，乌兹别克频道里有
 * `哈萨克斯坦推进公共卫生系统现代化`。实测 200 篇里有 16 篇是这种「入库国别 ≠
 * 标题所指国别」（kg→kz 9 篇、uz→kz 4 篇等）。
 *
 * 为什么会漏：`FOREIGN_KEYWORDS` 只列了**非目标国**。一篇讲哈萨克斯坦的新闻
 * 落在吉尔吉斯频道里时，既不在吉尔吉斯的本国词表里，也不在任何「外国」词表里，
 * 于是命中第 4 条兜底「什么国家都没提到 → 放行」。
 *
 * 只在**本国词表都没命中之后**才查这里，所以不会误杀
 * `哈萨克斯坦与土耳其签署协议` 这种「本国 + 别国」的正常新闻。
 */
function otherCountryKeywords(countryCode: string): string[] {
  return Object.entries(SELF_KEYWORDS)
    .filter(([code]) => code !== countryCode)
    .flatMap(([, keywords]) => keywords);
}

/**
 * 判断一篇新闻是否真的与目标国家相关。
 *
 * 判定顺序（顺序本身就是规则，不要重排）：
 *   1. 命中**本国** → 相关（哪怕同时提到别国：`哈萨克斯坦与土耳其签署协议` 必须留）；
 *   2. 命中**区域/合作框架** → 相关（`中国—中亚天然气管道`）；
 *   3. 命中**任何别国**（含另外四个目标国）→ 不相关；
 *   4. 什么国家都没提到 → 放行（按入库国别归属；这类多是该国行业/企业新闻）。
 */
export function isCountryRelevant(title: string, summary: string, countryCode: string): boolean {
  const text = `${title} ${summary}`.toLowerCase();

  const self = SELF_KEYWORDS[countryCode] || [];
  if (self.some((kw) => text.includes(kw.toLowerCase()))) return true;

  if (RELEVANT_REGION_KEYWORDS.some((kw) => text.includes(kw.toLowerCase()))) return true;

  if (otherCountryKeywords(countryCode).some((kw) => text.includes(kw.toLowerCase()))) return false;

  if (FOREIGN_KEYWORDS.some((kw) => text.includes(kw.toLowerCase()))) return false;

  return true;
}

// ---------------------------------------------------------------------------
// 三之二、选稿资格：这三条判据必须**只有一份实现**
// ---------------------------------------------------------------------------

/** 一篇稿子被挡在推送之外的原因。`null` = 合格。 */
export type PushExclusion = 'untranslated' | 'category' | 'missing_source' | 'country';

/**
 * 这篇稿子的**文本**有没有资格被推送：标题和正文都必须是中文。
 *
 * 存在的意义是「一处定义、多处调用」—— 这个判据原先只内联写在 `push` 路由里，
 * 于是体检接口没有它，把**永远进不了生产**的文章喂给了模型（详见下方
 * `pushExclusionReason` 注释里的第三次事故）。
 *
 * ⚠️ 调用方请用本函数，**不要再写 `isChineseText(a.title) && isChineseText(a.content)`**
 * —— 这个表达式曾经在两处各写一份，就是分叉的起点。
 *
 * ⚠️ 2026-09-23：两个参数**必须**分别传标题/正文的最小汉字个数。
 * 专有名词改成一律保留拉丁之后，标题的汉字**占比**掉到 0.27–0.36，
 * 而正文的绝对汉字数仍有上百 —— 用同一个阈值会让标题这一侧先崩，
 * 表现是「稿子入库了却永远推不出去」。见 `utils.ts` 的 `isChineseText`。
 */
export function isPushableText(title: string | null | undefined, content: string | null | undefined): boolean {
  return isChineseText(title || '', MIN_HAN_TITLE) && isChineseText(content || '', MIN_HAN_CONTENT);
}

/**
 * 这篇稿子有没有资格进「今日精选」？返回 `null` 表示合格。
 *
 * ## 为什么要抽成一个函数（这是一次真实的误判）
 *
 * 这几条判据原本是**内联写在 `POST /api/wechat/push` 里的**，
 * 于是任何「想按生产口径跑一遍」的地方（诊断接口、体检脚本）都得**照着抄一遍**。
 * 抄漏一条，结论就完全反过来 —— 2026-09-22 实测踩到：
 *
 *   `GET /api/dedupe-check?llm=1` 用来验证 L2 模型判重稳不稳，
 *   但它的输入直接来自 `getArticleIdentities()`，**没有套这三条判据**。
 *   结果 kz 那 12 个候选对**全是体育新闻**（亚洲运动会乒乓球/自行车/举重），
 *   而体育类在 `push` 里会被 `EXCLUDED_CATEGORIES` **整类剔掉、永远进不了生产**。
 *   三次调用判出 4 / 6 / 2 对「同一件事」，于是被读成「L2 判定不稳定」——
 *   实际上测的是模型对**模板化体育标题**（「…在亚洲运动会中夺冠」vs「…夺得铜牌」）
 *   的判断，与生产无关。
 *
 *   这个坑和投资相关性评分那次是同一形态：**同一个判据在两处各写一份，
 *   一边对一边错**，而且不报错、只在结论里悄悄体现。所以判据必须共享。
 *
 * ## 第三次：漏掉「未翻译」这条（2026-09-22 当天又踩到）
 *
 * 把上面三条补齐之后，体检**仍然**与 `push` 不一致 —— 因为 `push` 在套这三条
 * 判据**之前**还有一道 `isChineseText` 过滤（挡掉翻译失败、以原文入库的历史行）。
 * 实测 14 天窗口 29 个候选对里 **9 个（31%）的标题是俄文/哈萨克文/英文**，
 * 这些对在生产里根本不会存在，却都进了模型判定。更糟的是非中文对**更容易误判**：
 * 一对共享「35 сол / Истиқлол」（35 周年/独立）的**无关**文章被 13/14 次判成
 * 「同一件事」（一个是新西伯利亚的庆祝活动、一个是「35 年拍了 300 部电影」）。
 *
 * 教训：**「补齐了」是错觉，要把判据链当成一个整体去核对**。
 * 所以本函数现在把 `untranslated` 也收进来，成为唯一的资格判据；
 * `push` 路由也改为调用它，不再自己写过滤表达式。
 *
 * ⚠️ 调用方**不要**再自己写过滤条件，也不要把这里的顺序换掉 ——
 * 顺序决定了「同一篇同时命中多条时报哪个原因」，日志里靠这个原因定位问题。
 * `untranslated` 排在最前，与 `push` 原先「先滤非中文、再套三条判据」的实际顺序一致。
 */
export function pushExclusionReason(
  article: {
    title: string;
    /**
     * **必填**（可为 null）。刻意不给默认值：漏传会让「未翻译」这条判据静默失效，
     * 而那正是第三次事故的形态 —— 让类型系统替我们挡住。
     */
    content: string | null;
    summary?: string | null;
    category?: string | null;
  },
  countryCode: string,
): PushExclusion | null {
  if (!isPushableText(article.title, article.content)) return 'untranslated';
  if (article.category && EXCLUDED_CATEGORIES.has(article.category)) return 'category';
  if (hasMissingSource(article.title || '')) return 'missing_source';
  if (!isCountryRelevant(article.title || '', article.summary || '', countryCode)) return 'country';
  return null;
}
