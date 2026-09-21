import { NextRequest, NextResponse } from 'next/server';
import { getArticles } from '@/lib/db-articles';
import {
  EXCLUDED_CATEGORIES,
  hasMissingSource,
  isCountryRelevant,
  sanitizeArticleContent,
} from '@/lib/article-format';
import { generateWechatHtml } from '@/lib/wechat-template';

/**
 * 推送前成品化的**行为自检**接口（零副作用，只读）。
 *
 * 为什么需要它：这套规则全是「删除类」逻辑，删多了、删少了都不会报错，
 * 只会在草稿里以「怎么还有评论」/「这句话怎么没了」的形式暴露出来。
 * 而线上容器里没有 git 元数据，光看部署状态没法确认跑的是哪版代码。
 * 所以这里让**行为本身**当版本指纹：固定语料跑一遍，
 * 该留的必须留、该删的必须删，对不上就说明跑的不是预期版本。
 *
 * 同时把最新一批真实文章过一遍流水线，报出会删多少、会丢多少，
 * 方便在真的推送之前先看一眼。
 *
 * GET /api/format-check            → 检查今天
 * GET /api/format-check?date=2026-09-20
 */

/** 必须原样保留的事实句（含数字的预算/工期、政策原文、企业动作等）。 */
const MUST_KEEP = [
  '项目预计将在招标结束后6个月内完成建设，为当地学生提供更好的学习环境。',
  '目前已有10家本地制药企业获得生产许可，预计将创造约3000个就业岗位。',
  '该节日旨在推广当地葡萄种植业和文化旅游资源，吸引游客和投资者。',
  '中国投资者在卡拉卡尔帕克斯坦乌鲁索伊矿发现了4吨黄金的储量。',
  '计划引入战略投资者，以提高生产效率和出口竞争力。',
  '吉尔吉斯斯坦总统在访问美国期间表示，并为来自美国的投资者提供协助。',
  '政府表示，该项目将优先吸引欧洲和亚洲投资者的资金，并已出台税收优惠政策。',
  'AIFC仲裁中心将依据《阿斯塔纳国际条约》运作，该条约允许外国投资者选择适用其本国法律。',
  '相关法律条款适用于金融欺诈行为，但缓刑判决意味着其仍可自由活动。',
  '该建筑位于阿斯塔纳市郊，具体面积和投资规模未披露。',
  '据当地媒体报道，火灾由屋顶引发，具体原因尚未公布。',
  '这些投资将用于建立新的工厂和扩大现有企业的产能，预计将创造数千个就业岗位。',
  '该工厂建成后将成为中亚地区最大的聚乙烯生产基地。',
  '政府计划在2025年底前实现微生态制剂在所有公立医院的普及率100%。',
];

/** 必须被删掉的模型评论/元描述句。 */
const MUST_DROP = [
  '这些改革措施不仅提升了医疗服务效率，也为投资者提供了更可靠的营商环境保障。',
  '塔吉克斯坦政府持续推动教育基础设施建设，为投资者提供稳定的营商环境。',
  '干果产业的高附加值和稳定的国际市场需求，为投资者提供良好回报前景。',
  '此举有助于提升机场的竞争力，吸引更多国际航班和旅客。',
  '该事件对投资者的影响主要体现在社会治安和营商环境方面。',
  '这一趋势可能对关注农产品贸易的投资者产生影响，需进一步观察市场动态及政策走向。',
  '从投资者角度看，各银行此前多按自身标准与不同来源清单执行制裁筛查。',
  '此次胜利可能增强国际投资者对哈萨克斯坦体育事业和国家整体发展潜力的信心。',
  '该事件提醒投资者在申请跨境金融牌照时需确保业务实质与注册地一致。',
  '对投资者而言，该信息表明地方政府电力运行成本已获得明确财政安排。',
  '具体进口规模和涉及的品牌型号未详细披露。',
  '火灾现场图片如下。',
  '该事件未涉及具体经济数据或政策变动。',
  '目前，具体实施时间、投资规模、能源类型等细节尚未公布。',
  '该项目的实施预计将显著提升犹他州迪尔峰滑雪度假村的旅游接待能力。',
];

const HEAD =
  '哈萨克斯坦国家统计局发布数据显示，该国工业产值同比增长明显，其中制造业贡献最大，'
  + '采矿业小幅回落，整体经济运行保持平稳态势，加工工业与电力供应均实现正增长，为全年目标打下基础。';

/** 公众号编辑器会剥掉、因而**禁止出现**的 CSS。 */
const FORBIDDEN_CSS: Array<[string, RegExp]> = [
  ['display:flex', /display\s*:\s*flex/i],
  ['linear-gradient', /linear-gradient/i],
  ['box-shadow', /box-shadow/i],
  ['rgba()', /rgba\(/i],
  ['CSS 变量 var(--x)', /var\(--/],
  ['transform', /transform\s*:/i],
  ['position:absolute', /position\s*:\s*absolute/i],
];

const COUNTRY_NAMES: Record<string, string> = {
  kz: '哈萨克斯坦', uz: '乌兹别克斯坦', kg: '吉尔吉斯斯坦', az: '阿塞拜疆', tj: '塔吉克斯坦',
};

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const date = searchParams.get('date') || new Date().toISOString().slice(0, 10);

  // ---- 1. 行为自检：规则指纹 ----
  const keepFailures: string[] = [];
  for (const s of MUST_KEEP) {
    if (!sanitizeArticleContent(HEAD + s).includes(s.slice(0, 12))) keepFailures.push(s);
  }
  const dropFailures: string[] = [];
  for (const s of MUST_DROP) {
    if (sanitizeArticleContent(HEAD + s).includes(s.slice(0, 12))) dropFailures.push(s);
  }

  // ---- 2. 模板 CSS 安全 ----
  const sampleHtml = generateWechatHtml('哈萨克斯坦', '🇰🇿', date, [{
    title: '自检样本标题',
    summary: '',
    content: sanitizeArticleContent(HEAD + MUST_DROP[3]),
    category: 'economy',
    source_name: '自检',
  }]);
  const cssViolations = FORBIDDEN_CSS.filter(([, re]) => re.test(sampleHtml)).map(([n]) => n);
  const hasGoldDot = /background-color:#C8A45C/.test(sampleHtml);
  const sampleHasNumberedList = /<p[^>]*>\s*[1-9]\d?\s*[.、]\s/.test(sampleHtml);
  const sampleHasCommentary = /有助于提升机场的竞争力|为投资者提供了/.test(sampleHtml);

  // ---- 3. 真实数据流水线预演 ----
  let raw = 0;
  const perCountry: Array<Record<string, number | string>> = [];
  let noiseSentences = 0;
  let concreteDataDeletions = 0;
  let brokenImages = 0;
  let imageUrlTalk = 0;
  let emptied = 0;

  try {
    const articles = await getArticles({ date });
    raw = articles.length;

    const splitSentences = (t: string) =>
      (t.match(/[^。！？]*[。！？]|[^。！？]+$/g) || []).filter((s) => /[\p{L}\p{N}]/u.test(s));
    const same = (a: string, b: string) =>
      a.replace(/<[^>]*>/g, '').replace(/[\s，,、；;：:。！？]/g, '')
      === b.replace(/<[^>]*>/g, '').replace(/[\s，,、；;：:。！？]/g, '');

    for (const a of articles) {
      const cleaned = sanitizeArticleContent(a.content || '');
      if (!cleaned.trim()) { emptied++; continue; }

      if (/图片\s*(?:URL|链接|信息)/i.test(cleaned)) imageUrlTalk++;
      brokenImages += (cleaned.match(/<img[^>]*>/gi) || []).filter((t) => {
        const m = t.match(/src=["']([^"']*)["']/i);
        return !m || !/^(?:https?:)?\/\//i.test(m[1]);
      }).length;

      const kept = splitSentences(cleaned);
      for (const s of splitSentences((a.content || '').replace(/<[^>]*>/g, ''))) {
        if (s.replace(/<[^>]*>/g, '').trim().length < 8) continue;
        if (!kept.some((k) => same(k, s))) {
          noiseSentences++;
          if (/[0-9０-９]/.test(s.replace(/<[^>]*>/g, ''))) concreteDataDeletions++;
        }
      }
    }

    for (const code of Object.keys(COUNTRY_NAMES)) {
      const list = articles.filter((a) => a.country_code === code);
      if (!list.length) continue;
      let byCategory = 0, byMissingSource = 0, byCountry = 0, kept = 0;
      for (const a of list) {
        if (EXCLUDED_CATEGORIES.has(a.category)) { byCategory++; continue; }
        if (hasMissingSource(a.title)) { byMissingSource++; continue; }
        if (!isCountryRelevant(a.title, a.summary, code)) { byCountry++; continue; }
        kept++;
      }
      perCountry.push({
        code, name: COUNTRY_NAMES[code], raw: list.length, kept,
        droppedCategory: byCategory, droppedMissingSource: byMissingSource, droppedCountry: byCountry,
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误';
    return NextResponse.json({ ok: false, error: `读取文章失败：${message}` }, { status: 500 });
  }

  const ok = keepFailures.length === 0
    && dropFailures.length === 0
    && cssViolations.length === 0
    && hasGoldDot
    && !sampleHasNumberedList
    && !sampleHasCommentary
    && brokenImages === 0
    && imageUrlTalk === 0
    && emptied === 0
    && concreteDataDeletions === 0;

  const notes: string[] = [];
  if (keepFailures.length) notes.push(`规则误删了 ${keepFailures.length} 条事实句（应为 0）`);
  if (dropFailures.length) notes.push(`规则漏删了 ${dropFailures.length} 条噪声句（应为 0）`);
  if (cssViolations.length) notes.push(`模板含编辑器会剥掉的 CSS：${cssViolations.join('、')}`);
  if (!hasGoldDot) notes.push('模板里找不到金色圆点');
  if (sampleHasNumberedList) notes.push('模板里出现序号列表');
  if (sampleHasCommentary) notes.push('模板里出现评论句');
  if (brokenImages) notes.push(`成品里有 ${brokenImages} 张取不到的图`);
  if (imageUrlTalk) notes.push(`成品里有 ${imageUrlTalk} 处「图片URL」字样`);
  if (emptied) notes.push(`${emptied} 篇文章被清空`);
  if (concreteDataDeletions) notes.push(`误删了 ${concreteDataDeletions} 条含数字的事实句（应为 0）`);
  if (!raw) notes.push(`${date} 没有文章数据，流水线预演部分为空`);

  return NextResponse.json(
    {
      ok,
      checkedAt: new Date().toISOString(),
      date,
      verdict: ok
        ? `成品化规则自检通过；${date} 共 ${raw} 篇，预演删除噪声句 ${noiseSentences} 条，无事实数据丢失。`
        : `自检未通过：${notes.join('；')}`,
      rules: {
        keepFailures: keepFailures.length, dropFailures: dropFailures.length,
        keepFixtures: MUST_KEEP.length, dropFixtures: MUST_DROP.length,
      },
      template: { cssViolations, hasGoldDot, sampleHasNumberedList, sampleHasCommentary },
      pipeline: {
        date, raw, noiseSentences, concreteDataDeletions,
        brokenImages, imageUrlTalk, emptied, perCountry,
      },
      notes: notes.length ? notes : undefined,
    },
    { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } },
  );
}
