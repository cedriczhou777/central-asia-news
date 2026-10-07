/**
 * 「脚本卫生」结构断言：**`scripts/` 与 `src/` 下的每个 .ts / .tsx 都必须是模块**。
 *
 * 用法：`pnpm test:script-hygiene`（离线、不联网、不碰数据库）
 *
 * ## 为什么需要这条断言（2026-10-07 实测，代价是两个小时）
 *
 * `tsconfig.json` 的 `include` 是个通配全部 `.ts` 的 glob（`**` 接 `/*.ts`），而
 * `scripts/build.sh` 跑的是
 * `pnpm next build` —— 它自己的 TypeScript 步骤会用同一份 tsconfig
 * ⇒ **`scripts/` 下每个 .ts 都被编进同一个 program**。
 *
 * 而一个**既没有 `import` 也没有 `export`** 的 .ts 是「**脚本**」而不是「模块」：
 * 它的顶层声明落在**全局命名空间**里。于是：
 *
 * - `scripts/analyze-judge-order.ts` 与 `scripts/analyze-recall-floor.ts`
 *   各自写了 `const BASE = ...` ⇒ 构建报
 *   `Type error: Cannot redeclare block-scoped variable 'BASE'` ⇒ **构建失败**；
 * - 而**构建失败的症状是「旧容器继续服务」**，外部看到的是
 *   「推送成功、远端 sha 变了、线上版本没换」—— 与「推送根本没触发构建」
 *   **在观测上完全同形**。本次因此误判了一轮「C″ 没触发构建」，
 *   直到在本地跑了一次真实的 `next build` 才看见真正的原因。
 *
 * ## 这条断言与 `tsc` 的关系（别把它当成重复品）
 *
 * `tsc -p tsconfig.json` **能**抓到那个错误 —— 前提是你**在最后一个文件写完之后**跑。
 * 本次漏掉的原因纯粹是：tsc 是在新增第二个脚本**之前**跑的。
 * 所以这条断言补的不是「类型检查」，而是**一个不依赖「记得按顺序跑」的结构不变量**：
 * 只要每个文件都是模块，这类跨文件重名**在构造上就不可能发生**。
 *
 * ## 它也检查「这条断言自己有没有空转」
 *
 * - 检查 `tsconfig.json` 的 `include` **确实覆盖** `scripts/`（否则本规则无意义，
 *   应该连同规则一起删掉，而不是留着一条恒真的绿灯）；
 * - 检查扫到的文件数在合理量级（glob 写错时不会静默变成「0 个文件全部合格」）；
 * - 用一个**合成的全局脚本**做反向自检：分析器必须能把它判成「非模块」。
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

let passed = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed++;
  } else {
    failures.push(detail ? `${name} —— ${detail}` : name);
  }
}

const ROOT = process.cwd();

/** 顶层 `import` / `export` ⇒ 模块。注释行以 `*` 或 `//` 开头，不会命中这两个正则。 */
function isModuleSource(src: string): boolean {
  return /^\s*(import|export)\b/m.test(src);
}

/**
 * 顶层声明名（**只在判定为非模块时**才有意义：模块的顶层名不污染全局）。
 *
 * 故意做得保守：只认行首的 `const/let/var/function/class`。
 * 宁可少抓几个名字，也不要因为认了缩进的局部变量而误报 ——
 * 误报会让这条断言被当成噪声，然后被人关掉。
 */
function topLevelNames(src: string): string[] {
  return [...src.matchAll(/^(?:const|let|var|function|class|async function)\s+([A-Za-z_$][\w$]*)/gm)].map(
    (m) => m[1],
  );
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry === 'dist' || entry.startsWith('.')) continue;
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(entry) && !entry.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

// ----- ① 收集 -----

const files = [...walk(join(ROOT, 'scripts')), ...walk(join(ROOT, 'src'))];
const parsed = files.map((p) => {
  const src = readFileSync(p, 'utf8');
  return { path: relative(ROOT, p), src, isModule: isModuleSource(src) };
});

ok(
  '扫到的 .ts/.tsx 数量在合理量级（glob 写错时不会静默变成「0 个文件全部合格」）',
  parsed.length > 50,
  `扫到 ${parsed.length} 个`,
);

// ----- ② 核心规则：每个文件都必须是模块 -----

const nonModules = parsed.filter((f) => !f.isModule);
ok(
  '★ scripts/ 与 src/ 下的每个 .ts / .tsx 都是**模块**（有顶层 import 或 export）',
  nonModules.length === 0,
  nonModules.length
    ? `全局作用域脚本（顶层声明会污染全局命名空间）：${nonModules.map((f) => f.path).join(', ')}`
    : '',
);

// ----- ③ 兜底：非模块之间不得有跨文件重名（规则②失效时的第二道网）----

{
  const seen = new Map<string, string[]>();
  for (const f of nonModules) {
    for (const n of topLevelNames(f.src)) {
      const arr = seen.get(n) ?? [];
      arr.push(f.path);
      seen.set(n, arr);
    }
  }
  const clashes = [...seen.entries()].filter(([, who]) => who.length > 1);
  ok(
    '非模块脚本之间没有跨文件的顶层重名（有的话云端构建会报 TS2451 而失败）',
    clashes.length === 0,
    clashes.map(([n, who]) => `${n}: ${who.join(' / ')}`).join('；'),
  );
}

// ----- ④ 反向自检：分析器必须能认出「全局脚本」 -----

{
  const synthetic = 'const BASE = 1;\nfunction naive() {}\n';
  ok(
    '反向自检：合成的全局脚本被判定为「非模块」',
    !isModuleSource(synthetic),
    '分析器把全局脚本误判成模块 —— 规则②恒真，等于没有',
  );
  ok(
    '反向自检：合成的全局脚本的顶层名被抽出来（能抓 const 与 function）',
    topLevelNames(synthetic).join(',') === 'BASE,naive',
    topLevelNames(synthetic).join(','),
  );
  ok(
    '反向自检：加了 `export {}` 之后同一个源被判定为模块',
    isModuleSource(`${synthetic}export {};\n`),
  );
}

// ----- ⑤ 这条规则是否仍然「有事可做」（别留一条恒真的绿灯）-----

{
  const tsconfig = JSON.parse(readFileSync(join(ROOT, 'tsconfig.json'), 'utf8')) as {
    include?: string[];
  };
  const include = tsconfig.include ?? [];
  ok(
    'tsconfig 的 include 确实覆盖 scripts/（否则本规则无意义，应连同它一起删掉）',
    include.some((p) => p.includes('**/*.ts')),
    JSON.stringify(include),
  );
  const build = readFileSync(join(ROOT, 'scripts/build.sh'), 'utf8');
  ok(
    '构建脚本里确实跑 next build（= 会用同一份 tsconfig 编 scripts/）',
    /next\s+build/.test(build),
  );
}

// ----- ⑥ JSDoc 续行里不得写出会提前终止块注释的 `**` + 斜杠 -----

/**
 * 这一类错误的真实来源：写文档注释时**引用 glob 字面量**。
 * `**` 后面紧跟一个斜杠，与紧接着的 `*` 组成注释终止符 ⇒ 注释在那一行断掉，
 * 剩下的内容被当成代码解析 ⇒ **语法错误 ⇒ 云端构建失败**（症状同「旧容器继续服务」）。
 *
 * 2026-10-07 我在三个文件里各写了一次，`tsx` 直接报
 * `Transform failed … Unexpected "*"`。所以补一条断言。
 *
 * 判据故意做得**窄**：只看**行首是 `*` 的续行**（JSDoc 正文）。
 * 代码里的字符串（例如 `p.includes(...)` 那种）不参与判断，避免误报 ——
 * 误报会让这条断言被当成噪声，然后被人关掉。
 */
{
  const hasGlobInDocLine = (line: string) => /^\s*\*/.test(line) && line.includes('**/');
  const offenders: string[] = [];
  for (const f of parsed) {
    f.src.split('\n').forEach((line, i) => {
      if (hasGlobInDocLine(line)) offenders.push(`${f.path}:${i + 1}`);
    });
  }
  ok(
    '没有 JSDoc 续行里写出 `**` + 斜杠（它会在那一行提前关掉块注释 ⇒ 语法错误 ⇒ 构建失败）',
    offenders.length === 0,
    offenders.length ? `命中：${offenders.join(', ')}` : '',
  );

  // 反向自检：探测器必须对「坏的」为真、对「拆开写的」为假。
  ok(
    '反向自检：探测器能认出「续行里写了 glob 字面量」',
    hasGlobInDocLine(' * 匹配全部：include 写的是 ' + '**/*.ts'),
    '探测器恒假 —— 这条规则等于没写',
  );
  ok(
    '反向自检：探测器不误报「把 glob 拆开写」的续行',
    !hasGlobInDocLine(' * 匹配全部：glob 是 ' + '**' + ' 接 ' + '/*.ts'),
  );
}

// ----- ⑦ 回归锚点：2026-10-07 那一对必须仍是模块 -----

for (const p of ['scripts/analyze-judge-order.ts', 'scripts/analyze-recall-floor.ts']) {
  const f = parsed.find((x) => x.path === p);
  ok(
    `${p} 仍是模块（2026-10-07 那个 const BASE 冲突的回归锚点）`,
    !!f && f.isModule,
    f ? '缺 export' : '文件不存在',
  );
}

// ----- 汇总 -----

console.log(`\n${'='.repeat(60)}`);
if (failures.length === 0) {
  console.log(`✅ 全部通过：${passed} 项断言`);
  process.exit(0);
} else {
  console.log(`❌ ${failures.length} 项失败 / 共 ${passed + failures.length} 项：`);
  for (const f of failures) console.log(`   - ${f}`);
  process.exit(1);
}
