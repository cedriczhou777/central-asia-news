# Plan B 采集、证据和签审规则

`plan-b-editorial-2` 从 2026-11-27 刊期起适用。按北京时间 [D−1 06:00, D 06:00) 采编。每国正常 15–20 条，有高价值合格稿继续处理，最多 20 条。经覆盖、深度和候选处理核查后可独立审批 8–14 条，6–7 条只用于真实供给不足。不到 6 条时保留成果和短缺原因，正式投递闸门拒绝提交。

## 云端准备

- 注册表保留原机构和媒体家族。验证发现入口、公开文章、实际刊时和首次披露分别记账。列表首轮按独立来源轮转。初始每源 4 页、24 篇正文，列表时间预算占 40%，3 个线程，同域 1 个请求。高产来源可多取 3 页、12 篇正文。只依照卡片和当期证据加深翻页，普通积压保留游标和覆盖缺口。未核实的重要正文仍阻断对应国家的最终冻结。
- RSS、Atom、新闻 Sitemap 和标准 JSON Feed 用于发现 URL，最终正文及刊时仍以绑定的原始文章证据为准。HTTP 403 停止重复请求。同域 URL 消重用已验证的文章身份。相似标题及跨站正文哈希匹配只给同事件提示，避免吞掉时间或关键事实变化。
- `evidencePacket` 附完整原文的归档成员名和哈希、最终及 canonical URL、发布及更新时间原值、字段、精度、IANA 时区、显示图片线索、数字与实体原文定位。机器提取只作定位。无时区的明确本地时分可使用注册的 IANA 时区，日级、冲突和模糊时间留待核实。

## 现有 Work 任务的编辑指令

使用同一个任务和现有作者、独审身份。先核对当天线上 health 的实现指纹和 `editorialPolicy.version`。分国读当前冻结清单，按来源、题材和事件分批读取 `evidence`。候选正文用 `originals` 按 ID/sourceHash/revision 分批读取，每批至多 5 条。对计划采用或仍有重要疑点的文章审核完整正文。作者和独审共用同一份不可变原文。作者结论由独审独立判断。

适用新策略时，冻结清单必须带 `sourceEvidenceVersion=source-evidence-2`。`db_handoff.py` 会把证据版本加入原文数据库记录键，防止同刊旧版记录混入。对每批原文使用 `verify-original --issue D` 校验。原文缺失或与清单不符时保留待核，等待云端出具同版材料。

纳入所有符合日报价值的经济、工商、投资、金融、能源、工业、基建、交通、税收、法律、政策、政府活动、外交、农业、就业、医疗、教育、社会、民生、环境、安全和重大体育报道。普通体育和娱乐花边不采用。关键词仅用于云端优先排序。遇到翻译、数字单位、标题或次要细节瑕疵，修正正文或移除缺证细节。鉴别同事件的转载与融资、签约、开工等确有新事实的阶段。

独审提交包含 `review.policyVersion=plan-b-editorial-2`。每个最终候选 ID 都在 `candidateDecisions` 留下一条具体理由和状态，并填入冻结的 `sourceHash`、`revision` 及本次独审的 `reviewedBy`。

| editorialState | decision | 随附证据 |
| --- | --- | --- |
| selected / revised | selected | 原始披露或实质新增事实的原文、链接和证据 |
| pending_source_check / pending_time_check | pending | 待核的来源、刊时或事实，可恢复 |
| rejected_old | rejected | `priorPublicationEvidence` 含链接、带时区的早期时间、证据和 `noNewFacts=true` |
| rejected_duplicate | rejected | `duplicateOf` 对应本刊冻结 ID，保留事件及新增事实差异 |
| rejected_false | rejected | `contradictionEvidence` 含证据链接和具体矛盾 |
| rejected_irrelevant | rejected | 说明选题不适合日报的具体原因 |
| unselected_priority / unselected_capacity | rejected | 分别自 15 条和满 20 条后使用，记录比较及容量 |

采用条目填写 `firstDisclosureVerified` 与 `firstDisclosureEvidence`，用可靠当期原始披露、原创采访或可靠的新阶段事实证明本期价值。当期披露证据足以支持采用。无法确认这一证据或临近窗口边界的刊时仍存疑时，标记待核。候选刊时冻结为待核时，独审采用必须填写 `publicationTimeResolution`，匹配冻结条目 `publicationOptions` 中实际归档的证据 SHA、链接和带时区时间，并绑定正文 SHA 与 revision。冻结清单外的新证据交由云端绑定，下次冻结后重新核对。相似事件若分开采用，填 `eventGroup`、`eventPhase`、`newFact`。同刊同事件同阶段只能保留一份。

同篇精确刊时存在冲突时继续待核。不同来源字段经时区转换指向同一瞬间可以一起作为证据。

15 条以下还需现有独立 `quantityExceptionReview` 和覆盖审查。8–14 条使用 `tier=verified_shortfall`，6–7 条使用 `tier=minimum_fallback`。例外需填写 `finalHash`、`candidateInventoryReviewed`、`reviewer`、`reviewedAt`、短缺原因及实际来源证据，解释来源覆盖、采集深度和待核工作。协调者依原 CAS 更新合并检查点。只有原文、刊时证据、新来源、事实冲突或作者修改发生变化时才重新核查相关内容。

## 记录和发布

- `db_handoff.py funnel` 只读返回分国最终采集漏斗和签审状态。来源数据包含逐列表页新闻链接数、正文成功及解析失败、非文章响应、HTTP 失败、窗口合格、窗外和刊时不明。未完成记录保留在采集归档。分国最终交付以同版 Word 和微信真实回读为准。
- `db_handoff.py weekly-funnel` 汇总过去 7 刊期的覆盖、来源可用性、解析和采用排名。只统计已有记录，以观测天数和审稿天数标明分母。新闻题材空白和 AI 误退由抽查覆核确认。
- 每次交接核对是否重复读取、重复搜索、同稿重复判断或单条失败重跑整国。先批量分类和编辑，复用检查点和同一份正文证据。原文、关键事实或刊时证据有变化时，集中复核受影响的条目。
- 缺图允许交正文，使用同一国家最靠前的合格原图作封面，保留重要新闻的签审顺序。仅有 OG 元数据的图片保留为待核线索，实际图片仍由云端验证字节及哈希。
- 生产部署和现有唯一任务指令应在同一变更窗口完成，并回读当天 health 的实现指纹和策略。回退时一起恢复此前运行镜像和任务指令。代码合并、健康状态、封包受理或模拟回读均不足以计为正式投递。
