# 审定稿包投递上线步骤

当前分支代码需先建表再部署。不要把本文件当作已部署回执。

## 一次性数据库准备

1. 登录 Supabase，打开当前服务使用的项目（与云托管 SUPABASE_URL / COZE_SUPABASE_URL 对应）。不要复制任何密钥到聊天。
2. 左侧 SQL Editor → New query。
3. 粘贴并执行 migrations/20261108_reviewed_packages.sql 全文。脚本使用事务、IF NOT EXISTS，不删除或修改 articles 历史文章。
4. 确认成功。新建 reviewed_packages（完整五国包）、reviewed_deliveries（逐国投递回执）；push_runs 不存在时补建。已有 push_runs 不改结构，部署前须确认字段符合脚本。
5. 云托管必须配置具有 service_role 权限的 SUPABASE_SERVICE_ROLE_KEY。只在控制台配置，不发到聊天、仓库或日志。

## 部署

1. 通过分支测试和代码检查后合并 main。main 自动部署 webhook 曾连接失败，不能把 GitHub push 成功当作云端上线。
2. 如未自动构建，在云托管部署发布 → 发布 → 执行流水线。仓库 cedriczhou777/central-asia-news，main，Dockerfile，端口3000。
3. 记录真实构建提交、服务版本、部署日志；服务启动日志应显示按北京时间当刊期完整稿包投递，不再显示08至08为采编窗口。
4. 维持05:50–09:30定时扩容；确认平台时区。08:00 cron 使用 Asia/Shanghai。错过08:00不自动回补；经授权调用补投并指定精确 version，持久记录防重。

## 接收与验收

- 先带鉴权 POST /api/word-package 空对象。400缺version是接口可达且鉴权通过；不证明数据库建表完成。
- 只提交已完成独立审稿的真实稿包。五国原子保存，回执inserted=5；同内容重试duplicate=true/skipped=5。核对返回contentHash及版本。
- 数据库物理行数：一个完整稿包行，五个分国投递行。不能按旧articles的五行或新闻总条数验收。
- GET /api/wechat/push?version=精确版本（同鉴权）查看packageReceived、draftsVerified及byCountry。
- 每国回执含输入/转存/回读哈希、图片数、media_id。state=succeeded才是回读校验通过；人工仍须检查微信版式及可编辑性。
- POST /api/wechat/push 返回202仅代表开始。默认仅选当刊期最新修订；指定version可补交前期，绝不为了“今天推送”改刊期。
- USE_WECHAT_CLOUD_CALL=true沿用云调用；false走标准HTTPS stable_token。标准模式如遇IP白名单错误，在公众号设置核对出口IP，不关闭TLS校验。

## 故障与重试

- failed：尚未发送draft/add，可以同版本重试。
- sending/uncertain且有media_id：同版本重试只回读核验已有草稿，不创建第二份。
- sending/uncertain且没有media_id：可能已在微信创建成功，禁止自动重复创建。人工查草稿及日志后再决定恢复。
- preparing长时间停滞：可能进程中断。确认没有仍运行的进程及draft/add后才人工恢复为failed；不可按时间自动解锁。
- 图片403/超时或解码失败：该国不创建草稿，记录failed，不能静默丢图。修订正文URL须新修订版本，不能同版本覆盖。
- 多实例或重复请求用数据库唯一键保护，每版本每国最多一次处于建稿请求阶段。
- 新旧稿件不混用。旧word-ingest代码保留，但其输出不会直接进入审定稿投递。需要分国输入时先汇总成审定五国JSON。
- 如回滚旧225代码，旧路径缺少这些防重保证，禁止在结果不明时手动再推。

## 本地验证

- 完整verify:offline各子检查（受环境限制tsx CLI无法建立IPC，使用node --import tsx运行同一脚本）。
- 新增test:reviewed-package：版本隔离、HTML保留、图片故障、回读恢复、并发锁、防重。
- 新增test:reviewed-ingest：鉴权、空包探测、五国原子接收、相同重试、内容冲突、修订。
- 尚需上线后真实数据库/微信验证。离线通过不能证明真实图片转存或草稿已生成。
