/**
 * 同一窗口内重复运行的**逐国**可复现性 —— 离线回归闸（零成本）。
 *
 * ## 为什么需要它
 *
 * 2026-10-08 我写完「跨窗口不稳定」那份报告后，顺手加了一句
 * 「同一窗口内重复调用可复现得可怕（连跑 4–5 次零摇摆）」，并把它抄进了
 * 报告、夹具、AGENTS 和长期记忆。**那句话是错的。**
 *
 * 错在**范围**：我当时看的 4–5 次一致，全部是 **tj 一国**的读数
 * （46 对 / 26是22否 都是 tj）。把 5 国一起看，同一窗口内 uz / kg / az 都会摇摆，
 * 而且幅度不小 —— 10-07 的 uz 三次判是分别是 9 / **15** / 9（6 对翻转）。
 *
 * ⇒ 「可复现」必须**逐国语**，不能整体语。这正是本项目那条硬规矩
 * （判定类数字必须带窗口日期）的同一个病根换了个面：**范围没写清**。
 *
 * ## 与 `pnpm analyze:judge-stability` 的关系
 *
 * 那个脚本是**全量归因仪器**（需要你把原始响应存成一个目录，按通道拆方差，
 * 报「通道内标准差」与「通道内动摇的对」）。它已经能算出同一件事，而且更全。
 * 本脚本是它的**夹具化最小版**：只读仓库里这份已提交的夹具，零成本、可断言、
 * 带「结论过期」护栏。两者的数字**必须一致**（实测 10-07 kg 都是 3 对、
 * 10-07 uz 都是 6 对、10-08 az 都是 3 对）—— 不一致就说明夹具或仪器坏了。
 *
 * ## 输入
 *
 * `scripts/fixtures/judge-repro-2026-10-07_10-08.json`（由线上原始响应逐字录入）
 * 运行：`pnpm analyze:judge-repro`
 * 退出码：0 通过；1 断言失败；2 可比国家不足 3 个（分母不足，不产出结论）
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, 'fixtures', 'judge-repro-2026-10-07_10-08.json');
const ORDER = ['kz', 'uz', 'az', 'kg', 'tj'];
const MIN_RUNS = 2;

type Run = { tag: string; ok: boolean; asked: number; yes: number; no: number; groups: number; pairSetHash: string };
type Country = {
  runs: Run[];
  题目集合在各次之间一致: boolean;
  可比: boolean;
  不可比的原因: string | null;
  判是极差: number | null;
  翻转对数: number | null;
  flippedPairs: { 判定序列: string; a: string; b: string }[];
};
type Window = { tag: string; since: string; params: Record<string, unknown>; countries: Record<string, Country> };

const fx = JSON.parse(readFileSync(FIXTURE, 'utf8')) as {
  _provenance: Record<string, string>;
  windows: Window[];
};

let failed = 0;
const fail = (m: string) => {
  console.error('✗ ' + m);
  failed++;
};

console.log('同一窗口内重复运行 —— 逐国可复现性（夹具化回归闸）');
console.log('夹具：' + FIXTURE.replace(HERE + '/', ''));
console.log('窗口数：' + fx.windows.length + '（' + fx.windows.map((w) => w.tag).join(' / ') + '）');
console.log('');

// —— 断言 ①：可比性必须自洽（`可比` 与它的理由字段不能矛盾）——
for (const w of fx.windows) {
  for (const cc of ORDER) {
    const c = w.countries[cc];
    if (!c) continue;
    const sameSet = c.题目集合在各次之间一致;
    const allOk = c.runs.every((r) => r.ok);
    const expectComparable = sameSet && allOk && c.runs.length >= MIN_RUNS;
    if (c.可比 !== expectComparable) {
      fail(`${w.tag}/${cc}：可比=${c.可比}，但题集一致=${sameSet} / 全 ok=${allOk} / 次数=${c.runs.length} ⇒ 应为 ${expectComparable}`);
    }
    if (!c.可比 && !c.不可比的原因) fail(`${w.tag}/${cc}：标了不可比却没写原因`);
    if (c.可比 && c.不可比的原因) fail(`${w.tag}/${cc}：标了可比却还带着不可比原因`);
    if (!c.可比 && c.判是极差 !== null) fail(`${w.tag}/${cc}：不可比却给了极差（会误导成「差异」）`);
  }
}

// —— 断言 ②：极差 与 翻转对数 的方向必须一致 ——
for (const w of fx.windows) {
  for (const cc of ORDER) {
    const c = w.countries[cc];
    if (!c || !c.可比 || c.判是极差 === null || c.翻转对数 === null) continue;
    if ((c.判是极差 > 0) !== (c.翻转对数 > 0)) {
      fail(`${w.tag}/${cc}：极差=${c.判是极差} 翻转=${c.翻转对数} —— 两者应同真同假`);
    }
    if (c.翻转对数 < c.判是极差) {
      fail(`${w.tag}/${cc}：翻转对数 ${c.翻转对数} < 极差 ${c.判是极差} —— 净变化不可能大于总翻转`);
    }
    const n = c.runs[0].asked;
    if (c.翻转对数 > n) fail(`${w.tag}/${cc}：翻转对数 ${c.翻转对数} > 题目数 ${n}`);
  }
}

// —— 打印 ——
for (const w of fx.windows) {
  console.log(`### ${w.tag}   since=${w.since}`);
  console.log('  国 | 各次判是          | 极差 | 翻转 | 可比');
  for (const cc of ORDER) {
    const c = w.countries[cc];
    if (!c) continue;
    console.log(
      '  ' + cc + ' | ' + c.runs.map((r) => String(r.yes).padStart(4)).join(' ') + ' | ' +
        (c.可比 ? String(c.判是极差).padStart(4) + ((c.判是极差 ?? 0) > 0 ? '★' : ' ') : '   —') + ' | ' +
        (c.可比 ? String(c.翻转对数).padStart(4) : '   —') + ' | ' +
        (c.可比 ? '是' : '否')
    );
  }
  const bad = ORDER.filter((cc) => w.countries[cc] && !w.countries[cc].可比);
  if (bad.length) {
    for (const cc of bad) console.log(`    ⚠ ${cc} 不可比：${w.countries[cc].不可比的原因}`);
  }
  console.log('');
}

// —— 分母闸：可比的国别读数太少就不产出结论（沿用项目惯例 exit 2）——
const comparable = fx.windows.flatMap((w) =>
  ORDER.filter((cc) => w.countries[cc]?.可比).map((cc) => `${w.tag}/${cc}`)
);
if (comparable.length < 3) {
  console.error(`✗ 可比读数只有 ${comparable.length} 个（< 3）⇒ 分母不足，不产出结论`);
  process.exit(2);
}

// —— 断言 ③（承重）：至少要有一国在某个窗口里摇摆 ——
// 作用：**防结论过期**。若哪天模型真的变确定了，这条会红，
// 逼我们回头重估「重复调用不是独立样本」这条硬规矩还成不成立。
const wobbling = fx.windows.flatMap((w) =>
  ORDER.filter((cc) => w.countries[cc]?.可比 && (w.countries[cc].判是极差 ?? 0) > 0).map(
    (cc) => `${w.tag}/${cc}`
  )
);
const stable = fx.windows.flatMap((w) =>
  ORDER.filter((cc) => w.countries[cc]?.可比 && w.countries[cc].判是极差 === 0).map((cc) => `${w.tag}/${cc}`)
);
if (!wobbling.length) {
  fail(
    '承重断言：所有窗口所有可比国家都零摇摆 —— 与本夹具要支撑的结论相反。' +
      '要么模型/接口真的变确定了，要么夹具退化了；请重估「重复调用不是独立样本」这条硬规矩'
  );
}

console.log('摇摆读数（极差 > 0）：' + wobbling.join('、'));
console.log('零摇摆读数：' + stable.join('、'));
const windowsWithWobble = [...new Set(wobbling.map((x) => x.split('/')[0]))];
console.log(`覆盖窗口：${windowsWithWobble.length}/${fx.windows.length} 个窗口里至少有一国摇摆`);
console.log('出现过摇摆的国家：' + [...new Set(wobbling.map((x) => x.split('/')[1]))].join('、'));
console.log('');
console.log('翻转样例（第一处）：');
const f0 = fx.windows
  .flatMap((w) => ORDER.map((cc) => ({ w: w.tag, cc, f: w.countries[cc]?.flippedPairs?.[0] })))
  .find((x) => x.f);
if (f0?.f) {
  console.log(`  ${f0.w}/${f0.cc}   判定序列=${f0.f.判定序列}`);
  console.log(`    「${f0.f.a}」`);
  console.log(`    「${f0.f.b}」`);
}

console.log('');
if (failed) {
  console.error(`✗ 断言失败 ${failed} 条`);
  process.exit(1);
}
const wobbledCountries = [...new Set(wobbling.map((x) => x.split('/')[1]))];
const neverWobbled = ORDER.filter((cc) => !wobbledCountries.includes(cc));
console.log(
  '✓ 断言全通过。结论（**逐国说，不要整体说**）：\n' +
    `  · 出现过摇摆的国家（任一个窗口里极差 > 0）：${wobbledCountries.join('、')}\n` +
    `  · 从未摇摆的国家（所有可比读数都极差 = 0）：${neverWobbled.join('、')}\n` +
    `  · ${windowsWithWobble.length}/${fx.windows.length} 个窗口里至少有一国摇摆\n` +
    '  ⇒ 「重复调用不是独立样本」成立（这是一条**否定性**结论，所以只需一个反例即可立住）。\n' +
    '  ⇒ 但任何「重复 N 次都一致」的观测，只覆盖你实际看过的那几个国家 —— 不能外推成「模型是确定的」。'
);
