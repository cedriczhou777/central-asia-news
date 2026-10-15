/**
 * 「运行时事实」的离线回归（不联网、不调模型、不起服务、不碰数据库）。
 *
 * 用法：`pnpm test:runtime-facts`
 *
 * ## 为什么这个套件必须存在
 *
 * `src/lib/runtime-facts.ts` 存在的唯一理由是**回答两个从外部回答不了的问题**：
 * 「`NODE_OPTIONS` 真的注入了吗」与「容器规格真的改了吗」。这两类改动
 * **没有代码变化** ⇒ 任何 `*Version` 指纹都不会动；控制台只多一个版本，而
 * 「改环境变量」与「改规格」**用的是同一个备注** ⇒ 版本列表也分不出。
 *
 * ⚠️ 于是这里最需要防的不是「读错」，而是**读出一个看起来正常、实际完全错误的数**：
 * `os.totalmem()` 在容器里返回**宿主机**内存（本机几十 GB），
 * 拿它当「容器规格」会让后面所有据此推出的安全余量**全部作废**，
 * 而且**看起来毫无异常** —— 这正是本项目最忌讳的那类「安静的错」。
 *
 * ⇒ 所以下面第 ③ 组断言的重点是：**在没有 cgroup 的环境里必须给 `null`**。
 *
 * ## ⚠️ 为什么第 ④ 组是源码断言而不是行为断言
 *
 * cgroup 文件只存在于 Linux 容器里，本机（macOS）跑不了 ⇒ cgroup 分支无法行为验证。
 * 那就改成断言「源码里**没有**那条错误的兜底」，并**同时**断言文件非空、
 * 且含已知标记 —— 否则「文件是空的」也会让「不含 totalmem」恒真，
 * 就是一个**空转的绿灯**（本项目栽过：`a?.x === a?.y` 两边都是 `undefined` 时恒真，
 * 2026-10-11 假绿灯）。所以这里先钉住「文件有内容」，再钉住「内容不含什么」。
 */
import { readFileSync } from 'fs';
import { totalmem } from 'os';
import { resolve } from 'path';
import { RUNTIME_FACTS_VERSION, readRuntimeFacts } from '../src/lib/runtime-facts';

let passed = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name}${detail ? ` —— ${detail}` : ''}`);
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

function section(title: string) {
  console.log(`\n${'─'.repeat(64)}\n${title}\n`);
}

function read(rel: string): string {
  return readFileSync(resolve(__dirname, '..', rel), 'utf8');
}

const moduleSrc = read('src/lib/runtime-facts.ts');
const fetchRouteSrc = read('src/app/api/fetch-news/route.ts');

/**
 * 剥掉注释后的源码。
 *
 * ⚠️ **必须剥**：本模块的注释里**故意**写了「不要用 `os.totalmem()` / `os.cpus().length`
 * 代替」这句话，而下面两条断言要判的正是「代码里不许用它们」。
 * 不剥就会把**注释里提到**误判成**代码里调用** —— 一个只会假红的断言。
 * （同一个坑在 `test-keepalive.ts` 第七组已经踩过一次：那里注释里提到
 *   `resolveTargetUrl()`，不剥注释就会造成假阳。）
 */
const moduleCode = moduleSrc
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/.*$/gm, '');

// ============================================================
// ① 部署指纹与基本形状
// ============================================================
section('① 部署指纹与字段形状');

ok('RUNTIME_FACTS_VERSION 是正整数', Number.isInteger(RUNTIME_FACTS_VERSION) && RUNTIME_FACTS_VERSION >= 1);

const facts = readRuntimeFacts();

ok('version 等于 RUNTIME_FACTS_VERSION', facts.version === RUNTIME_FACTS_VERSION, `实际 ${facts.version}`);

/**
 * ⚠️ 这里刻意用 `typeof … === 'number'` 而不是 `facts.x === facts.y` 那种写法：
 * 后者在两边都是 `null` / `undefined` 时**恒真**，是一个不会变红的假断言。
 */
ok('heapSizeLimitMB 是正数（不是 null/undefined/0）',
  typeof facts.heapSizeLimitMB === 'number' && facts.heapSizeLimitMB > 0,
  `实际 ${JSON.stringify(facts.heapSizeLimitMB)}`);

ok('nodeOptions 是 string 或 null',
  facts.nodeOptions === null || typeof facts.nodeOptions === 'string',
  `实际 ${JSON.stringify(facts.nodeOptions)}`);

ok('memoryLimitMB 是正数或 null',
  facts.memoryLimitMB === null || (typeof facts.memoryLimitMB === 'number' && facts.memoryLimitMB > 0),
  `实际 ${JSON.stringify(facts.memoryLimitMB)}`);

ok('cpuQuotaCores 是正数或 null',
  facts.cpuQuotaCores === null || (typeof facts.cpuQuotaCores === 'number' && facts.cpuQuotaCores > 0),
  `实际 ${JSON.stringify(facts.cpuQuotaCores)}`);

// ============================================================
// ② env 回显：原样、不解析
// ============================================================
section('② nodeOptions 原样回显 process.env.NODE_OPTIONS');

const before = process.env.NODE_OPTIONS;
try {
  process.env.NODE_OPTIONS = '--max-old-space-size=320';
  ok('设了 320 时读回来就是 320', readRuntimeFacts().nodeOptions === '--max-old-space-size=320');

  process.env.NODE_OPTIONS = '--max-old-space-size=640 --foo';
  ok('多个参数原样保留（不解析、不重排）',
    readRuntimeFacts().nodeOptions === '--max-old-space-size=640 --foo');

  delete process.env.NODE_OPTIONS;
  ok('没设时是 null（不是空串、不是 undefined）', readRuntimeFacts().nodeOptions === null);
} finally {
  if (before === undefined) delete process.env.NODE_OPTIONS;
  else process.env.NODE_OPTIONS = before;
}

// ============================================================
// ③ 没有 cgroup 时必须给 null（不许拿宿主机内存/核数冒充规格）
// ============================================================
section('③ 无 cgroup 环境里必须给 null，而不是宿主机数值');

const hasCgroupFile = (() => {
  try {
    readFileSync('/sys/fs/cgroup/memory.max');
    return true;
  } catch {
    return false;
  }
})();

if (hasCgroupFile) {
  ok('本机有 cgroup v2 ⇒ 走「读到上限」分支（这条不断言具体数值）',
    typeof readRuntimeFacts().memoryLimitMB === 'number');
} else {
  ok('本机无 /sys/fs/cgroup/memory.max ⇒ memoryLimitMB 必须是 null',
    readRuntimeFacts().memoryLimitMB === null,
    `实际 ${JSON.stringify(readRuntimeFacts().memoryLimitMB)}`);
  ok('本机无 cgroup ⇒ cpuQuotaCores 也必须是 null',
    readRuntimeFacts().cpuQuotaCores === null,
    `实际 ${JSON.stringify(readRuntimeFacts().cpuQuotaCores)}`);
  ok('⚠️ 关键：没有拿 os.totalmem() 冒充容器内存上限（否则一个几十 GB 的数会被当成规格）',
    readRuntimeFacts().memoryLimitMB !== Math.round(totalmem() / (1024 * 1024)));
}

// ============================================================
// ④ probe：一行摘要必须真的带上那几个数（不是装饰）
// ============================================================
section('④ probe 一行摘要是可核对的，不是装饰');

const p = readRuntimeFacts().probe;
ok('probe 含 NODE_OPTIONS=', p.includes('NODE_OPTIONS='));
ok('probe 含 V8 堆上限', p.includes('V8堆上限='));
ok('probe 含容器内存上限', p.includes('容器内存上限='));
ok('probe 含 CPU 配额', p.includes('CPU配额='));
ok('probe 说明了 null 的含义是「未暴露」而不是「无限」', p.includes('不是「无限」'));
ok('probe 里出现的堆上限数值与字段一致',
  p.includes(`${readRuntimeFacts().heapSizeLimitMB ?? '未知'}MB`));

// ============================================================
// ⑤ 源码断言：接上了没有 + 有没有那条错误的兜底
// ============================================================
section('⑤ 源码断言（防「模块写好了但没人用它 / 偷偷加了错误兜底」）');

// 先钉住「文件有内容」，否则下面两条「不含 X」会在空文件上恒真。
ok('runtime-facts.ts 非空（> 1000 字节），下面的「不含」断言不是空转',
  moduleSrc.length > 1000, `实际 ${moduleSrc.length} 字节`);
ok('runtime-facts.ts 含已知标记 readRuntimeFacts（证明读的是对的文件）',
  moduleSrc.includes('export function readRuntimeFacts'));

ok('★ 不许用 os.totalmem() 当容器内存上限的兜底',
  !/\btotalmem\b/.test(moduleCode));
ok('★ 不许用 os.cpus().length 当 CPU 配额的兜底',
  !/cpus\(\)\.length/.test(moduleCode));
ok('cgroup 未设限时必须被排除掉那个天文数字哨兵',
  moduleSrc.includes('CGROUP_UNLIMITED'));
ok('probe 里必须写明 null 的含义（不是「无限」）',
  moduleSrc.includes('不是「无限」'));

ok('fetch-news 路由 import 了 readRuntimeFacts',
  fetchRouteSrc.includes("from '@/lib/runtime-facts'") && fetchRouteSrc.includes('readRuntimeFacts'));
ok('fetch-news 路由真的调用了 readRuntimeFacts()（不是只 import）',
  fetchRouteSrc.includes('runtimeFacts: readRuntimeFacts()'));
ok('fetch-news 路由的 runtimeFacts 必须挂在 no-store 的 GET 响应里（保活靶子要能读到）',
  fetchRouteSrc.includes('runtimeFacts'));

// ============================================================
// 汇总
// ============================================================
console.log(`\n${'='.repeat(64)}`);
if (failures.length === 0) {
  console.log(`✅ 全部通过：${passed} 项断言`);
  process.exit(0);
} else {
  console.log(`❌ ${failures.length} 项失败 / 共 ${passed + failures.length} 项：`);
  for (const f of failures) console.log(`   - ${f}`);
  process.exit(1);
}