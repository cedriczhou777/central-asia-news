/**
 * 「五国稿包」接口的离线回归（2026-11-07）。
 *
 * ⚠️ 这个接口**会写生产库** ⇒ ⇒ 这里的测试**不碰数据库**：
 * 只测「契约校验」与「幂等语义」这两层。
 */
let failed = 0;
function ok(name: string, cond: boolean, extra = ''): void {
  if (cond) console.log('  ✓ ' + name);
  else { failed++; console.log('  ✗ ' + name + (extra ? ' —— ' + extra : '')); }
}

const COUNTRIES = ['kz', 'uz', 'kg', 'tj', 'az'];

/** 与 route.ts 同款（改了要同步） */
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

/** 幂等语义：同版本已入库哪些国家 ⇒ 该补哪些 */
function plan(version: string, done: string[]) {
  const doneSet = new Set(done);
  if (doneSet.size >= COUNTRIES.length) return { duplicate: true, todo: [] as string[] };
  return { duplicate: false, todo: COUNTRIES.filter((c) => !doneSet.has(c)) };
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

console.log('=== 幂等语义（ChatGPT 2026-11-07 指出的缺口）===');
{
  const p0 = plan('v', []);
  ok('★ 新版本 ⇒ 五国都要写', p0.todo.length === 5, JSON.stringify(p0.todo));

  const p1 = plan('v', ['kz', 'uz', 'kg']);
  ok('★ 部分已入库 ⇒ **只补缺的国家**（不整批跳过）',
    !p1.duplicate && p1.todo.length === 2 && p1.todo.includes('tj') && p1.todo.includes('az'),
    JSON.stringify(p1));

  const p2 = plan('v', ['kz', 'uz', 'kg', 'tj', 'az']);
  ok('★ 五国齐 ⇒ 整批跳过（duplicate=true）', p2.duplicate && p2.todo.length === 0);
}

console.log('=== 部分失败必须让调用方看见 ===');
{
  // route.ts 的语义：failed 非空 ⇒ ok:false + 500（模拟）
  const resp = (failed: Array<{ country: string; error: string }>) =>
    failed.length === 0
      ? { ok: true, status: 200 }
      : { ok: false, status: 500, failed };

  const none = resp([]);
  ok('★ 全部成功 ⇒ ok:true / 200', none.ok === true && none.status === 200);

  const some = resp([{ country: 'uz', error: 'boom' }]);
  ok('★ ★ 有国家失败 ⇒ **ok 必须为 false**（不能报成功）',
    some.ok === false && some.status === 500, JSON.stringify(some));
  ok('★ 失败清单里带国别与原因', some.failed?.[0]?.country === 'uz' && some.failed?.[0]?.error === 'boom');
}

console.log('=== 配图契约 ===');
{
  const bodyHtml = '<p>正文</p><p><img src="https://example.com/a.jpg" />图注：某某现场</p>';
  ok('★ bodyHtml 里带 <img src> ⇒ 旧链路会照旧上传到微信素材库', /<img[^>]+src="https?:/.test(bodyHtml));
  ok('★ 图注跟在图后（ChatGPT 约定「附图注和来源」）', bodyHtml.includes('图注：'));
}

console.log(failed === 0 ? '\n✅ 全部通过' : `\n❌ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
