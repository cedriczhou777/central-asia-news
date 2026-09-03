# 微信云托管部署指南

## 前置条件

1. 已开通微信云托管服务
2. 已开启云调用功能
3. 已添加接口路径：
   - `/cgi-bin/draft/add`
   - `/cgi-bin/material/add_material`

## 部署步骤

### 1. 在微信云托管创建服务

1. 登录 [微信公众平台](https://mp.weixin.qq.com/)
2. 进入 **设置与开发** → **微信云托管**
3. 点击 **新建服务**
4. 填写服务名称：`central-asia-news`

### 2. 配置环境变量

在云托管控制台 → **设置** → **环境变量** 中添加：

| 变量名 | 值 | 说明 |
|--------|-----|------|
| `WECHAT_APP_ID` | `wxe8aafd263a7d6a8c` | 公众号 AppID |
| `WECHAT_APP_SECRET` | `af0d77688688178c85dab4ad8cc5ca6d` | 公众号 AppSecret |
| `USE_WECHAT_CLOUD_CALL` | `true` | 启用云调用 |
| `WECHAT_CLOUD_KEY` | (留空) | 云调用密钥（如需要） |
| `NEXT_PUBLIC_SUPABASE_URL` | (你的 Supabase URL) | 数据库地址 |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | (你的 Supabase Key) | 数据库密钥 |
| `COZE_API_TOKEN` | (你的 LLM Token) | LLM 翻译用 |

### 3. 上传代码

**方式一：Git 仓库（推荐）**
1. 将代码推送到 Git 仓库（GitHub/GitLab）
2. 在云托管控制台选择 **从 Git 仓库部署**
3. 填写仓库地址和分支

**方式二：本地上传**
1. 在项目根目录执行：
```bash
# 打包代码
tar -czf deploy.tar.gz --exclude=node_modules --exclude=.next --exclude=.git .

# 在云托管控制台上传 deploy.tar.gz
```

### 4. 配置定时触发器

在云托管控制台 → **触发器** → **创建触发器**：

| 触发器名称 | Cron 表达式 | 说明 |
|-----------|------------|------|
| `morning-fetch` | `0 0 * * *` | 每天 08:00 (UTC) |
| `noon-fetch` | `30 4 * * *` | 每天 12:30 (UTC) |
| `afternoon-fetch` | `0 7 * * *` | 每天 15:00 (UTC) |
| `evening-fetch` | `0 13 * * *` | 每天 21:00 (UTC) |

**注意**：Cron 表达式使用 UTC 时间，北京时间 = UTC + 8

### 5. 配置数据库

如果使用 Supabase：
1. 在 Supabase 创建项目
2. 执行 `src/storage/database/shared/schema.ts` 中的建表语句
3. 将连接信息填入环境变量

### 6. 验证部署

部署完成后：
1. 访问云托管提供的域名，确认网页正常显示
2. 手动触发一次定时任务，检查日志
3. 查看微信公众号草稿箱，确认收到推送

## 常见问题

### Q: 云调用失败怎么办？
A: 检查：
1. 云调用功能是否已开启
2. 接口路径是否已添加
3. `USE_WECHAT_CLOUD_CALL` 是否设为 `true`

### Q: 定时任务不执行？
A: 检查：
1. 触发器是否已启用
2. Cron 表达式时区是否正确（UTC）
3. 查看云托管日志排查错误

### Q: 网页访问慢？
A: 在云托管控制台调整：
1. 增加实例数量（`minNum`）
2. 选择更高配置（CPU/内存）

## 费用说明

微信云托管按量计费：
- **计算资源**：约 ¥0.00013/秒（2核2G）
- **定时任务**：免费
- **流量**：约 ¥0.8/GB

**预估月费**：¥50-100（根据访问量）

## 后续优化

1. **添加监控** - 配置云监控告警
2. **日志分析** - 使用云托管日志服务
3. **自动扩缩容** - 根据流量自动调整实例数
4. **CDN 加速** - 静态资源使用 CDN
