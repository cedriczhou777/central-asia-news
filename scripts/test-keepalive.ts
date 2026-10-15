/**
 * 任务期自保活的离线回归（不联网、不调模型、不起服务）。
 *
 * 用法：`pnpm test:keepalive`
 *
 * ## 为什么这个套件必须存在
 *
 * `src/lib/keepalive.ts` 是本项目**唯一一个「静默失效」的降本机制**：
 * 它没配好、配错前缀、或者压根没接进 `runPublishCycle` 时，
 * 表现全都是「什么都没有发生」—— 不报错、不打 warn、轮次也照样跑完。
 * 而它的失败**要等到窗口被收窄之后才咬人**（长轮次被平台缩容腰斩 ⇒ 丢一整天）。
 *
 * ⇒ 所以这里测的不是「保活管不管用」（那要真跑一轮才知道，见文件头那条未验证前提），
 *   而是**「它到底有没有被接上、接对了没有」**：
 *   ① 常量关系成立（间隔必须小于平台 30 分钟空闲红线）；
 *   ② **fail-safe**：没配靶子时**必须不启用**，而且**不许抛**；
 *   ③ 配好了时状态回显正确（尤其 `targetHost` 只能是 host，不能是 localhost）；
 *   ④ 幂等（`start` / `stop` 都可能被重复调用）；
 *   ⑤ **源码断言** —— 防「模块写好了、但没人调用它」这类**绿着的假通过**。
 *
 * ⚠️ 第 ⑤ 组是这套件存在的主要理由。本项目的判例：一个机制「实现了」和「接上了」
 * 是两件事，而只有后者会体现在线上行为里（见 `AGENTS.md` 里同类记录）。
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  KEEPALIVE_VERSION,
  PING_INTERVAL_MS,
  PING_RETRY_MS,
  PING_TIMEOUT_MS,
  keepaliveCrossCheck,
  readKeepaliveStatus,
  startKeepalive,
  stopKeepalive,
} from '../src/lib/keepalive';

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

/** 环境变量必须还原：本套件与将来的其它套件可能跑在同一个进程里（`verify:offline` 是串行 pnpm 链，但别依赖这一点）。 */
function withEnv(value: string | undefined, fn: () => void) {
  const before = process.env.KEEPALIVE_TARGET_URL;
  if (value === undefined) delete process.env.KEEPALIVE_TARGET_URL;
  else process.env.KEEPALIVE_TARGET_URL = value;
  try {
    fn();
  } finally {
    if (before === undefined) delete process.env.KEEPALIVE_TARGET_URL;
    else process.env.KEEPALIVE_TARGET_URL = before;
  }
}

const TARGET = 'https://central-asia-news.example.sh.run.tcloudbase.com/api/fetch-news';
/** 与 `scheduler.ts` 里那个算式等值的数，只为本地断言用；生产侧不许写死这个数（见第六组）。 */
const HARD_MAX = 440 * 60_000;

/**
 * 源码断言（第六、七组）要读的文件。
 * ⚠️ 必须在这里统一读：`const` 有 TDZ，第七组排在前面对模块级变量求值会直接 ReferenceError。
 */
const schedulerSrc = read('src/lib/scheduler.ts');
const fetchRouteSrc = read('src/app/api/fetch-news/route.ts');
const pushRouteSrc = read('src/app/api/wechat/push/route.ts');
const keepaliveSrc = read('src/lib/keepalive.ts');

// ============================================================
// 一、常量关系
// ============================================================

section('一、常量关系（改数字时本地就要红）');

{
  const checks = keepaliveCrossCheck(HARD_MAX);
  ok(
    `自检表非空（当前 ${checks.length} 条）`,
    checks.length > 0,
  );
  for (const c of checks) ok(c.name, c.ok, c.detail);

  // ★ 反向自检：断言必须**可达**。只测「传对的时候全绿」是不够的 ——
  // 一个 `ok: true` 写死的实现能让上面那圈全绿。
  ok(
    '★ 反向自检：硬上限传 0 ⇒ 「≥ 一个保活间隔」那条必须变红',
    keepaliveCrossCheck(0).some((c) => !c.ok),
    '传 0 时全绿 ⇒ 这条断言根本没在判',
  );
  ok(
    '★ 反向自检：硬上限传 1 毫秒 ⇒ 同样必须变红',
    keepaliveCrossCheck(1).some((c) => !c.ok),
    '传 1ms 时全绿 ⇒ 同上',
  );
  ok(
    '★ 断言可达：平台红线那条的 detail 里必须出现「红线」（防止 name/detail 被换成空串后照样绿）',
    checks[0].detail.includes('红线'),
    `实际 detail = 「${checks[0].detail}」`,
  );
}

// ============================================================
// 七、★ 环境变量「注入成功了吗」必须能在跑轮次之前自证（KEEPALIVE_VERSION=2 起）
// ============================================================

section('七、★ 环境变量注入是否成功，必须在跑轮次之前就能自证');

/**
 * ⚠️ **本组必须排在任何 `startKeepalive()` 调用之前。**
 *
 * 它测的是「`configured` 是不是实时从环境变量现算」。修复前的实现只在
 * `startKeepalive()` 里锁存这个字段 —— 于是只要本组跑到**后面**去，
 * 锁存值早就被前面几组设成 `true` 了，**旧实现照样能通过全部断言** ⇒ 断言空转。
 * 排在最前面，`state` 还是 `freshState()` 的 `configured:false`，
 * 于是「配了合法 env 却读到 false」就能真的变红。
 * （判据：把 `readKeepaliveStatus()` 改回 `return snapshot;` 跑一遍，本组必须失败。）
 */
withEnv(TARGET, () => {
  const s = readKeepaliveStatus();
  ok(
    '★ 一次轮次都没跑过，配了合法 env ⇒ configured 就必须是 true',
    s.configured === true,
    '仍为 false ⇒ 说明它还在只回显锁存值，「环境变量注入成功了吗」在跑轮次前无法自证；' +
      '而「加环境变量 + 重新部署」恰恰发生在收窗口之前',
  );
  ok(
    '★ 一次轮次都没跑过 ⇒ targetHost 就该报出真实 host（能一眼核对域名打对了没）',
    s.targetHost === 'central-asia-news.example.sh.run.tcloudbase.com',
    `实际 = ${s.targetHost}`,
  );
  ok('配上了 ≠ 正在保活：此时 active 仍是 false', s.active === false);
});

withEnv(undefined, () => {
  const s = readKeepaliveStatus();
  ok('★ 反向自检：env 清空 ⇒ configured 必须变回 false', s.configured === false);
  ok('★ 反向自检：env 清空 ⇒ targetHost 必须变回 null', s.targetHost === null);
});

withEnv('ftp://example.com/api/fetch-news', () => {
  ok(
    '反向自检：前缀不合法 ⇒ configured=false（不许把「配错了」报成「配好了」）',
    readKeepaliveStatus().configured === false,
  );
});

withEnv('   ', () => {
  ok('反向自检：只有空白 ⇒ configured=false', readKeepaliveStatus().configured === false);
});

withEnv('https://', () => {
  const s = readKeepaliveStatus();
  ok(
    '★ 前缀对但 URL 本身不合法 ⇒ configured=true 且 targetHost=null' +
      '（两个字段组合起来才能区分「没配」与「值写错了」）',
    s.configured === true && s.targetHost === null,
    `实际 configured=${s.configured} targetHost=${s.targetHost}`,
  );
});

{
  // 状态接口会被调度器每 15 秒轮询一次。所以「现算」这件事不能带副作用 ——
  // 把带告警的 resolveTargetUrl() 放进来会刷屏（这正是分成纯函数 + 告警两层的原因）。
  const warns: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warns.push(args.map(String).join(' '));
  };
  try {
    withEnv('ftp://example.com/api/fetch-news', () => {
      for (let i = 0; i < 50; i++) readKeepaliveStatus();
    });
  } finally {
    console.warn = origWarn;
  }
  ok(
    '★ 轮询友好：连读 50 次状态（含非法 env 值）不许打任何 warn',
    warns.length === 0,
    `实际打了 ${warns.length} 条`,
  );
}

{
  // `startKeepalive(...)` 写在 runPublishCycle 的 `try {` **之前**（scheduler.ts:426 vs :430），
  // 那里抛出去没有任何 catch ⇒ 整轮抓取与推送都不执行 = 丢一整天。
  // 而它读的是**人手在控制台敲进去的**环境变量，写错是常态 ⇒ 必须构造上不可能抛。
  const adversarial: Array<string | undefined> = [
    undefined,
    '',
    '   ',
    'ftp://example.com/x',
    'https://',
    'https://a b',
    'https://[bad',
    'javascript:alert(1)',
    'HTTP://UPPER.example.com/x',
    `https://x/${'y'.repeat(5000)}`,
  ];
  let threw: unknown = null;
  for (const v of adversarial) {
    withEnv(v, () => {
      try {
        startKeepalive({ reason: `离线回归：对抗输入 ${String(v).slice(0, 20)}`, hardMaxMs: HARD_MAX });
      } catch (e) {
        threw = e;
      }
      stopKeepalive('离线回归：对抗输入清理');
    });
  }
  ok(
    `★ startKeepalive 对 ${adversarial.length} 组对抗输入一律不抛（它在 try 之外，抛了就是丢一整天）`,
    threw === null,
    String(threw),
  );
}

{
  const at = keepaliveSrc.indexOf('export function readKeepaliveStatus');
  const body = at >= 0 ? keepaliveSrc.slice(at, at + 2500) : '';
  // 去掉注释再判：函数正文里的说明文字会提到 resolveTargetUrl() 这个名字，
  // 不剥注释就会把「注释里提到」误判成「代码里调用」。
  const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  ok(
    '★ readKeepaliveStatus 的**代码**里只调纯函数 parseTargetUrl，不调带告警的 resolveTargetUrl',
    at >= 0 && code.includes('parseTargetUrl(') && !code.includes('resolveTargetUrl('),
    `截取长度=${body.length}`,
  );
}

{
  const at = keepaliveSrc.indexOf('export function startKeepalive(');
  const body = at >= 0 ? keepaliveSrc.slice(at, at + 500) : '';
  ok(
    '★ 导出的 startKeepalive 包在 try/catch 里并转调 startKeepaliveInner（构造上不抛）',
    at >= 0 && body.includes('try {') && body.includes('startKeepaliveInner(options)') && body.includes('catch'),
    `截取长度=${body.length}`,
  );
}

// ============================================================
// 八、★ 自愈基线 `baselineFinishedAt` 必须真的有写入点
// ============================================================

section('八、★ 自愈基线 —— `baselineFinishedAt` 有写入点吗（1–2 版恒为 null ⇒ 自愈从未触发）');

/**
 * ## 为什么这组是源码断言
 *
 * 写入点落在 `pingOnce()` 里，而它要**真的发一次 ping**才走得到；本套件明令
 * 「不起服务、不联网」，所以**这里做不到行为验证**。
 * 那就钉住两件能钉住的：① 写入语句存在且被 `=== null` 守卫；
 * ② `startKeepaliveInner()` 里有清空（否则第二轮基线是上一轮的 ⇒ 自愈只在第一轮有效）。
 *
 * ## 为什么措辞这么具体
 *
 * 这个字段的原症状就是**判据恒假**（2026-10-16 实测：`grep baselineFinishedAt`
 * 全仓库只有 4 处、**零写入点**）。若断言写成
 * `status.baselineFinishedAt !== null` 这类形式，两边都是 `null` 时**恒真**，
 * 就是一条不会变红的假断言 —— 所以必须写成「**存在某个具体的赋值语句**」。
 */
{
  const pingAt = keepaliveSrc.indexOf('async function pingOnce(');
  const pingBody = pingAt >= 0 ? keepaliveSrc.slice(pingAt, pingAt + 3200) : '';
  const innerAt = keepaliveSrc.indexOf('function startKeepaliveInner(');
  const innerBody = innerAt >= 0 ? keepaliveSrc.slice(innerAt, innerAt + 1800) : '';

  ok('找得到 pingOnce()（截取窗口非空，否则下面几条会空转）',
    pingAt >= 0 && pingBody.length > 500, `截取长度=${pingBody.length}`);
  ok('找得到 startKeepaliveInner()（同上）',
    innerAt >= 0 && innerBody.length > 500, `截取长度=${innerBody.length}`);

  ok('★ pingOnce() 里真的有 `state.baselineFinishedAt = finishedAt`（1–2 版缺的就是这句）',
    pingBody.includes('state.baselineFinishedAt = finishedAt'));
  ok('★ 那句被 `=== null` 守卫（否则基线被自己推着走、判据又恒假）',
    pingBody.includes('if (state.baselineFinishedAt === null && finishedAt)'));
  ok('★ 守卫不是 `!== null`（那是「每次都更新」，等于没有基线）',
    !pingBody.includes('if (state.baselineFinishedAt !== null'));

  ok('★ startKeepaliveInner() 里把基线清空（新的一轮必须重记）',
    innerBody.includes('state.baselineFinishedAt = null'));
}

/**
 * 行为侧能钉的那一条：启动一次之后基线必须是 `null`（尚未记，等第一次 ping）。
 * 先 `stopKeepalive()` 再启动，**不依赖前面各组的执行顺序**。
 */
withEnv(TARGET, () => {
  stopKeepalive('离线回归：第八组之前先停');
  startKeepalive({ reason: '离线回归：第八组', hardMaxMs: HARD_MAX });
  const s = readKeepaliveStatus();
  ok(
    '★ 刚启动、还没发过 ping 时 baselineFinishedAt 必须是 null（此时它拿不到也用不上）',
    s.baselineFinishedAt === null,
    `实际 ${JSON.stringify(s.baselineFinishedAt)}`,
  );
  ok('KEEPALIVE_VERSION >= 3（3 = 自愈基线真的有写入点的那一版）',
    KEEPALIVE_VERSION >= 3, `实际 ${KEEPALIVE_VERSION}`);
  stopKeepalive('离线回归：第八组收尾');
});

// ============================================================
// 二、fail-safe：没配靶子就必须不启用，且不许抛
// ============================================================

section('二、fail-safe —— 没配靶子时「不启用」而不是「报错」');

withEnv(undefined, () => {
  let threw: unknown = null;
  try {
    startKeepalive({ reason: '离线回归：未配置', hardMaxMs: HARD_MAX });
  } catch (e) {
    threw = e;
  }
  const s = readKeepaliveStatus();
  ok('未配置 KEEPALIVE_TARGET_URL ⇒ startKeepalive 不抛异常', threw === null, String(threw));
  ok('未配置 ⇒ configured=false', s.configured === false);
  ok('未配置 ⇒ active=false（不静默地「假装在保活」）', s.active === false);
  ok('未配置 ⇒ targetHost 为 null', s.targetHost === null);
});

withEnv('ftp://example.com/api/fetch-news', () => {
  let threw: unknown = null;
  try {
    startKeepalive({ reason: '离线回归：非法前缀', hardMaxMs: HARD_MAX });
  } catch (e) {
    threw = e;
  }
  const s = readKeepaliveStatus();
  ok('前缀不是 http(s) ⇒ 不抛异常', threw === null, String(threw));
  ok('前缀不是 http(s) ⇒ 一律不启用（宁可明确不启用，也不静默打一个打不通的靶子）', s.active === false);
});

// ============================================================
// 三、配好了 ⇒ 启用，且状态回显正确
// ============================================================

section('三、配好靶子 ⇒ 启用，且回显能自证「打的是对的那个域名」');

withEnv(TARGET, () => {
  const before = Date.now();
  startKeepalive({ reason: '离线回归：正常启用', hardMaxMs: HARD_MAX });
  const s = readKeepaliveStatus();

  ok('configured=true', s.configured === true);
  ok('active=true', s.active === true);
  ok(
    '★ targetHost 只有 host、没有路径（能一眼看出打的不是 localhost）',
    s.targetHost === 'central-asia-news.example.sh.run.tcloudbase.com',
    `实际 = ${s.targetHost}`,
  );
  ok(
    '★ targetHost 不是 localhost（平台只认经过它反向代理的请求，打 localhost 等于没打）',
    !(s.targetHost ?? '').includes('localhost'),
  );
  ok('startReason 原样回显', s.startReason === '离线回归：正常启用');
  ok('startedAt 是合法时间戳', !!s.startedAt && !Number.isNaN(Date.parse(s.startedAt)));
  {
    const deadline = s.hardDeadline ? Date.parse(s.hardDeadline) : NaN;
    const expected = before + HARD_MAX;
    ok(
      'hardDeadline ≈ 启动时刻 + hardMaxMs（容差 5 秒）',
      !Number.isNaN(deadline) && Math.abs(deadline - expected) < 5_000,
      `hardDeadline=${s.hardDeadline}`,
    );
  }
  ok('version 回显 = KEEPALIVE_VERSION', s.version === KEEPALIVE_VERSION);

  // ── 四、幂等 ──
  section('四、幂等（start / stop 都可能被重复调用）');

  const startedAtFirst = s.startedAt;
  const reasonFirst = s.startReason;
  startKeepalive({ reason: '离线回归：重复启动（应被忽略）', hardMaxMs: HARD_MAX });
  const afterSecond = readKeepaliveStatus();
  ok('重复 startKeepalive ⇒ startedAt 不变（不重置计时）', afterSecond.startedAt === startedAtFirst);
  ok('重复 startKeepalive ⇒ startReason 不变（后一次被忽略）', afterSecond.startReason === reasonFirst);

  stopKeepalive('离线回归：第一次停');
  const stopped = readKeepaliveStatus();
  ok('stopKeepalive 之后 active=false', stopped.active === false);
  ok('stopReason 回显', stopped.stopReason === '离线回归：第一次停');

  const stoppedAtFirst = stopped.stoppedAt;
  const stopReasonFirst = stopped.stopReason;
  let stopThrew: unknown = null;
  try {
    stopKeepalive('离线回归：第二次停（应是无害的 no-op）');
  } catch (e) {
    stopThrew = e;
  }
  const afterTwice = readKeepaliveStatus();
  ok('重复 stopKeepalive 不抛异常', stopThrew === null, String(stopThrew));
  ok('重复 stopKeepalive ⇒ stoppedAt 不变', afterTwice.stoppedAt === stoppedAtFirst);
  ok('重复 stopKeepalive ⇒ stopReason 不变', afterTwice.stopReason === stopReasonFirst);

  // ── 五、返回值是副本 ──
  section('五、readKeepaliveStatus 返回副本（外部改不到内部状态）');

  const a = readKeepaliveStatus();
  a.pings = 9999;
  a.active = true;
  const b = readKeepaliveStatus();
  ok('改返回值里的 pings 不影响内部状态', b.pings !== 9999, `实际 = ${b.pings}`);
  ok('改返回值里的 active 不影响内部状态', b.active === false);
  ok(
    '返回值里不带内部定时器句柄（它是实现细节，不该出现在接口响应里）',
    !('timer' in (b as unknown as Record<string, unknown>)),
  );
});

// ============================================================
// 六、★ 源码断言 —— 防「模块写了，但没人调用」
// ============================================================

section('六、★ 源码断言 —— 这个机制真的被接进链路了吗');

ok('scheduler.ts 调用了 startKeepalive(', schedulerSrc.includes('startKeepalive({'));
ok('scheduler.ts 调用了 stopKeepalive(', schedulerSrc.includes('stopKeepalive('));

{
  // 「停」必须写在 finally 里：这是本机制唯一会「反向变贵」的失败模式
  // （漏停 ⇒ 实例活到硬上限）。只断言「有 stopKeepalive」是不够的 ——
  // 写在 try 尾部时，异常路径就漏了，而那正是最需要停的时刻。
  const finallyAt = schedulerSrc.indexOf('} finally {');
  const stopAt = schedulerSrc.indexOf('stopKeepalive(');
  ok(
    '★ stopKeepalive 出现在 finally 块里（异常路径也必须停）',
    finallyAt >= 0 && stopAt > finallyAt,
    `finally 位置=${finallyAt}，stopKeepalive 位置=${stopAt}`,
  );
}

ok(
  '★ hardMaxMs 传的是算式（FETCH_HARD_WAIT_MS + PUSH_HARD_WAIT_MS），不是写死的数字',
  /hardMaxMs:\s*FETCH_HARD_WAIT_MS\s*\+\s*PUSH_HARD_WAIT_MS/.test(schedulerSrc),
  '写死数字 ⇒ 调度器的上限一改，保活就悄悄与它分叉',
);

ok(
  'keepalive.ts 里没有任何 POST 写法（靶子必须是只读 GET —— POST 会真的跑一轮）',
  !/method:\s*['"]POST['"]/.test(keepaliveSrc),
);

ok(
  'fetch-news/route.ts 回显 keepaliveVersion（部署指纹）',
  fetchRouteSrc.includes('keepaliveVersion: KEEPALIVE_VERSION'),
);
ok(
  'fetch-news/route.ts 回显 keepalive 活体状态',
  /keepalive:\s*readKeepaliveStatus\(\)/.test(fetchRouteSrc),
);
ok(
  'push/route.ts 也回显 keepaliveVersion（滚动发布中途两个值不一致 ⇒ 新容器只接管了一半流量）',
  pushRouteSrc.includes('keepaliveVersion: KEEPALIVE_VERSION'),
);

// 常量关系的一致性：这条防的是「有人把间隔偷偷改大，但没改自检的期望」
ok(
  `PING_INTERVAL_MS(${PING_INTERVAL_MS / 60_000} 分) < 平台空闲红线 30 分`,
  PING_INTERVAL_MS < 30 * 60_000,
);
ok(
  `PING_RETRY_MS(${PING_RETRY_MS / 60_000} 分) < PING_INTERVAL_MS`,
  PING_RETRY_MS < PING_INTERVAL_MS,
);
ok(
  `PING_TIMEOUT_MS(${PING_TIMEOUT_MS / 60_000} 分) < PING_INTERVAL_MS`,
  PING_TIMEOUT_MS < PING_INTERVAL_MS,
);

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
