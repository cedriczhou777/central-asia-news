/**
 * 微信公众号草稿的排版模板。
 *
 * 为什么从 push/route.ts 里抽出来单独成文件：
 *   1. 它是这个项目**改得最频繁**的一块（用户看的就是它），原来埋在一个 750 行的
 *      路由文件里，改一次要滚半天；
 *   2. 抽出来之后没有 Next 依赖，可以用 `tsc` 单独编译、拿真实文章渲染出 HTML
 *      直接就看了，不用起服务、不用部署。
 *
 * ⚠️ **这个文件里只能写「公众号编辑器不会改写」的 CSS。**
 * 踩过的坑（2026-09-21 用户反馈「电脑端打开后再用手机端打开排版就变了」）：
 * 草稿一旦在公众号编辑器里被打开、保存，编辑器会剥掉一批它不支持的属性，
 * 剥掉之后版式就塌了。已知会被剥掉、**禁止使用**的：
 *   - `display: flex` / `grid` → 横向布局塌成竖排（原来标题行就是这么塌的）
 *   - `linear-gradient` → 头部深色底被抹平成透明白底，白字直接看不见
 *   - `box-shadow`、`position`、`transform`、CSS 变量、`rgba()` 颜色
 * 可以安全使用的：
 *   - 布局：`inline-block`、普通块级
 *   - 颜色：纯 `#RRGGBB`
 *   - 其余：`margin` / `padding` / `border` / `border-radius` /
 *     `font-size` / `font-weight` / `line-height` / `color` / `text-align` / `vertical-align`
 */

/**
 * 清理正文末尾的省略号：以省略号/多个省略符收尾时替换为句号，确保以完整语句收尾
 */
export function cleanSummary(text: string): string {
  let t = (text || '').trim();
  // 剥离末尾的省略号（全角/半角），若其后无其它文字则补一个句号
  if (/(?:…|\.\.\.|\.\.)+[\s，,、；;：:]?$/.test(t)) {
    t = t.replace(/(?:…|\.\.\.|\.\.)+[\s，,、；;：:]*$/g, '。');
  }
  // 去除结尾的多余标点，保留句号/感叹号/问号收尾
  t = t.replace(/([，,、；;：:（\s])+$/g, '');
  return t.trim();
}

/**
 * 把正文里的 `<img>` 统一成一种写法。
 *
 * 为什么要统一：模型写出来的图五花八门（单引号、带各种 style、属性顺序乱），
 * 样式散在正文里就没法保证手机上的一致性。这里只保留 `src` 和必要的
 * `referrerpolicy`，样式由模板统一给。
 */
export function normalizeImages(html: string): string {
  return html.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = tag.match(/\bsrc\s*=\s*["']([^"']*)["']/i)?.[1] ?? '';
    if (!src) return '';
    // 源站的图有防盗链，referrerpolicy 是必要的；已换成微信 CDN 的图带上它也无害。
    const referrerPolicy = /referrerpolicy\s*=/i.test(tag) ? ' referrerpolicy="no-referrer"' : '';
    return `<img src="${src}"${referrerPolicy} style="width:100%;border-radius:8px;margin:15px 0;" />`;
  });
}

/** 分类 id → 中文标签。LLM 判定的分类见 translate.ts 的 CATEGORY_IDS。 */
const CATEGORY_LABELS: Record<string, string> = {
  politics: '政治',
  economy: '经济',
  policy: '政策',
  law: '法律',
  society: '社会',
  culture: '人文',
  sports: '体育',
  healthcare: '医疗卫生',
  energy: '能源',
  oil_gas: '油气',
  renewable_energy: '新能源',
  chemicals: '化工',
  minerals: '矿产',
  infrastructure: '基建',
  housing: '房地产',
  manufacturing: '制造业',
  livelihood: '民生',
  security: '治安',
  transport: '交通',
};

export interface WechatArticle {
  title: string;
  summary: string;
  content: string;
  category: string;
  source_name: string;
  cover_image?: string;
}

/**
 * 金色圆点（标题上方的装饰条）。
 *
 * 用户 2026-09-21 要求「数字取消，仅仅保留金色背景圆，大小改为现在的 1/2」——
 * 旧版是 32px 的 `display:flex` 方块里写编号，现在是 16px、无内容。
 * 用 `inline-block` + `&nbsp;`（而不是空标签）是有意的：空 inline 元素在部分编辑器里
 * 会被折叠成 0 尺寸，圆点直接消失。
 */
const GOLD_DOT =
  '<span style="display:inline-block;width:16px;height:16px;line-height:16px;font-size:0;'
  + 'border-radius:50%;background-color:#C8A45C;vertical-align:middle;margin-right:8px;'
  + 'overflow:hidden;">&nbsp;</span>';

/** 生成微信公众号排版 HTML（一国一篇草稿的正文）。 */
export function generateWechatHtml(
  countryName: string,
  countryFlag: string,
  date: string,
  articles: WechatArticle[],
): string {
  const articlesHtml = articles.map((article) => {
    const categoryLabel = CATEGORY_LABELS[article.category] || article.category;
    const imgSrc = article.cover_image || '';

    // 图片统一规范化；`[IMAGE:url]` 是更早版本的占位写法，保留兼容。
    const contentHtml = normalizeImages(
      article.content.replace(
        /\[IMAGE:([^\]]+)\]/g,
        '<img src="$1" style="width:100%;border-radius:8px;margin:15px 0;" />',
      ),
    );
    // 去掉正文末尾的省略号，确保以完整语句收尾
    const bodyHtml = cleanSummary(contentHtml);

    // 若正文已经自带 `<img>` 首图，就不再重复输出独立封面，避免同一张图出现两次
    const bodyHasImg = /<img[^>]*\ssrc=/i.test(contentHtml);
    const coverBlock = (!bodyHasImg && imgSrc)
      ? `<section style="margin:15px 0;"><img src="${imgSrc}" style="width:100%;border-radius:8px;" /></section>`
      : '';

    // 编号已去掉：渲染时不再需要 index，圆点不承担计数功能。
    return `
      <section style="margin-bottom:32px;padding-bottom:24px;border-bottom:1px solid #E8E8E8;">
        <p style="margin:0 0 6px 0;font-size:12px;line-height:1.6;color:#C8A45C;">${GOLD_DOT}${categoryLabel}</p>
        <p style="margin:0 0 14px 0;font-size:18px;line-height:1.5;color:#0F1B2D;font-weight:bold;">${article.title}</p>
        ${coverBlock}
        <section style="font-size:16px;line-height:2;color:#333333;">${bodyHtml}</section>
        <p style="margin:14px 0 0 0;padding-top:10px;border-top:1px dashed #E8E8E8;font-size:12px;line-height:1.6;color:#999999;">来源：${article.source_name}</p>
      </section>
    `;
  }).join('');

  // 头部底色由渐变改成纯色 `#0F1B2D`（原色）。渐变会被编辑器抹平，
  // 抹平后白字落在白底上，整块标题直接看不见。
  // 副标题那行原先是 `rgba(255,255,255,0.7)`，同样会失效 → 换成实色 #B9C2CE。
  return `
    <section style="padding:8px;background-color:#F8F6F1;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif;">
      <section style="text-align:center;padding:24px 16px;background-color:#0F1B2D;border-radius:10px;margin-bottom:20px;">
        <p style="margin:0 0 10px 0;font-size:40px;line-height:1.2;">${countryFlag}</p>
        <p style="margin:0 0 6px 0;font-size:26px;line-height:1.4;color:#C8A45C;font-weight:bold;">${countryName}</p>
        <p style="margin:0 0 12px 0;font-size:20px;line-height:1.4;color:#FFFFFF;">今日精选投资资讯</p>
        <p style="margin:0;font-size:14px;line-height:1.6;color:#B9C2CE;">${date}</p>
      </section>

      <section style="background-color:#FFFFFF;border-radius:10px;padding:18px 16px;">
        ${articlesHtml}
      </section>

      <section style="text-align:center;margin-top:20px;padding:16px;font-size:12px;line-height:1.8;color:#999999;">
        <p style="margin:0 0 6px 0;">中亚投资资讯 | Central Asia Investment Daily</p>
        <p style="margin:0;">数据来源：各国主流媒体</p>
      </section>
    </section>
  `;
}
