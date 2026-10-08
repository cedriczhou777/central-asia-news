/**
 * 「按国定召回下限」的**前置检查** —— 它现在的输出是「还不能定」。
 *
 * ## 这个脚本要阻止的那件事
 *
 * `RECALL_FLOOR_2026-10-07.md` 的结论之一是「一个全局 `minside` 是错的工具，
 * 下限要按国定」。方向没错（逐国候选密度差 30 倍、逐国切点也漂），
 * 但「按国定」要落到一个**具体数字**上，就必须有**逐国的标注量**做分母。
 *
 * 2026-10-08 把 5 国拆开一数：**kz 只有 2 条真 pair、0 条误 pair**
 * （一条误都没有 ⇒ 连「切到多少会误伤」这个问题都问不出来），
 * uz 8/1、az 10/17、kg 7/5、tj 6/40。
 * 拿 6 条真 pair 去定一个上线的阈值，就是**拍数字** —— 本项目禁止的那种。
 *
 * ⇒ 所以本脚本做三件事：
 *   ① 逐国列出标注量，**少于阈值就直接拒绝给建议值**（不是提示，是拒绝）；
 *   ② 列出「下限抬到 0.35」的逐国代价（丢多少真 / 挡多少误）—— 作为**方向**参考；
 *   ③ 列出逐国跨窗口的候选对数漂移 —— 说明切点本身也在动。
 *
 * 与 `pnpm analyze:recall-floor`（在给定标注集上算代价）的分工：
 * 那个算「代价多大」，这个算「**有没有资格算**」。
 *
 * 运行：`pnpm analyze:per-country-floor`（零成本离线）
 * 退出码：0 = 至少 3 国够格（可以谈按国定值）；2 = 够格国家不足，不产出建议值
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const R = join(HERE, 'fixtures');
const ORDER = ['kz', 'uz', 'az', 'kg', 'tj'];

/** 够格下限：少于这个数就不该拿它定产品阈值。 */
const MIN_TRUE = 10;
const MIN_FALSE = 10;
/** 参考档：把下限抬到这里看代价（也等于优先档 PAIR_PRIORITY_SIM）。 */
const FLOOR = 0.35;

type Row = { country: string; sim: number; same: boolean; src: string };

// —— 标注集：守卫簇夹具（逐节点事件标注 → 逐边真/误）+ judge-gold ——
const fx = JSON.parse(readFileSync(join(R, 'guard-clusters-2026-10-07.json'), 'utf8'));
const gold = JSON.parse(readFileSync(join(R, 'judge-gold.json'), 'utf8'));

const rows: Row[] = [];
for (const [cc, c] of Object.entries<any>(fx.countries)) {
  for (const e of c.edges) {
    const la = c.labels[String(e.a)];
    const lb = c.labels[String(e.b)];
    if (la && lb) rows.push({ country: cc, sim: e.sim, same: la === lb, src: 'guard-clusters' });
  }
}
for (const p of gold.pairs) {
  const m =
    typeof p.sim === 'number'
      ? p.sim
      : p.observed2026_10_05
        ? Number((String(p.observed2026_10_05).match(/sim=([\d.]+)/) || [])[1])
        : NaN;
  rows.push({ country: p.country ?? '?', sim: m, same: p.expect === 'same', src: 'judge-gold' });
}

const labeled = rows.filter((r) => Number.isFinite(r.sim));
console.log(`标注对合计 ${labeled.length} 条（真 ${labeled.filter((r) => r.same).length} / 误 ${labeled.filter((r) => !r.same).length}）`);
console.log(`来源：guard-clusters-2026-10-07.json（逐节点事件标注）+ judge-gold.json`);
console.log('');
console.log(`### 逐国标注量（够格线：真 ≥ ${MIN_TRUE} 且 误 ≥ ${MIN_FALSE}）`);
console.log('  国 |  真 |  误 | 够格 | 把下限抬到 ' + FLOOR + ' 的代价');
const qualified: string[] = [];
const unqualified: string[] = [];
for (const cc of ORDER) {
  const s = labeled.filter((r) => r.country === cc);
  const t = s.filter((r) => r.same);
  const f = s.filter((r) => !r.same);
  const ok = t.length >= MIN_TRUE && f.length >= MIN_FALSE;
  (ok ? qualified : unqualified).push(cc);
  const lostTrue = t.filter((r) => r.sim < FLOOR).length;
  const blockedFalse = f.filter((r) => r.sim < FLOOR).length;
  console.log(
    '  ' + cc + ' | ' + String(t.length).padStart(3) + ' | ' + String(f.length).padStart(3) + ' | ' +
      (ok ? ' 是 ' : ' 否 ') + ' | 丢真 ' + String(lostTrue).padStart(2) + '/' + String(t.length).padStart(2) +
      '，挡误 ' + String(blockedFalse).padStart(2) + '/' + String(f.length).padStart(2)
  );
}
const why = (cc: string) => {
  const s = labeled.filter((r) => r.country === cc);
  const t = s.filter((r) => r.same).length;
  const f = s.filter((r) => !r.same).length;
  const lack: string[] = [];
  if (t < MIN_TRUE) lack.push(`真只有 ${t}`);
  if (f < MIN_FALSE) lack.push(`误只有 ${f}`);
  return lack.join('、');
};
console.log('');
for (const cc of unqualified) console.log(`    ⚠ ${cc} 不够格：${why(cc)}`);

// —— 跨窗口的候选对数漂移（说明「切点」不是一个常数）——
const repro = JSON.parse(readFileSync(join(R, 'judge-repro-2026-10-07_10-08.json'), 'utf8'));
console.log('');
console.log('### 逐国「问到对数」的跨窗口漂移（来自 judge-repro 夹具的 3 个窗口）');
console.log('  国 | 各窗口问到对数        | 漂移');
for (const cc of ORDER) {
  const vals = repro.windows.map((w: any) => w.countries[cc]?.runs?.[0]?.asked).filter((v: any) => typeof v === 'number');
  if (!vals.length) continue;
  const spread = Math.max(...vals) - Math.min(...vals);
  console.log('  ' + cc + ' | ' + vals.map((v: number) => String(v).padStart(4)).join(' ') + ' | ' + (spread ? '±' + spread : '0'));
}

console.log('');
console.log('### 结论');
console.log(
  `够格可按国定值的国家：${qualified.join('、') || '（无）'}；不够格：${unqualified.join('、') || '（无）'}`
);
if (qualified.length < 3) {
  console.error(
    `✗ 够格国家只有 ${qualified.length} 个（< 3）⇒ **不产出按国下限的建议值**。\n` +
      '  下一步不是调阈值，是把逐国标注量补到够格线以上（AGENTS R-5：生产重标定前需要人工过一遍）。'
  );
  process.exit(2);
}
console.log('✓ 够格国家 ≥ 3 —— 可以谈按国定值；但仍需先在 ≥2 个窗口各量一次（见 JUDGE_STABILITY_2026-10-08.md）。');
