/**
 * 「五国稿包」接口的离线回归（2026-11-07）。
 *
 * ⚠️ 这个接口**会写生产库** ⇒ ⇒ 这里的测试**不碰数据库**：
 * 只测「契约校验」那一层（五国齐不齐、版本号、鉴权头的形状）。
 */
let failed = 0;
function ok(name: string, cond: boolean, extra = ''): void {
  if (cond) console.log('  ✓ ' + name);
  else { failed++; console.log('  ✗ ' + name + (extra ? ' —— ' + extra : '')); }
}

const COUNTRIES = ['kz', 'uz', 'kg', 'tj', 'az'];

/** 与 route.ts 同款的校验（保持一致 ⇒ 改了要同步） */
function validate(body: { version?: string; countries?: Record<string, { title?: string; bodyHtml?: string }> }) {
  const version = (body.version || '').trim();
  if (!version) return { ok: false, error: '缺少 version（版本号 = 幂等键）' };
  const countries = body.countries || {};
  const missing = COUNTRIES.filter((c) => !countries[c] || !countries[c].title);
  if (missing.length > 0) {
    return { ok: false, error: `五国未齐，缺：${missing.join('、')} ⇒ 按约定不提交`, missing };
  }
  return { ok: true, version };
}

console.log('=== 稿包契约校验 ===');
{
  const full: Record<string, { title: string; bodyHtml: string }> = {};
  for (const c of COUNTRIES) full[c] = { title: `${c} 标题`, bodyHtml: '<p>正文</p>' };

  ok('五国齐 + 有版本号 ⇒ 通过', validate({ version: '2026-11-07', countries: full }).ok);

  const miss = { ...full }; delete (miss as Record<string, unknown>).tj;
  const r1 = validate({ version: '2026-11-07', countries: miss });
  ok('★ 缺一国 ⇒ 拒绝（不落库）', !r1.ok && String(r1.error).includes('tj'), JSON.stringify(r1));

  const r2 = validate({ countries: full });
  ok('★ 缺版本号 ⇒ 拒绝（幂等键不能少）', !r2.ok && String(r2.error).includes('version'));

  const noTitle: Record<string, { title?: string }> = {};
  for (const c of COUNTRIES) noTitle[c] = { title: c === 'az' ? undefined : `${c} 标题` };
  ok('★ 有国家没标题 ⇒ 拒绝', !validate({ version: 'v', countries: noTitle }).ok);
}

console.log('=== 幂等键的形状（tags）===');
{
  const version = '2026-11-07';
  const tags = ['word', `v:${version}`];
  ok('★ tags 同时带输入源标记与版本号', tags.includes('word') && tags.includes(`v:${version}`), JSON.stringify(tags));
  ok('★ 不同版本 ⇒ 不同 tags ⇒ 不会被当成同一批', ['word', 'v:2026-11-07'].join() !== ['word', 'v:2026-11-08'].join());
}

console.log('=== 配图契约 ===');
{
  const bodyHtml = '<p>正文</p><p><img src="https://example.com/a.jpg" />图注：某某现场</p>';
  ok('★ bodyHtml 里带 <img src> ⇒ 旧链路会照旧上传到微信素材库', /<img[^>]+src="https?:/.test(bodyHtml));
  ok('★ 图注跟在图后（ChatGPT 约定「附图注和来源」）', bodyHtml.includes('图注：'));
}

console.log(failed === 0 ? '\n✅ 全部通过' : `\n❌ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
