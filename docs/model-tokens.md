# 模型容量与 token 用量

## 2026-09-09 自建服务实测

目标：当时本地配置的 /v1 服务与模型（具体部署值不保留在文档中）。只发送最小诊断文本，不发送仓库代码。

| 能力 | 结果 |
| --- | --- |
| GET /v1/models | 返回 capabilities.limits |
| max_context_window_tokens | 372000 |
| max_prompt_tokens | 372000 |
| max_output_tokens | 128000 |
| tokenizer | o200k_base |
| POST /v1/responses/input_tokens | HTTP 404，当前不接入运行时 |
| response.completed.usage | 有效，最小请求输入 10 / 输出 5 / 合计 15 |
| max_output_tokens 请求参数 | 新适配器实测接受 16384 |

以上容量是服务公布值，没有通过填满窗口来证明其极限。响应可能使用模型别名，
请求仍使用本地配置的完整模型标识，不根据返回别名猜测另一套容量。

## 预算策略

每个任务开始时从配置服务读取 /models，精确匹配配置模型 ID，
校验并仅保留窗口、最大输入、最大输出与 tokenizer。元数据请求至多 10 秒，
无重试；失败、缺失、格式不合格或未知 tokenizer 退回已有 contextChars 模式，
并在界面显示“字符备用模式”。取消仍终止任务，不能被当作普通发现失败继续执行。
元数据不跨任务缓存，因此换服务或模型后不会复用旧容量。

目前只加载本地 js-tiktoken 1.0.21 的 o200k_base 编码，不从第三方网络下载词表。
输入估算包含序列化 input、instructions、tools，特殊 token 字面量当作普通文本。
这是本地估算，不能精确复刻服务内部协议包装、隐藏开销和多模态计量。

设置中的“上下文窗口上限（token）”默认 300000，保存后用于新任务，以该值代替服务公布的上下文窗口和输入容量参与预算计算（主模型及独立辅助摘要模型均适用）。服务仍负责实际容量校验；若设置高于真实窗口，请求可能被拒绝。容量发现失败或 tokenizer 不受支持时仍进入字符备用模式，此设置不会猜测 tokenizer，也不会改变服务公布的最大输出限制。
maxOutputTokens 默认 16384，可在 Web UI“最大输出 token”中调整。
实际输出上限取配置值、服务最大输出、窗口扣除安全余量与至少 1024 输入预留后的最小值；
只有 token 模式发送 max_output_tokens，普通调用和摘要调用使用同一预留规则。
安全余量为 max(1024, ceil(window × 5%))。

输入预算 = min(window - 实际输出上限, 服务最大输入或 window) - 安全余量。

服务曾公布 372000 token 窗口；现在默认采用手动上限后得到：300000 - 16384 - 15000 = 268616 token 输入预算。
达到输入预算 80% 时尝试压缩，目标降至 60% 以内；切分、摘要分块和压缩验收
使用同一计量方式。token 模式下 contextChars 不再作为压缩阈值，仅用于发现失败的备用模式。
摘要与恢复安全边界见 [context-management.md](context-management.md)。

每次正常任务响应完成后，若实报 input_tokens 高于本地估算，用二者比值上调本任务后续估算。
校准只增不减，任务结束重置；不把 output_tokens 或累计 total_tokens 当成窗口占用。
安全余量和容量错误的一次恢复仍保留，估算不是绝对不会超限的保证。

## 持久化与展示

ModelResult 返回可选 usage：input_tokens、output_tokens、total_tokens，
以及可选 cached_tokens、reasoning_tokens。仅接受非负安全整数、合计一致且细分不超过总项的数据。
缺失或异常用量不当作零，也不影响已完成响应；attribution 等未使用扩展字段不落盘。

事件：
- context_budget：本任务模式、服务公布窗口与实际采用的窗口、输入预算、输出预留、安全余量；宿主和 Runtime 两条执行路径均记录。
- model_request：每次实际发起的模型请求，用 purpose 区分任务、摘要、标题和审批；即使服务最终未提供 usage，也能正确统计调用次数与任务轮次。
- model_usage：服务实报，用 purpose 区分任务、摘要、标题和审批。

这些事件通过既有 SQLite 历史和 SSE 保存/展示，刷新或重启后可查看。当前会话右上角的统计默认折叠；展开后汇总实报输入、输出和合计 token，以及缓存/非缓存输入、LLM 请求与任务轮次、工具成功率和累计运行时间。
每次请求的本地输入计量只用于预算、压缩和实报校准，不再保存或显示；界面只展示服务实报用量，避免将本地估算误作实际消耗或窗口占用。若任一实报缺少 cached_tokens，统计会明确标记缓存/非缓存明细不完整，不能假定缓存为零；这不是按模型价格计算的费用统计。
缓存 token 是输入的子集，推理 token 是输出的子集，不能再次相加。
摘要输出结构不合格时，若已有合法完成用量，也会记录已发生的消耗；
缺少完成事件的失败请求不虚构其用量。

快照保留实际 beforeChars/afterChars；新增可选 budget 字段记录单位、预算、压缩前后计量。
旧快照仍可读取，不需要删除或重建历史。

## 复测

将 CODEATELIER_API_KEY 放入本地 .env（Git 忽略），然后运行：

```sh
node --env-file=.env --import tsx scripts/probe-model-capabilities.ts
```

脚本只发最小诊断输入，记录校验后的元数据、用量、估算与计数接口状态，不打印密钥、
原始响应、attribution 或错误正文。每次复测会产生少量模型用量。

实现：providers/model-metadata.ts、responses-provider.ts、context/token-budget.ts。
回归：tokens.test.ts、session-statistics.test.ts、provider.test.ts 与 e2e/app.spec.ts。
真实探测证明当前接口兼容，不等于真实摘要语义质量、窗口极限或全平台都已验证。
