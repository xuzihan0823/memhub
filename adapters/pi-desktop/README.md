# MemHub Universal Memory 0.3.0

在同一台机器上共享全局长期记忆、项目交接和独立的会话记录。插件包必须包含 `core/src/`；仓库开发时可使用 `../../packages/core/src/`。

会话消息在请求前和每轮结束保存，新会话恢复同工作区最近的其他主会话，来源在本次启动时固定。保存不依赖摘要或长期复盘模型。会话内容默认不提交 Git，不自动删除；历史聊天不自动批量导入。

新增工具：`session_capture`、`session_restore`、`session_list`、`session_load`、`session_status`。原有 `search`、`load`、`propose`、`forget` 继续可用。跨项目阶段更新仍通过 `propose` 的 `cwd` 指向目标项目，使用 `scope="handoff"`。

基础采集默认开启。全局记忆目录的 `config.json` 可设置：

```json
{
  "sessions": { "enabled": true },
  "summary": { "enabled": false }
}
```

可选摘要需要单独设置 `summary.url`、`summary.model`；支持可选的 `apiKey`、`reasoningEffort`、`timeoutMs`，也支持 `MEMHUB_SUMMARY_*` 环境变量覆盖。开启摘要后，经过过滤的对话会发送到明确配置的模型端点，摘要自动保存到会话层。长期复盘使用独立的 `review` 配置，结果继续进入 Inbox 审批。

通过 `session_status` 查看保存序号、摘要覆盖、固定来源和定位目录状态。状态中 `host_hooks: not-verified-by-core` 表示核心无法验证宿主 Hook 信任状态。宿主没有稳定消息 ID 或时间戳时会报告采集缺口，无法承诺区分完全相同的增量消息。

本版本已通过仓库中的 PI 扩展事件测试；真实桌面端双窗口续聊仍需验收。Claude Code、Codex 的自动会话采集尚未接通，其他宿主可通过统一 MCP 会话接口主动读写。
