# 成稿归档和直接取稿

2026-11-04：修复“助手有代码却取不到实际推送正文”的缺口。取稿不需要模型API，也不需要进入微信后台。

## 保存什么

正式交付前，程序把即将发送的完整微信请求稿、排版正文的SHA256、逐篇最终译稿、完整已存原文、来源、文章ID、审稿记录、选稿窗口和构建身份写入现有`push_runs`表。每次尝试使用独立的`artifact:v1:日期:国家:随机ID`主键；`latest`仍用于原有进度记录，换实例、下一轮覆盖latest或同日重跑都不覆盖旧成稿。

先成功归档，再请求微信。归档失败则该国暂缓交付并明确报错。原说明中“push_runs可选”的说法不再适用于新版本正式交付；原有表需允许读写新ID范围，无需新建表或新增列。

交付状态分三种：`prepared`表示请求前成稿已留存，不能据此断言微信未收到；`submitted`表示微信已返回草稿ID；请求中断或出错为`delivery_unconfirmed`。微信返回成功但回执更新失败时，原始prepared成稿仍可取回，运行摘要报告`statusPersisted=false`。不能盲目补推来消除不确定状态。

这里保存的是发送时版本。用户以后在微信编辑器手改的内容不会自动反向同步。预览仍不写生产进度或成稿归档，正文可在该次`summary.previews`查看。

## 推荐：直接读取数据库

Codex环境安全配置：

| 项目 | 用途 |
|---|---|
| `SUPABASE_URL` | 数据库根地址，可从腾讯原有`COZE_SUPABASE_URL`取得 |
| `SUPABASE_ANON_KEY` | 从腾讯原有`COZE_SUPABASE_ANON_KEY`安全配置；按已有数据库权限验证是否允许读取 |
| 网络规则 | 仅添加该项目的精确Supabase主机名 |

取稿CLI移除本进程中可选的service role变量，仅使用ANON配置，所有请求均为查询。无需迁移高权限数据库Key、微信AppSecret或模型Key。

```bash
# Node24云环境保留代理和CA，启用原生fetch读取继承的代理设置。
source /workspace/.cloud-onboarding/central-asia-news/env.sh
NODE_USE_ENV_PROXY=1 pnpm drafts:pull 2026-11-04 --direct
```

命令取回该日所有归档版本，写入忽略目录`.cache/drafts/日期/artifacts/`：完整HTML、完整JSON、可供`review:file`使用的逐篇批次JSON和索引。它不触发推送、不写库、不调用模型。可加`--country kz`及`--out /path`。多次尝试保留各自交付状态，不以日期相同自动合并。

旧版本产生的当日稿件尚无完整成稿归档，可先恢复推送清单对应的数据库译稿和原文：

```bash
NODE_USE_ENV_PROXY=1 pnpm drafts:pull 2026-11-04 --direct --database
```

此模式先核实`latest.summary.today`和当轮选稿窗口，再逐国精确匹配已交付标题。缺失、歧义、推送时改过标题而无法匹配的条目明确列为`unmatchedTitles`，不凭相似词认领。日期不符直接报错，不把昨天最新记录称为今天。输出明确标注`database_translation_before_final_push_edits`，不是最终微信版本；不能靠重跑模型或排版还原丢失的旧成稿。`database-snapshot.json`也保留原推送摘要，供核对失败国家、漏稿和历史处置。

## 可选：通过腾讯服务只读取回

若不直连数据库，可在腾讯服务和读取端安全配置同一独立`NEWS_ARTIFACT_READ_TOKEN`，通过`Authorization: Bearer …`访问`GET /api/wechat/artifacts?date=2026-11-04`。未配置入口关闭；无凭据或错误凭据返回401；Token不接受query参数；响应禁止缓存。公开推送状态只显示归档引用和校验摘要，不新增完整归档正文。

```bash
NODE_USE_ENV_PROXY=1 pnpm drafts:pull 2026-11-04
```

服务地址默认取项目原有腾讯域名，也可配置`NEWS_SERVICE_BASE_URL`。该模式不需要把Supabase凭据带到读取端。归档接口只读，不调用微信或模型；按日期/国家分页，正文校验失败或分页异常报错，不输出部分内容冒充完整批次。历史原稿的HTTP恢复可用`--database`。

## 配置生效和上线验收

腾讯已有数据库配置不会自动进入Codex云实例。环境工具只能保存配置草案；在云环境设置安全绑定Key并保存、发布后，检查实际网络规则和凭据就绪，再运行真实只读取稿。不要打印Key、把占位凭据复制到腾讯控制台，或通过改代理绕过网络策略。

直接数据库恢复旧稿不依赖新代码部署；新成稿归档必须部署后才开始产生。部署前核对线上采集/推送是否空闲，不能为取稿重触发整轮发稿。

用户2026-11-04提供的腾讯设置页显示0.25核、0.5G内存、Node堆上限320MiB、每日03:45–09:30扩到1实例。页面显示值仍需与实际保存的运行状态核对；不要继续把历史1核2G或11:15结束窗口当成当前事实。本次归档/取稿串行执行，无新运行时依赖。
