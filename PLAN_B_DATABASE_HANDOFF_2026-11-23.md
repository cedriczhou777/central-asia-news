# 11月23日生产故障后的单批整改

11月23日48条、Word与五国已成功草稿保持不变。没有新取源、模型API调用或微信测试写入。

## 正式数据库交接

Work只使用已授权Supabase连接器执行SQL，不再把被站点策略拒绝的CloudBase地址作为日报入口。
这是用户授权的新数据库交接，不是HTTP代理或转发。旧HTTP接口仍保留鉴权，禁止为测试403重复请求。

唯一新增表为`public.plan_b_exchange`，RLS启用；anon和authenticated无读写授权。
cloud service_role与当前已授权管理连接器按各自既有身份操作，不在Work提示词保存数据库或云端密钥。

- `manifest`保存快照，`original`按`id/sourceHash/revision`保存未删节正文、刊时、来源和证据。
- Node从云端本次已有缓存流式导出原文，逐条复验正文SHA，不重复抓取；先原文齐备再发布manifest。
- Work用`ops/plan-b/db_handoff.py`生成有界SQL，再交给连接器执行。每批原文最多5条。
- 作者和独审只返回内容，协调者是唯一检查点写入者。先读已保存命令及`plan_b_daily`指针，合并两方成果，带`baseCheckpointHash`保存。
- `checkpoint`与`submission`是不可覆盖命令，确定性内容hash作幂等键；不是ready/succeeded状态。
- 云端每分钟领取最多5项，租约5分钟、最多3次；逐国错误隔离。失败仍保留完整payload与真实原因。
- `applyPlanBCommand`为HTTP与数据库共用的正式窗口、冻结、哈希、候选决策、独审和CAS校验。
- 云端正式签审入库后按原有逐国release、Word、微信与回读推进；Work退出不影响已签审国家。
- Word真实字节按256KB分块及SHA另存私有`word`记录；Work每批最多5块读取base64、合并复验SHA并保存交付，不依赖Storage整包下载。
- `health`由真实云端启动/运行代码写入，含版本、20个实现文件指纹、开关、firstIssue、注册及业务状态。
  它不是HTTP200证明。没有新部署健康记录时不能宣称线上验收通过。

常用命令（只生成SQL，不自行联网）：

```sh
python ops/plan-b/db_handoff.py health --issue 2026-11-24
python ops/plan-b/db_handoff.py manifest --issue 2026-11-24 --country kz --phase final
python ops/plan-b/db_handoff.py originals --issue 2026-11-24 --country kz --ids ID/SOURCEHASH/REVISION
python ops/plan-b/db_handoff.py commands --issue 2026-11-24 --country kz
python ops/plan-b/db_handoff.py checkpoint --issue 2026-11-24 --country kz --document merged-checkpoint.json
python ops/plan-b/db_handoff.py submit --issue 2026-11-24 --country kz --document signed-handoff.json
python ops/plan-b/db_handoff.py word --issue 2026-11-24 --country kz
```

manifest要与`plan_b_daily`真实state及hash对账。blocked材料仅可用于作者稿、局部独审和检查点。
不得在数据库直接修改plan_b_daily、reviewed_packages、reviewed_deliveries来绕过正式闸门。
queued/accepted及平台completed均不代表Word与微信真实回读齐备。

## 凭据与当前限制

旧客户端只从`CENTRAL_ASIA_INGEST_SECRET`读取值，禁用`INGEST_SECRET`回退及私有凭据JSON。
此变量目前未在本次Work环境检测到，旧密钥轮换也未获确认。数据库连接器认证独立于这个HTTP密钥；
数据库交接不要求把CloudBase密钥复制进聊天。云端健康中的凭据配置标志可比对PlanB/INGEST配置，
只有受保护变量确实到达任务时，才能进行本地HMAC匹配；不得打印值。

官方文档的Personal vault属于Codex Cloud，不能假定本Work任务已绑定或会自动继承。
已有任务保留原状态。不存在已验证入口时，凭据及真实HTTP health验收保持未通过，不反复等待。
站点安全策略不能由密钥轮换自动解除，也不允许代理、换域名或间接请求被拒绝接口。

## 冻结与真实回归

现有普通发现分类必须有预算结束证据，并转入带queueHash的reviewWork及coverage.gaps，不是completed。
银行目录、明确静态目录和历史URL提示不再直接占满正文采集预算；日期URL只是审核线索，不是发布时间证明。
明确重要线索、真正未完成正文、无身份队列或真实增量仍硬阻断；不删除pendingWork或伪造coverageReview。
来源最终观察预算耗尽记录实际观察缺口，由独立覆盖审核决定是否充分。

真实夹具在用户私有验收存档保留；包含当日全部pending身份和前日按原因有界抽样。
仓库为公开仓库，不提交原始生产队列、原始状态或生产派生夹具。
授权回归通过`PLAN_B_REAL_QUEUE_FIXTURE`指向私有本地文件，公开CI没有此文件时明确跳过真实数据项，不能冒称已验证真实生产。
5项真实队列/Python回归、17项关联覆盖测试、数据库交接编排、原文hash、CAS、幂等、
09:00窗口和原有检查点/接口/覆盖TS测试已通过。未宣称历史五国全部冻结ready。
仍有队列需要进一步证据判断（包括缺来源观察）。具体私有统计保留于验收报告。
不能把它们全认定为重要新闻或清空，也不能把分类测试当作次日产量保证。

## 一次性人工补交

保留PlanB刊期保护。未来须在私有表创建`manual_authorization`记录，限定issue、version、
规范化contentHash、countries、issuedBy、明确reason及expiresAt（创建后最多24小时）。
必须取得该期用户授权，自动日报不得自行签发。record_key是16至96位授权ID，content_hash为payload规范化SHA。
原POST接口另带`X-Manual-Authorization`。每次受理核对期限、刊期、版本、正文hash及国家范围，
使用记录写入`manual_use`；不存在、过期或范围不符仍返回409。原投递版本锁及不明结果对账规则保留。

## 上线与回退

只新增一张私有表和一个受限领取函数；不改旧业务记录或服务器规格、扩容及唯一05:30任务。
数据库迁移已执行，真实已保存原文在service_role下完成写入/读取/正文SHA断言并整事务回滚，测试行不留存。
构建采用现有Docker流程的裁剪和Next生产构建，隔离目录执行，不修改仓库旧路由。
回退代码不会破坏新表，可保留数据待修复，禁止删除历史回执或恢复提示词明文密钥。

尚未确认的上线条件必须在最终报告中列出：云托管实际部署/指纹、任务环境凭据绑定及轮换、
首期真实原文流与签审命令被线上消费、外部新闻是否充分。
没有独立手机/邮件提醒连接；仅数据库和云端日志告警，`userNotified=false`。不能宣称已主动通知用户。
Work Credits为unknown，不额外调用模型计量。
