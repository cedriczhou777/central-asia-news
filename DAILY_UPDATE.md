# 每日自动更新方案

## 概述
本系统支持每日自动采集中亚五国新闻，翻译为中文，生成各国日报，并推送到微信公众号草稿箱。

## 定时任务时间表（北京时间 UTC+8）

| 时间 | 说明 |
|------|------|
| 08:00 | 早间新闻采集 |
| 12:30 | 午间新闻采集 |
| 15:00 | 下午新闻采集 |
| 21:00 | 晚间新闻采集 |

## 手动执行

### 1. 仅采集新闻（不推送）
```bash
./scripts/daily-fetch.sh 10 false
```

### 2. 采集并推送到微信
```bash
./scripts/daily-fetch.sh 10 true
```

### 3. 通过 API 调用
```bash
curl -X POST http://localhost:3000/api/pipeline \
  -H "Content-Type: application/json" \
  -d '{"limit": 10, "autoPush": true}'
```

## 自动执行方案

### 方案 A：Node.js 调度器（推荐）

启动定时任务调度器：
```bash
pnpm scheduler
```

或使用 pm2 保持后台运行：
```bash
pm2 start scripts/scheduler.js --name daily-news-scheduler
pm2 save
pm2 startup
```

调度器会在以下北京时间自动执行：
- 08:00, 12:30, 15:00, 21:00

### 方案 B：Linux Cron Job

编辑 crontab：
```bash
crontab -e
```

添加每日执行任务（北京时间）：
```cron
0 0 * * * cd /workspace/projects && ./scripts/daily-fetch.sh 10 true >> /tmp/daily-fetch.log 2>&1
30 4 * * * cd /workspace/projects && ./scripts/daily-fetch.sh 10 true >> /tmp/daily-fetch.log 2>&1
0 7 * * * cd /workspace/projects && ./scripts/daily-fetch.sh 10 true >> /tmp/daily-fetch.log 2>&1
0 13 * * * cd /workspace/projects && ./scripts/daily-fetch.sh 10 true >> /tmp/daily-fetch.log 2>&1
```
ExecStart=/workspace/projects/scripts/daily-fetch.sh 10 true
```

创建 timer 文件 `/etc/systemd/system/daily-fetch.timer`：
```ini
[Unit]
Description=Run daily fetch every day at 8:00

[Timer]
OnCalendar=*-*-* 08:00:00
Persistent=true

[Install]
WantedBy=timers.target
```

启用 timer：
```bash
sudo systemctl enable daily-fetch.timer
sudo systemctl start daily-fetch.timer
```

### 方案 C：GitHub Actions

创建 `.github/workflows/daily-fetch.yml`：
```yaml
name: Daily News Fetch

on:
  schedule:
    - cron: '0 8 * * *'  # 每天 8:00 UTC
  workflow_dispatch:  # 允许手动触发

jobs:
  fetch:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Call Pipeline API
        run: |
          curl -X POST "${{ secrets.API_URL }}/api/pipeline" \
            -H "Content-Type: application/json" \
            -d '{"limit": 10, "autoPush": true}'
```

## 微信公众号配置

### 环境变量
在 `.env` 文件中配置：
```env
WECHAT_APP_ID=your_app_id
WECHAT_APP_SECRET=your_app_secret
```

### IP 白名单
由于云环境出口 IP 不固定，需要：
1. 使用固定 IP 的服务器部署
2. 或使用固定 IP 代理
3. 或暂时关闭 IP 白名单（不推荐生产环境）

## 日志查看

```bash
# 查看采集日志
tail -f /tmp/daily-fetch.log

# 查看应用日志
tail -f /app/work/logs/bypass/app.log
```

## 故障排查

### RSS 源 404 错误
部分 RSS 源可能失效，检查 `src/app/api/fetch-news/route.ts` 中的 RSS_URLS 配置。

### LLM 翻译失败
翻译链路是「智谱 → DeepSeek」多通道降级，检查：

1. 环境变量里有没有 `ZHIPU_API_KEY`（`COZE_API_TOKEN` 已废弃，换掉了）
2. 智谱控制台的余额/配额。返回 **429** 就是欠费或超出免费档限制
3. 用 `pnpm test:translate` 本地打一次，日志会打出每个通道的尝试与失败原因
4. 翻译失败时文章会被**丢弃而不是以原文入库**，所以表面现象是
   「候选有 N 篇，实际入库 0 篇」，而不是公众号里出现英文

### 微信推送失败
1. 检查 AppID/AppSecret 是否正确
2. 确认 `USE_WECHAT_CLOUD_CALL=true`，云调用功能已开启，且接口路径已添加
   （`/cgi-bin/draft/add`、`/cgi-bin/material/add_material`）
3. 查看日志中的错误信息

> 走云调用**不需要 IP 白名单**，也**不需要配置 access_token**——
> 由微信云托管侧拦截 `api.weixin.qq.com` 完成鉴权。
> 这也是当初选择留在云托管的原因（固定出口 IP 问题被绕开了）。
> 代价是：**本地永远推不出去**，推送只能在云上验证。
