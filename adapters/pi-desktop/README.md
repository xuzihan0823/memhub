# MemHub Universal Memory 0.3.3

在同一台机器上共享全局长期记忆、项目交接和独立的会话记录。插件包必须包含 `core/0.3.3/src/`；仓库开发时回退到 `../../packages/core/src/`。扩展实现入口是 `extension-0.3.3.js`，`extension.js` 仅供仓库内兼容引用。

## 会话保存与续聊

会话消息在请求前和每轮结束时保存；新会话恢复同一工作区最近的其他主会话，来源在本次启动时固定。保存不依赖任何模型，默认不提交 Git，也不会自动删除；历史聊天不会自动批量导入。

新增工具：`session_capture`、`session_restore`、`session_list`、`session_load`、`session_status`。原有 `search`、`load`、`propose`、`forget` 继续可用。跨项目阶段更新仍通过 `propose` 的 `cwd` 指向目标项目，使用 `scope="handoff"`。

基础采集默认开启，可在全局 `config.json` 中设置 `sessions.enabled` / `summary.enabled`。可选摘要需要单独设置 `summary.url`、`summary.model`；支持可选的 `apiKey`、`reasoningEffort`、`timeoutMs`，也支持 `MEMHUB_SUMMARY_*` 环境变量覆盖。开启摘要后，经过过滤的对话会发送到明确配置的模型端点，摘要自动保存到会话层。

## 每轮结束自检

每轮在 `agent_settled`（本轮完全结束、会话空闲）后，插件用 `sendUserMessage` 追加一条以 `[memhub:self-check]` 开头的自检消息，让同一个 Agent 回看自上次自检以来的对话：有依据、以后还会用到的结论直接写入长期记忆，任务进度写入交接单；没有可记的内容时只回复“无需记录”。自检轮不会再触发自检，被中断的轮次不追加；自检消息和回复不写入会话记录，也不触发记忆检索注入。

这会额外消耗一次模型调用，并在聊天界面中显示为一条消息。可在全局 `config.json` 中设置 `"selfCheck": { "enabled": false }`，或设置 `MEMHUB_SELF_CHECK=0` 关闭。插件不再调用独立的复盘模型，`review` 配置段已不再读取。

## 状态与限制

`session_status` 用于查看保存序号、摘要覆盖、固定来源和定位目录状态；`host_hooks: not-verified-by-core` 表示核心无法验证宿主 Hook 的信任状态。宿主未提供稳定消息 ID 或时间戳时会报告采集缺口，不能保证区分完全相同的增量消息。

本版本通过 PI 扩展事件测试，并用 PI 0.22.0 真实加载器验证了 `agent_settled` 能触发 `sendUserMessage`。自检消息在真实桌面端的显示方式、排队时机，以及双窗口续聊仍需安装后验收。Claude Code / Codex 的自动会话采集尚未接通，其他宿主通过统一 MCP 会话接口主动读写。

PI 0.22.0 会按入口路径缓存扩展模块。实际实现与 bundled core 都使用版本化路径，避免升级后新会话仍执行旧代码。后续发布修改扩展或核心时，应同步更新版本化入口、核心目录和 manifest，不能只增加转发旧路径的包装文件。插件工具调用上下文没有 `cwd` 时，通过 `pi.workspace.get()` 解析；仍不可用时会提示显式传入 `cwd`。
