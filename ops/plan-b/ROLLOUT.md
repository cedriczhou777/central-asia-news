# 中亚动态日报方案 B 上线核对

> 当前11月22日补交已完成，下一刊期为11月23日。队列策略v2、受阻缓存只读、检查点基准哈希及有界恢复以根目录`PLAN_B_QUEUE_RECOVERY_2026-11-22.md`为准；以下部署顺序中的历史切换日期不覆盖用户最新设置。

生产切换涉及现有微信云托管服务和同一条 Work 日报。程序的默认状态保留现行调度。方案 B 启用后，云端使用一个调度入口，Work 负责选题、中文撰稿、独立审稿和必要修订。

## 部署顺序

1. 保留当前云托管版本、旧 Work 时间和任务配置。确认生产库无在途微信写入后，将审查过的提交合并到 main，使用现有流水线和根目录 Dockerfile 构建。在构建参数写入该次 main 的 BUILD_GIT_SHA，并以线上回读核对。
2. 发布预检版本时设 REVIEWED_PLAN_B=0 和 REVIEWED_PLAN_B_CHECKS=1，沿用现有 06:10 Work 和旧恢复任务。云端复用 INGEST_SECRET，已设置专用 PLAN_B_INGEST_SECRET 时采用专用密钥。Work 侧用受保护的 CENTRAL_ASIA_INGEST_SECRET 或 INGEST_SECRET。
3. 从同一 Work 执行环境运行 work_client.py health --verify。核对最终提交、状态表、私有存储桶和 Python 渲染模块。用品质代表性的少量来源分别验证普通网页、原图 CDN 和重要社会媒体的云端可达性。保持预检为只读。
4. 核对现有规则为北京时间 04:45–09:30，扩容至 1 个实例，最小 0，最大 1，规格 0.25 核与 0.5 GB，端口 3000。保留已符合要求的设置。
5. 确认当天无在途写入后启用 REVIEWED_PLAN_B=1，把 REVIEWED_PLAN_B_FIRST_ISSUE 设为 `2026-11-22`。生产启用验证通过后，将现有唯一日报改为 05:30。校对两套设置的生效状态、实际镜像 SHA、调度注册和下次运行时间。

## 单次 Work 交接

### 覆盖结束与独立确认（plan-b-coverage-1）

冻结清单的哈希包含 coverage。readableSources 仅包含实际完成正文入口解析的最终窗口观察；gaps 区分拒绝、不可解析响应、实际累计三次传输后耗尽的重试，以及有界采集未触达的登记来源。未触达不等于无法访问，更不计为成功。现有三个全文发布方、八个媒体家族实际尝试和三个机构类型实际尝试的数量校验继续执行。

pendingWork 是硬阻断，包含未完成的最终增量、正文队列、待抓正文线索及无法对账的预算/队列；清空 pendingSources 不能绕过。真实文章与原始新闻线索始终不能仅因条数足够而关闭。

有证据达到当前扫描或分页预算时，可以冻结待审候选版本，但未取完的入口/分页仍在 queues 和 reviewWork 中，不能标成已完成。独审必须在 review.coverageReview 中提供 status=verified、与独审相同且不同于作者的 reviewer、真实 reviewedAt、finalHash、sourceIdsReviewed，以及 policy/energy/investment/business 四项 criticalTopicsReviewed。gapResolutions 必须逐来源解释，列出冻结池内真实 alternativeCandidateIds；reviewWork 涉及的每个地址须列入 deferredUrlsReviewed。所有条目仍需逐条独审，15条本身不完成覆盖验收。

10—14条仍需现有 quantityExceptionReview 及必要的 discoveryReview、实际来源证据和未决任务关闭证据；缺少真实稀缺审核不能提交。准备Word/微信前会从不可变缓存重新计算 coverage，与冻结证明逐字哈希比对，再跑现有质量闸。故障和交接按国家保存，某国阻断不阻止其他国家继续。

只读 health?verify=1 会运行无网络、无模型的固定覆盖夹具，返回 coveragePolicyVersion 与 coverageVerification，并继续检查原有状态表、私有存储和渲染模块。此结果证明部署中的判定代码生效，不代替实际五国供稿验收。

- 使用 work_client.py manifest 按国读取 05:30 已有的快照。晚到时优先读取冻结清单。originals 每批最多五条，绑定清单哈希。主任务准备材料，分别由一名撰稿者和另一名独审者阅读实际原文。
- 06:00 开始云端冻结补搜，Work 在同一次运行使用 changes 查询增量。新增或变化内容进入编审。已检查且修订哈希一致的内容沿用原签审。对暂缺来源保留待处理事实，云端重试到上限后在状态中记录缺口。
- 每个国家有冻结哈希及完整候选 ID 对账后，使用 submit 单独提交。署名、原文哈希、候选修订、初稿哈希、独审签审哈希和时间窗均需一致。原文、图片和 Word 的传输与格式加工由云端完成。
- 到 09:00 停止提交和新草稿写入。到 09:30 前仍可核验已发起的草稿并保存回执。运行记录使用 status，Word 使用 word 获取临时下载链接。

## 回退

在库有活动微信请求时先等待回执，记录刊期及国家状态。回退到原云托管镜像、原扩缩容规则以及原有 06:10 Work 配置，或在候选镜像关闭 REVIEWED_PLAN_B。保留已存 Word、签审稿及草稿回执。对结果不确定的微信请求先对账。

## 2026-11-21 生产失败整改

已交付的11月21日五国稿件不进入方案B，代码最早支持刊期改为2026-11-22。切换前保持原06:10任务；先部署、只读核验实际运行版本和依赖，再由用户设置三项启用变量，回读通过后才改唯一Work时间。

平台completed仅表示一次执行结束。`status`的`business.businessSucceeded`仅在五国冻结候选、独立签审、封包、有效Word对象及实际微信回读证据全部齐备时为true；正常15–20条与已通过稀缺例外分别记录。08:00后未交付、09:00后逾期通过同一个云端调度器写轻量结构化告警；迟启动或重启也补报当前真实状态，无模型或第二条Work日报。

作者与独审在同一次Work中按国接续。每批形成真实进展后，用`work_client.py checkpoint --contract PRIVATE --issue D --country C --hash SNAPSHOT_HASH --stage draft|review --document FILE`保存检查点。检查点位于现有私有桶、以SHA命名，指针通过CAS附在原来源行，原候选快照及缓存不改动；它不创建editorial签审或交付记录。恢复时用同一命令去掉`--document`读取，随后通过changes对账新冻结版本，仅重审新增/改变内容。完整独审通过即用submit单国交接，云端独立推进Word和微信，其他国家不等待。

只读health暴露activation三项实际值、运行策略版本、覆盖策略及验证结果。Work连接只使用受控变量或已有0600私有契约，不在命令参数、代码、稿件、子智能体或公开日志中放密钥。实际模型与Work Credits无平台证据时为unknown。

## 首次生产的提交与图片缺口

发现器的候选默认仍需语义及首披审核。正式提交前，独审稿须以`review.candidateDecisions`逐个记录冻结候选的采用/排除、具体理由、真实审核身份/时间及来源哈希、修订；采用稿另须真实首披确认和证据。仅接口受理成功不能证明后续原文复验、数量闸、封包及Word已完成。

原文仅有图片元数据线索、尚不能确认实际展示时，记录`sourceImage.status=unavailable`及`candidateEvidence=metadata_only_unconfirmed`，保留具体原因和页面证据检查记录；不使用该图片、不称原文无图，也不因此丢弃已签审正文。已确认原图继续走原有字节、哈希及私有存储校验。线上`health --verify`的`coverageVerification.releaseImplementationSha256`用于回读实际封包实现。
