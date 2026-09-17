import { createServer } from 'http';
import { parse } from 'url';
import next from 'next';
import { startScheduler } from './lib/scheduler';
import { resolvePort } from './lib/runtime';

// 修复微信 API 调用的 SSL 证书问题
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// 生产环境判断只看 NODE_ENV（start.sh 会显式设成 production）。
// 旧版还带一个 `COZE_PROJECT_ENV !== 'PROD'` 的条件，是扣子时代的残留：
// 该变量在云托管上根本不存在，结果启动日志永远打一行 "as undefined"。
const dev = process.env.NODE_ENV === 'development';
const hostname = process.env.HOSTNAME || '0.0.0.0';
const port = parseInt(resolvePort(), 10);

// 全局错误处理，防止未捕获异常导致进程崩溃
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Create Next.js app
const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  // 启动定时任务（仅在生产环境）
  if (!dev) {
    startScheduler();
  }
  
  const server = createServer(async (req, res) => {
    try {
      const parsedUrl = parse(req.url!, true);
      await handle(req, res, parsedUrl);
    } catch (err) {
      console.error('Error occurred handling', req.url, err);
      res.statusCode = 500;
      res.end('Internal server error');
    }
  });
  server.on('error', err => {
    console.error('Server error:', err);
  });
  server.listen(port, () => {
    console.log(
      `> Server listening at http://${hostname}:${port} as ${
        dev ? 'development' : 'production'
      }`,
    );
  });
});
