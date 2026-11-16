# MemHub Universal Memory 0.3.1

在同一台机器上共享全局长期记忆、项目交接和独立的会话记录。插件包必须包含 `core/0.3.1/src/`；仓库开发时使用 `../../packages/core/src/`。扩展实现入口为 `extension-0.3.1.js`，`extension.js` 仅用于仓库内兼容引用。

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

0.3.1 修复 PI 0.22.0 在插件升级后按旧入口路径缓存模块的问题：实际实现与 bundled core 都使用版本化路径，避免新会话继续执行旧代码。已通过真实宿主加载器的隔离测试：保留旧缓存、加载新版、A 保存到 #2、B 恢复 A，宿主无诊断错误。后续发布修改扩展或核心时，应同步版本化入口、核心目录和 manifest，不能只增加一个转发到旧路径的包装文件。

插件工具调用上下文不包含 cwd 时，通过 `pi.workspace.get()` 解析工作区；仍不可用时提示显式传 cwd，避免 `/null` 错误。安装包升级后，实际桌面端是否成功重新加载仍需用保存序号核实。
