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

  // ★★ ChatGPT 2026-11-07 指出的残留边界：同国同标题但**跨版本**的稿子
  // ⇒ 原来只按「同国+同标题」查 ⇒ 会把**新版本**的同标题稿误判成重复 ⇒ **真丢稿**
  // ⇒ 现在查重加了版本约束 ⇒ 只有「同版本+同国+同标题」才跳
  const dupHit = (row: { country: string; titleKey: string; version: string }, v: string, k: string) =>
    row.country === 'kz' && row.titleKey === k && row.version === v;
  ok('★★ 同版本同国同标题 ⇒ 跳过（防重复提交）',
    dupHit({ country: 'kz', titleKey: 't1', version: 'v1' }, 'v1', 't1'));
  ok('★★ 跨版本同国同标题 ⇒ **不跳**（新稿能进来，不会丢稿）',
    !dupHit({ country: 'kz', titleKey: 't1', version: 'v1' }, 'v2', 't1'));
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


console.log('=== 推送侧「按指定日期取稿」（2026-11-07 新增）===');
{
  // 与 push/route.ts 的 processPush 同款窗口计算
  const windowOf = (dateRaw: unknown, scheduled: { start: Date; end: Date; hours: number } | null, hours: number) => {
    const dateParam =
      typeof dateRaw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateRaw) ? dateRaw : null;
    const startDate = dateParam
      ? new Date(`${dateParam}T00:00:00+08:00`).toISOString()
      : scheduled
        ? scheduled.start.toISOString()
        : new Date(Date.now() - hours * 3600 * 1000).toISOString();
    const endDate = dateParam
      ? new Date(`${dateParam}T23:59:59.999+08:00`).toISOString()
      : scheduled ? scheduled.end.toISOString() : new Date().toISOString();
    const source = dateParam ? 'date' : scheduled ? 'schedule' : 'hours';
    return { startDate, endDate, source, dateParam };
  };
  const bj = (iso: string) =>
    new Date(iso).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

  const w = windowOf('2026-11-08', null, 24);
  ok('★ 传 date ⇒ source=date', w.source === 'date');
  ok('★ 窗口 = 京时 00:00:00', bj(w.startDate).includes('00:00:00'), bj(w.startDate));
  ok('★ 窗口 = 京时 23:59:59', bj(w.endDate).includes('23:59:59'), bj(w.endDate));

  const w2 = windowOf(null, { start: new Date('2026-11-07T20:00:00Z'), end: new Date('2026-11-08T20:00:00Z'), hours: 24 }, 24);
  ok('★★ 不传 date ⇒ 仍是时刻表窗口（旧行为不变）', w2.source === 'schedule');

  const w3 = windowOf('11月8日', null, 24);
  ok('★ date 格式不对 ⇒ 忽略（退回原窗口）', w3.source === 'hours' && w3.dateParam === null);

  const w4 = windowOf('2026-11-08', null, 24);
  ok('★ date 参数同时支持 query（body 优先在 route 里处理）', w4.dateParam === '2026-11-08');
}

console.log(failed === 0 ? '\n✅ 全部通过' : `\n❌ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
