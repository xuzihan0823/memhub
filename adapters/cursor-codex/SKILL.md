---
name: memhub-memory
description: Use shared MemHub cross-agent memory via MCP (memory_boot, memory_search, memory_load, memory_propose, memory_forget).
---

# MemHub 跨 Agent 通用记忆协议

1. **会话开始或切换到新项目时**：调用 `memory_boot(cwd)`。返回内容包括人格设定、记忆协议、当前目录的活跃交接单，以及全部长期记忆的标头目录。
2. **读取**：先看目录，标题即结论。需要细节时调用 `memory_load(id)`；目录里没有覆盖到时，用 `memory_search(query, cwd)` 检索。命令报错时，用报错文本搜一次。
3. **写入长期记忆**：只写任务结束后仍成立的内容。换到别的项目仍成立用 `scope="global"`，否则用 `scope="project"`。标题直接写结论，`summary` 写适用条件，`triggers` 写会遇到它的场景与同义词。
4. **任务交接**：跨会话的任务状态用 `scope="handoff"`，同一任务固定同一个 `task` 键。正文按「目标 / 验收标准（`- [ ]` / `- [x]` + 证据）/ 下一步 / 阻塞 / 相关文件」书写。完成一项、遇到阻塞或计划变化时就更新，不要等到会话结束。
5. **完成判定**：验收标准全部勾选且有证据，才设 `status="done"`，设之前先把可复用的经验写成长期记忆。需要用户确认的项，确认前保持 `active`。新会话恢复交接单时，先用 `git status`、测试等核实现状。
6. **遗忘**：事实变化时用同标题重新提交来替代旧结论，或调用 `memory_forget(id, mode="deprecate"|"archive")`。物理删除必须获得用户明确同意并传 `confirm=true`。
