/**
 * `cleanDraftText`（草稿文字清洗）的回归（2026-10-30）。
 *
 * ## 为什么先有测试再接生产
 *
 * 这个函数**直接改写用户的成品** ⇒ ⇒ 一旦判据写歪，用户在草稿箱里看到的就是
 * 「正文被吃掉一半」「图没了」⇒ ⇒ **每一条判据都要有断言钉住**。
 *
 * ## 背景：两个「用户眼里的重复」
 *
 * ① **正文里同一句出现两次**（线上 469 篇里 7 篇 / 11 句）
 * ② **正文首句把标题整句抄了一遍**（线上 469 篇里 6 篇）
 *
 * ⚠️ 第一版按「空行切段」写，**实测抓不到** —— 线上正文是「一段到底」的 HTML
 * （`<img/>` + `\n\n` + 一整段，**没有 `<p>`**）⇒ ⇒ 段级判据必然漏 ⇒ 改成**句级**。
 *
 * ## 测什么
 *
 * ① 标题体裁后缀：剥得掉、不误伤正文里的「摄影」二字
 * ② 重复句：**只删第二次**（第一次是导语，必须留）
 * ③ 标题回声：删掉；**首图必须还在**
 * ④ 护栏：正文只有一句（= 标题）⇒ **不许删**（删了正文就空了）
 * ⑤ 幂等：洗两次结果必须一致
 * ⑥ 不误伤：话题相近但**事件不同**的两句，不能被当回声删掉
 * ⑦ 短句（< 10 字）重复不删（「据悉。」这类不是重复）
 *
 * 全部离线、零成本、不联网。
 */
import { cleanDraftText, sentenceKey, stripSourceSuffix } from '../src/lib/utils';

let passed = 0;
const failures: string[] = [];
function section(name: string): void {
  console.log(`\n${'-'.repeat(60)}\n${name}\n${'-'.repeat(60)}`);
}
function ok(desc: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${desc}`);
  } else {
    failures.push(`${desc}${detail ? `　→ ${detail}` : ''}`);
    console.log(`  ✗ ${desc}${detail ? `　→ ${detail}` : ''}`);
  }
}

const IMG = '<img src="https://example.com/a.jpg" referrerpolicy="no-referrer" />';

section('一、标题体裁后缀');
{
  ok(
    '剥掉「- 摄影作品」',
    stripSourceSuffix('阿塞拜疆"AzerGold"公司参加第20届国际"MiningMetals"矿业金属展 - 摄影作品')
      === '阿塞拜疆"AzerGold"公司参加第20届国际"MiningMetals"矿业金属展',
    stripSourceSuffix('阿塞拜疆"AzerGold"公司参加第20届国际"MiningMetals"矿业金属展 - 摄影作品'),
  );
  ok('剥掉「- фото」', stripSourceSuffix('Узбекистан открыл завод - фото') === 'Узбекистан открыл завод');
  ok('剥掉「- Фото」', stripSourceSuffix('Узбекистан открыл завод - Фото') === 'Узбекистан открыл завод');
  ok('剥掉「- 现场图片」', stripSourceSuffix('某地暴雨 - 现场图片') === '某地暴雨');
  ok('剥掉「- видео」', stripSourceSuffix('某地暴雨 - видео') === '某地暴雨');
  ok('剥掉「— 图片」（长破折号）', stripSourceSuffix('某地暴雨 — 图片') === '某地暴雨');
  ok(
    '★ 不误伤正文里出现的「摄影」',
    stripSourceSuffix('摄影爱好者在阿拉木图举办影展') === '摄影爱好者在阿拉木图举办影展',
  );
  ok('无后缀 ⇒ 原样', stripSourceSuffix('普通标题') === '普通标题');
  ok('空串 ⇒ 空串', stripSourceSuffix('') === '');
}

section('二、正文里的重复句');
{
  const title = '巴库纳希切万街口发生货车事故，交通受阻';
  const body = '巴库纳希切万街口发生一起货车事故，导致交通受阻。巴库纳希切万街口发生一起货车事故，导致交通受阻。';
  const r = cleanDraftText(title, body);
  ok('★ 删掉第二次出现', r.duplicateRemoved === 1, `实际 ${r.duplicateRemoved}`);
  ok(
    '★ 第一次保留（一句都不剩就是删错了）',
    r.content === '巴库纳希切万街口发生一起货车事故，导致交通受阻。',
    JSON.stringify(r.content),
  );
  // body 本身已是 2 句相同 ⇒ body+body = 4 句相同 ⇒ 留 1 删 3
  ok('三次以上 ⇒ 只留一次', cleanDraftText(title, body + body).duplicateRemoved === 3,
    `实际 ${cleanDraftText(title, body + body).duplicateRemoved}`);
  ok(
    '★ 只留一次（长度正确）',
    cleanDraftText(title, body + body).content === '巴库纳希切万街口发生一起货车事故，导致交通受阻。',
    JSON.stringify(cleanDraftText(title, body + body).content),
  );
}

section('三、标题回声 + 首图');
{
  const title = '吉尔吉斯斯坦国家电网呼叫中心年度咨询量激增 64%';
  const body =
    `${IMG}\n\n吉尔吉斯斯坦国家电网呼叫中心年度咨询量激增 64%。` +
    '这一数据反映出当地电力服务需求与用户沟通频率的同步上升。' +
    '作为国家电力基础设施的核心运营主体，供电公司面临服务负载提升。';
  const r = cleanDraftText(title, body);
  ok('★ 回声句被删', r.echoRemoved === 1, `实际 ${r.echoRemoved}`);
  ok(
    '★ 首图还在',
    (r.content.match(/<img/gi) || []).length === 1,
    JSON.stringify(r.content.slice(0, 80)),
  );
  ok('★ 其它正文没被动', r.content.includes('这一数据反映出当地电力服务需求'));
  ok('★ 标题没被动', r.title === title);
}

section('四、护栏：正文只有一句（= 标题）时不许删');
{
  const title = '乌兹别克斯坦总统沙夫卡特在安卡拉与土耳其总统举行会谈';
  const body = '乌兹别克斯坦总统沙夫卡特在安卡拉与土耳其总统举行会谈。';
  const r = cleanDraftText(title, body);
  ok('★ 一句都没删（正文空了更糟）', r.echoRemoved === 0 && r.duplicateRemoved === 0);
  ok('★ 内容原样保留', r.content === body, JSON.stringify(r.content));
}

section('五、幂等 + 不丢图');
{
  const title = '哈萨克斯坦轮胎价格可能上涨，部分廉价车型或于 2027 年消失';
  const body =
    `${IMG}\n\n哈萨克斯坦轮胎价格可能上涨，部分廉价车型或于 2027 年消失。` +
    '据 NewTimes.kz 引述 Kolesa.kz 报道，哈萨克斯坦可能面临轮胎涨价，部分廉价车型甚至可能在 2027 年从市场上消失。';
  const r1 = cleanDraftText(title, body);
  const r2 = cleanDraftText(r1.title, r1.content);
  ok('★ 洗两次结果一致', r1.content === r2.content);
  ok('★ 图没丢', (r1.content.match(/<img/gi) || []).length === 1);
  ok('★ 回声被删（标题与首句逐字相同）', r1.echoRemoved === 1, `实际 ${r1.echoRemoved}`);
}

section('六、不误伤：话题相近但事件不同');
{
  const title = '哈萨克斯坦总统托卡耶夫出席安卡拉土库曼峰会';
  const body =
    '哈萨克斯坦总统托卡耶夫于10月29日抵达土耳其安卡拉的宫殿综合体“库利耶”，出席土库曼峰会开幕式。' +
    '此次峰会汇聚了多个国家领导人，旨在加强区域合作与对话。';
  const r = cleanDraftText(title, body);
  ok('★ 带日期/地点的句子不被当回声删', r.echoRemoved === 0, `实际 ${r.echoRemoved}`);
  ok('★ 内容原样', r.content === body.trim());
}

section('七、短句不判重');
{
  const title = '某国发布新政策';
  const body = '据悉。据悉。';
  const r = cleanDraftText(title, body);
  ok('★ 短句重复不删', r.duplicateRemoved === 0, `实际 ${r.duplicateRemoved}`);
}

section('八、sentenceKey');
{
  ok('去空白去标签', sentenceKey('  <b>阿塞拜疆</b> 总统 ') === '阿塞拜疆总统');
  ok('大小写无关', sentenceKey('ABC') === sentenceKey('abc'));
  ok('空串 ⇒ 空串', sentenceKey('') === '');
}

section('九、空输入');
{
  const r = cleanDraftText('', '');
  ok('空标题空正文不炸', r.title === '' && r.content === '' && r.echoRemoved === 0);
  const r2 = cleanDraftText('标题', '');
  ok('有标题无正文不炸', r2.content === '');
}

console.log(`\n${'='.repeat(64)}`);
if (failures.length === 0) {
  console.log(`✅ 全部通过：${passed} 项断言`);
  process.exit(0);
} else {
  console.log(`❌ ${failures.length} 项失败 / 共 ${passed + failures.length} 项：`);
  for (const f of failures) console.log(`   - ${f}`);
  process.exit(1);
}
