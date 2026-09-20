import { NextRequest, NextResponse } from 'next/server';
import { resolveSelfBaseUrl } from '@/lib/runtime';
import { beijingDate } from '@/lib/utils';

// 内部接口互调的地址，端口口径统一由 lib/runtime 决定。
// 用 localhost 而不是公网域名：既避免 SSL 问题，也绕开网关的请求时长限制。
const API_BASE = resolveSelfBaseUrl();

const POLL_INTERVAL_MS = 5_000;
// 链路上限给足。2026-09-20 实测：抓取一轮（含翻译）要 **75 分钟**，
// 旧值 60 分钟会在抓取还没跑完时就超时，后面几步等于拿着半空的库往下走。
// 和 lib/scheduler.ts 的 FETCH_WAIT_TIMEOUT_MS 保持同一个口径（100 分钟）。
const STEP_TIMEOUT_MS = 100 * 60_000;

interface StepRunState {
  running?: boolean;
  finishedAt?: string | null;
  summary?: unknown;
  error?: string | null;
}

interface PipelineRunState {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  date: string | null;
  push: boolean;
  /** 逐步执行的日志。人工排查「卡在哪一步」直接看这里。 */
  steps: string[];
  error: string | null;
}

// 上一轮流水线的状态，放模块作用域（Next 的路由与自定义服务器同进程）。
//
// 为什么这条链也必须「立即返回、后台跑完」：
// 它串了「抓取 → 日报 → 推送」三个重活，整条跑完远超网关的请求时长上限，
// 手动 curl 公网域名只会拿到 HTTP 504，而且连跑到第几步都看不到。
// 改成异步后 POST 立刻返回 200，进度用 GET 查 lastRun.steps。
let pipelineRunState: PipelineRunState = {
  running: false,
  startedAt: null,
  finishedAt: null,
  durationMs: null,
  date: null,
  push: false,
  steps: [],
  error: null,
};

function now() {
  return new Date().toISOString();
}

/**
 * 等一个「立即返回、后台跑完」的接口真正跑完，并把结果写进日志。
 *
 * 这一步是必须的：/api/fetch-news 和 /api/wechat/push 都是异步接口，
 * POST 返回 200 只代表任务已启动。旧实现直接读响应体的 total_saved / drafts，
 * 拿到的一直是 undefined，日志里写着「采集完成：共入库 undefined 篇文章」——
 * 看着像成功了，其实什么都没读到。这属于「假日志」，比报错更难查。
 */
async function runStep(
  label: string,
  path: string,
  body: Record<string, unknown>,
  log: string[],
): Promise<void> {
  // 读一次步骤状态。
  //
  // ⚠️ 必须取 body.lastRun，不能拿整个响应体当状态用：
  // `/api/fetch-news` 和 `/api/wechat/push` 的 GET 返回的是信封
  // `{ message, usage, sources, lastRun }`，直接当状态用会让
  // `state.running` / `state.finishedAt` 恒为 undefined，完成判据永远为假 ——
  // 表现为「每一步都干等到 60 分钟超时」，日志里只有一行「已触发」，然后就没了。
  // 同一处 bug 在 lib/scheduler.ts 里也踩过（那边表现是定时那轮一直不推）。
  const readState = async (): Promise<StepRunState | null> => {
    try {
      const res = await fetch(`${API_BASE}${path}?cb=${Date.now()}`, { cache: 'no-store' });
      const body = await res.json() as { lastRun?: StepRunState | null };
      if (body && typeof body === 'object' && 'lastRun' in body) {
        return body.lastRun ?? {};
      }
      return (body as unknown as StepRunState) ?? null;
    } catch {
      return null;
    }
  };

  // 先记下此刻的 finishedAt，用它区分「等到的完成」是新一轮还是上一轮的残留状态。
  const finishedBefore = (await readState())?.finishedAt ?? null;

  const triggerRes = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  log.push(`[${now()}] ${label}已触发：${JSON.stringify(await triggerRes.json())}`);

  const deadline = Date.now() + STEP_TIMEOUT_MS;
  const startedWaitingAt = Date.now();
  let polls = 0;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    const state = await readState();
    if (!state) continue;

    polls += 1;
    const finishedNow = state.finishedAt ?? null;

    // 哨兵日志：拿不到 running 说明状态又读错了（信封没拆），必须在日志里看得见。
    if (polls % 24 === 0) {
      log.push(
        `[${now()}] 仍在等待${label}（已等 ${Math.round((Date.now() - startedWaitingAt) / 60_000)} 分钟）：`
        + `running=${state.running} finishedAt=${finishedNow}`,
      );
    }

    if (!state.running && finishedNow && finishedNow !== finishedBefore) {
      log.push(
        `[${now()}] ${label}完成（等了 ${Math.round((Date.now() - startedWaitingAt) / 60_000)} 分钟）：${JSON.stringify(state.summary ?? state.error ?? state)}`,
      );
      return;
    }
  }

  log.push(
    `[${now()}] 等待${label}超过 ${STEP_TIMEOUT_MS / 60_000} 分钟仍未结束，不再等待`
    + `（最后一轮观测：running=${(await readState())?.running}）`,
  );
}

async function processPipeline(
  date: string,
  minPerCountry: number,
  hours: number,
  skipTranslation: boolean,
  pushToWechat: boolean,
): Promise<string[]> {
  const log: string[] = [];

  // Step 1: 采集新闻（异步接口，必须轮询到跑完）
  log.push(`[${now()}] 开始采集新闻...`);
  try {
    await runStep('采集', '/api/fetch-news', { date, minPerCountry, skipTranslation }, log);
  } catch (err) {
    log.push(`[${now()}] 采集失败：${err instanceof Error ? err.message : '未知错误'}`);
  }

  // Step 2: 生成各国日报
  log.push(`[${now()}] 开始生成各国日报...`);
  try {
    const digestRes = await fetch(`${API_BASE}/api/daily-digest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date, minPerCountry }),
    });
    const digestResult = await digestRes.json() as Record<string, unknown>;
    const digests = digestResult.digests as Array<unknown> | undefined;
    log.push(`[${now()}] 日报生成完成：${digests?.length || 0} 个国家`);
  } catch (err) {
    log.push(`[${now()}] 日报生成失败：${err instanceof Error ? err.message : '未知错误'}`);
  }

  // Step 3: 推送微信公众号草稿（可选）。period 固定为 manual —— 流水线是人工补跑入口，
  // 草稿标题带「补报」后缀，才和当天自动跑的早报/晚报区分得开（不带后缀会和上一次
  // 人工补跑完全同名，草稿箱里出现两份同名草稿）。
  if (pushToWechat) {
    log.push(`[${now()}] 开始推送微信公众号草稿（按国别分组）...`);
    try {
      await runStep('公众号推送', '/api/wechat/push', { hours, period: 'manual' }, log);
    } catch (err) {
      log.push(`[${now()}] 公众号推送失败：${err instanceof Error ? err.message : '未知错误'}`);
    }
  }

  return log;
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const date = (body.date as string) || beijingDate();
  const pushToWechat = body.push === true;
  // 与定时任务保持一致的合理默认：每国≥15篇、推送过去 24 小时
  const minPerCountry = typeof body.minPerCountry === 'number' ? body.minPerCountry : 15;
  const hours = typeof body.hours === 'number' ? body.hours : 24;
  const skipTranslation = body.skipTranslation === true;

  // 同一时间只允许跑一轮：并发跑会重复抓取、重复调翻译，还可能建出重复草稿。
  if (pipelineRunState.running) {
    return NextResponse.json({
      success: true,
      message: '上一轮流水线仍在进行，本次跳过（不重复触发）',
      running: true,
      startedAt: pipelineRunState.startedAt,
    });
  }

  const startedAt = now();
  pipelineRunState = {
    running: true,
    startedAt,
    finishedAt: null,
    durationMs: null,
    date,
    push: pushToWechat,
    steps: [],
    error: null,
  };

  // 立即返回，后台异步处理
  processPipeline(date, minPerCountry, hours, skipTranslation, pushToWechat)
    .then((steps) => {
      pipelineRunState = {
        running: false,
        startedAt,
        finishedAt: now(),
        durationMs: Date.now() - new Date(startedAt).getTime(),
        date,
        push: pushToWechat,
        steps,
        error: null,
      };
    })
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error('后台流水线执行失败:', err);
      pipelineRunState = {
        running: false,
        startedAt,
        finishedAt: now(),
        durationMs: Date.now() - new Date(startedAt).getTime(),
        date,
        push: pushToWechat,
        steps: pipelineRunState.steps,
        error: message,
      };
    });

  return NextResponse.json({
    success: true,
    message: '流水线已启动，后台处理中（用 GET 查 lastRun.steps 看进度）',
    date,
    push: pushToWechat,
    hours,
    minPerCountry,
    startedAt,
  });
}

export async function GET() {
  return NextResponse.json({
    message: '每日新闻处理流水线',
    usage: 'POST /api/pipeline with { date?: "YYYY-MM-DD", push?: false, hours?: 24 }',
    steps: [
      '1. 从 RSS 源采集中亚与南高加索五国新闻',
      '2. LLM 翻译为中文并分类',
      '3. 按国别生成投资资讯日报',
      '4. (可选) 推送到微信公众号草稿箱',
    ],
    // 上一轮流水线的状态与逐步日志。整条链跑完远超网关的请求时长上限，
    // 所以 POST 只代表「已启动」，进度和结果都从这里读。
    lastRun: pipelineRunState,
  }, {
    // 必须禁掉缓存，否则读到的永远是启动那一刻的快照。
    headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
  });
}
