/**
 * 判组提示词的**固定语料 A/B**：同一批标题对，逐版本跑一遍，报对照结果。
 *
 * 用法：
 *   pnpm judge:ab                          # 跑所有可用版本，比对照
 *   pnpm judge:ab --versions 1,3           # 只跑指定版本
 *   BASE=http://localhost:3000 pnpm judge:ab
 *   pnpm judge:ab --strict                 # 默认版本有任何一对判错就退出码 1（当闸门用）
 *
 * ## 为什么不是「跑两遍影子运行比一比」
 *
 * `GET /api/dedupe-check` 的逐对判定依赖**当天库里的候选对** —— 窗口滑动、
 * 新闻每天更新，同一份提示词在不同日子喂到模型的是不同的对。于是
 * 「这次结论和上次不一样」永远有两种解释：**提示词改了**／**今天新闻换了**。
 * 拿它在改判据前后各跑一次，比出来的差异**分不清是哪一种**。
 *
 * 这个脚本喂的是 `scripts/fixtures/judge-gold.json` 里写死的标题对，
 * 配 `pv=` 切换版本 —— **唯一变量只剩提示词**。
 *
 * ## 语料的期望值从哪来
 *
 * 人工标注（`expect: same|diff` + `note` 写理由），标题**逐字取自线上**。
 * 标注只用于**统计对错**，不会被传给模型 —— 模型只看得到标题。
 *
 * ⚠️ 语料不是「越多越好」而是「越准越好」：`expect` 标错一对，就会让
 * 一个正确的判据看起来像错的，然后被「修」坏。改标注前先想清楚理由，
 * 拿不准的一对标 `expect: null`（脚本会把它算作未标注、不计入对错）。
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

const BASE = process.env.BASE || 'https://central-asia-news-307705-12-1480606601.sh.run.tcloudbase.com';
const FIXTURE = 'scripts/fixtures/judge-gold.json';

/** 单次请求超时。服务端判组自己的超时是 45s，这里留出余量。 */
const REQUEST_TIMEOUT_MS = 90_000;

type GoldPair = { a: string; b: string; expect?: 'same' | 'diff' | null; note?: string };
type GoldFile = { _README?: string; _provenance?: Record<string, string>; pairs: GoldPair[] };

type ProbePair = {
  i: number;
  a: string;
  b: string;
  expect?: 'same' | 'diff';
  note?: string;
  /** `error` = 模型调用失败（**不是**判否），不该被算进「判错」 */
  verdict: 'same' | 'diff' | 'vetoed' | 'error';
  correct?: boolean;
  sim: number | null;
};
type ProbeResponse = {
  ok: boolean;
  error?: string;
  judgePromptVersion?: number;
  judgePromptVersionUsed?: number;
  judgePromptVersions?: number[];
  judgeMode?: string;
  provider?: string;
  candidateCount?: number;
  judgedSameCount?: number;
  declinedCount?: number;
  vetoed?: Array<{ sim: number; a: string; b: string }>;
  results?: ProbePair[];
  accuracy?: { labeled: number; correct: number; wrong: ProbePair[] };
};

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : undefined;
}

const strict = process.argv.includes('--strict');
const fixturePath = argValue('file') || FIXTURE;

async function probe(pv: number | undefined): Promise<ProbeResponse> {
  const gold = JSON.parse(readFileSync(resolve(process.cwd(), fixturePath), 'utf8')) as GoldFile;
  const body = {
    ...(pv !== undefined ? { pv } : {}),
    // 只把 a/b/expect/note 传过去；`expect` 服务端只用来统计对错，不喂模型。
    pairs: gold.pairs.map((p) => ({
      a: p.a,
      b: p.b,
      ...(p.expect ? { expect: p.expect } : {}),
      ...(p.note ? { note: p.note } : {}),
    })),
  };
  const res = await fetch(`${BASE}/api/judge-pairs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const json = (await res.json()) as ProbeResponse;
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}：${json.error || JSON.stringify(json).slice(0, 300)}`);
  }
  return json;
}

/** 判定标签的显示映射。`error` 单独一档：调用失败**不是**判否，别让它们长得一样。 */
function cell(v: string | undefined): string {
  const map: Record<string, string> = { same: '是', diff: '否', vetoed: '拦', error: '!失败' };
  return (map[v ?? ''] ?? '?').padEnd(2, ' ');
}

async function main() {
  const gold = JSON.parse(readFileSync(resolve(process.cwd(), fixturePath), 'utf8')) as GoldFile;
  const labeled = gold.pairs.filter((p) => p.expect === 'same' || p.expect === 'diff').length;
  console.log(`语料：${fixturePath}（${gold.pairs.length} 对，其中 ${labeled} 对有人工标注）`);
  console.log(`服务：${BASE}`);
  if (gold._provenance?.capturedAt) console.log(`语料采集于：${gold._provenance.capturedAt}`);
  console.log('');

  // 先探一次（不带 pv）拿到服务端**实际**注册的版本清单。
  // 不本地硬编码：那样会出现「本地以为有 v3、线上还没部署」的假对照 —— 脚本报出的
  // 对照表看起来正常，实际两次跑的是同一版。
  const first = await probe(undefined);
  const available = first.judgePromptVersions ?? [];
  if (available.length === 0) {
    throw new Error('服务端没返回 judgePromptVersions，无法确定可用版本 —— 是不是部署太旧？');
  }
  console.log(
    `部署指纹 judgePromptVersion = ${first.judgePromptVersion}；可用版本：${available.join(', ')}` +
      (available.length < 2 ? '　⚠️ 只剩一个版本，对照已经退化（pv 参数失去意义）' : ''),
  );

  const wantArg = argValue('versions');
  const versions = wantArg
    ? wantArg.split(',').map((s) => Number(s.trim()))
    : // 不含 pv 的那次探针结果就当第一个版本，避免重复调用
      available;
  const unknown = versions.filter((v) => !available.includes(v));
  if (unknown.length) throw new Error(`服务端没有这些版本：${unknown.join(', ')}；可用：${available.join(', ')}`);

  const runs: Array<{ v: number; res: ProbeResponse }> = [];
  for (const v of versions) {
    // 不带 pv 的那次探针跑的就是**默认版本**，与它同版本时直接复用，省一次模型调用
    const res = v === first.judgePromptVersionUsed ? first : await probe(v);
    runs.push({ v, res });
    console.log(
      `pv=${v}：provider=${res.provider ?? '?'} 问 ${res.candidateCount} 对，判「是」${res.judgedSameCount}、` +
        `判「否」${res.declinedCount}、极性拦下 ${res.vetoed?.length ?? 0}` +
        (res.accuracy ? `　标注 ${res.accuracy.labeled} 对里对 ${res.accuracy.correct}` : '') +
        (res.error ? `　⚠️ ${res.error}` : ''),
    );
  }
  console.log('');

  // 逐对并排
  //
  // 不做精细列对齐：标题里是中英混排（双宽字符），用 `.padEnd` 算出来的宽度
  // 在终端里本来就会错位，硬凑只会让代码变复杂而输出照旧乱。改成「一行一对、
  // 版本判定直接跟在后面」，靠固定分隔符读，反而更清楚。
  const byV = runs.map((r) => new Map((r.res.results ?? []).map((x) => [x.i, x])));
  console.log(`逐对判定（期望 = 人工标注；√ 判对，× 判错，拦 = 被极性判据拦下没问模型）`);
  console.log('');
  for (let i = 0; i < gold.pairs.length; i++) {
    const g = gold.pairs[i];
    const expectLabel = g.expect === 'same' ? '是' : g.expect === 'diff' ? '否' : '未标';
    const parts = runs.map(({ v }, k) => {
      const r = byV[k].get(i);
      const bad = g.expect && r?.verdict !== 'vetoed' && r?.verdict !== 'error' && r?.verdict !== g.expect;
      const mark = !g.expect || r?.verdict === 'vetoed' || r?.verdict === 'error' ? ' ' : bad ? '×' : '√';
      return `pv${v}=${cell(r?.verdict).trim()}${mark}`;
    });
    const sim = byV[0].get(i)?.sim;
    console.log(`[${String(i).padStart(2)}] sim=${sim === null || sim === undefined ? ' -' : sim.toFixed(2)} 期望=${expectLabel}  ${parts.join('  ')}`);
    console.log(`     「${g.a}」`);
    console.log(`     「${g.b}」`);
    // 判错的对把理由打出来，省得回头翻语料
    const anyBad = runs.some((_, k) => {
      const r = byV[k].get(i);
      return g.expect && r?.verdict !== 'vetoed' && r?.verdict !== 'error' && r?.verdict !== g.expect;
    });
    if (anyBad && g.note) console.log(`     ↳ 应为「${expectLabel}」：${g.note}`);
  }
  console.log('');

  // 逐版本汇总
  console.log('='.repeat(70));
  let best: { v: number; correct: number } | null = null;
  for (const { v, res } of runs) {
    const acc = res.accuracy;
    if (!acc) {
      console.log(`pv=${v}：没有标注对，无法统计（语料里 expect 全为空？）`);
      continue;
    }
    console.log(`pv=${v}：${acc.correct}/${acc.labeled} 正确` + (acc.wrong.length ? `；判错 ${acc.wrong.length} 对` : '；全对'));
    for (const w of acc.wrong) {
      console.log(`        × 期望「${w.expect === 'same' ? '是' : '否'}」实际「${w.verdict === 'same' ? '是' : '否'}」：${w.a}　||　${w.b}`);
    }
    if (!best || acc.correct > best.correct) best = { v, correct: acc.correct };
  }

  // 版本间差异：这才是「这次改动动了哪几对」的答案
  if (runs.length > 1) {
    console.log('');
    console.log(`版本间差异（基准 pv=${runs[0].v}）：`);
    let flips = 0;
    for (let i = 0; i < gold.pairs.length; i++) {
      const base = byV[0].get(i)?.verdict;
      for (let k = 1; k < runs.length; k++) {
        const cur = byV[k].get(i)?.verdict;
        if (base === cur) continue;
        flips++;
        const g = gold.pairs[i];
        const good = g.expect && cur === g.expect && base !== g.expect;
        console.log(
          `  pv${runs[0].v}「${cell(base).trim() || '?'}」→ pv${runs[k].v}「${cell(cur).trim() || '?'}」` +
            `${good ? ' ★修好' : g.expect && base === g.expect ? ' ★★回退' : ''}：${g.a}`,
        );
      }
    }
    if (!flips) console.log('  无差异 —— 两个版本在这批语料上判定完全一致');
  }

  if (strict && best) {
    const def = runs.find((r) => r.v === (first.judgePromptVersionUsed ?? first.judgePromptVersion));
    const wrong = def?.res.accuracy?.wrong.length ?? 0;
    if (wrong > 0) {
      console.log('');
      console.log(`--strict：默认版本 pv=${def?.v} 有 ${wrong} 对判错，退出码 1`);
      process.exit(1);
    }
  }
}

main().catch((err) => {
  // 打全错误再退出：这个脚本的失败原因通常是网络/部署，截断信息会让人误以为是判据问题。
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
});
