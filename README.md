# MemHub

面向所有 AI Agent（PI-Desktop、Claude Code、Codex、Cursor、DeepSeek Harness 等）的跨宿主本地记忆系统。记忆就是 Markdown 文件：全局库默认在 `~/.memory/`，项目库在 `<repo>/.memory/`，拷走目录即可迁移。纯 Node.js（≥ 18），零依赖。

## 记忆怎么分

| 类型 | 判断标准 | 位置 |
| --- | --- | --- |
| 全局长期记忆 `scope: global` | 任务结束后仍成立，换到别的项目也成立（用户偏好、环境坑、通用工作流） | `~/.memory/{user,skills,decisions,…}/` |
| 项目长期记忆 `scope: project` | 任务结束后仍成立，只对当前仓库成立（技术栈、约定、架构决策） | `<repo>/.memory/{projects,decisions,skills}/` |
| 短期交接单 `scope: handoff` | 跨会话的任务状态，任务结束就失效 | 项目内：`<repo>/.memory/handoffs/`（默认不提交 Git）；项目外：`~/.memory/handoffs/`，并记录所在目录，只在该目录下可见 |
| 最近会话记录（独立接口） | 用户说了什么、助手回答了什么、未完成问题与来源 | 项目内 `<repo>/.memory/sessions/`；项目外 `~/.memory/sessions/`，按实际目录隔离；默认不提交 Git，不自动删除 |

项目根的判定顺序：最近的已有 `.memory/` 目录 → Git 仓库根（`.git` / `.workflow`）→ `package.json`、`pyproject.toml` 等清单文件。`~`、`~/Desktop`、`~/Downloads`、`~/Documents`、`/tmp` 本身不算项目（除非它本身就是 Git 仓库）。项目外写 `scope: project` 会被拒绝，并提示改用 `global` 或 `handoff`。

项目当前阶段、最新进度、待办和 PR 状态写短期交接，不写长期记忆。项目阶段概况统一用 `task: project-status`，具体任务使用各自固定的 `task`。即使会话开在另一个项目，也应写入目标项目的 `.memory/handoffs/`：先核实目录，再给 PI-Desktop 或 MCP 工具传 `cwd`（目标项目的绝对路径），不同项目分开调用。省略 `cwd` 时使用当前会话目录；`paths` 只是检索标签，不改变保存位置。

交接单规范：

- 同一任务用固定的 `task` 键（分支名或任务短名），重复提交会原地更新，不会堆出多份。
- 正文按「目标 / 当前进度 / 验收标准（`- [ ]` 未完成、`- [x]` 已完成并附证据）/ 下一步 / 阻塞 / 相关文件」书写。只提供阶段进度也可以保存；未提供的验收标准或阻塞注明“未提供”，不要编造。
- `status`：`active`（进行中）、`blocked`（等用户或外部条件）、`done`（验收标准全部勾选且有证据）、`abandoned`（用户放弃）。`done` / `abandoned` 会自动移入 `archive/`。
- `ttl_days`（默认 14）从最后一次更新起算，过期后不再被检索，并在下次会话启动时自动归档。

**遗忘**：被 `load` 或自动注入时，只在 `~/.memory/state/usage.json`（不进 Git）记录最后使用时间和次数，不改写记忆文件。90 天没被加载、注入或更新的记忆进入休眠：在 Boot 目录里排到最后，目录装不下时先被挤掉，但仍能被检索；一旦再被注入或加载就自动恢复。重要程度 1 和用户偏好不休眠。休眠超过 180 天的会出现在 `memhub lint` 里，确认无用后再用 `forget(mode="archive")` 归档；系统不会自动归档或删除长期记忆。

## 记忆怎么读

1. **会话开始**：注入 `<memory-boot>`，包含 SOUL、记忆协议、当前目录的活跃交接单（最近两份附正文），以及全部长期记忆的标头目录 `<memory-catalog>`。Claude Code 在上下文压缩（`compact`）或 `clear` 后会重新注入。目录每条用 6 位短引用（如 `[a1b2c3]`）代替完整 ID，`load` / `forget` 都接受短引用；超过上限时按类别给出未列条数，Agent 可用 `search(type=...)` 不带 query 浏览该类别。
2. **每次用户发消息**：按这句话检索相关标头注入 `<memory-context>`；像"继续"这类短句会结合上一轮助手回复一起检索。同一会话已注入过的条目不再重复。
3. **工具调用之后**：命令或工具失败时用报错文本检索；首次读写某个目录时按记忆的 `paths` 匹配。每轮最多补充 3 次。
4. **Agent 主动拉取**：任何时候都可以调用 `memory_search` / `memory_load(id)`。

检索默认是本地关键词匹配（中文二元切分 + 英文分词，标题、`keywords`、`triggers` 为强匹配字段），并在命中结果后基于 `state/entities.json` 的共现实体做一跳关联延伸（不依赖向量库）。写入时把标题写成结论、在 `triggers` 里写会遇到它的场景和同义词，召回效果会好很多。

可选的小模型精排：设置以下环境变量后，自动注入前会先让小模型从候选标头里挑出真正相关的条目；超时或出错时自动退回关键词结果。

```bash
export MEMHUB_RERANK_URL=https://<OPENAI_COMPATIBLE_HOST>/v1   # 任意 OpenAI 兼容接口
export MEMHUB_RERANK_MODEL=<small-model>
export MEMHUB_RERANK_API_KEY=<key>                              # 可选
export MEMHUB_RERANK_TIMEOUT_MS=1500                            # 可选
```

注意：开启后，候选记忆的标题与摘要、当前提问会发送到该接口。

## 定期自检与整理

Agent 经常忘了主动写记忆。MemHub 不额外调用复盘模型，而是由**同一个 Agent** 定期回看自上次自检以来的对话，按写入规则沉淀可复用结论、补绝对日期（`YYYY-MM-DD`），并在结论被推翻时用同标题覆盖、`supersedes` 替代不同标题的旧条目或 `forget(deprecate)` 废弃旧条目；没有需要保存或修改的内容时只回复“无需记录”。自检这一轮不会再触发新的自检。

为避免每轮都多跑一次模型调用，默认**每 5 轮**或**接近上下文压缩**时才触发一次自检（可在 `config.json` 的 `selfCheck.everyTurns` / `selfCheck.contextChars`，或环境变量 `MEMHUB_SELF_CHECK_EVERY_TURNS` / `MEMHUB_SELF_CHECK_CONTEXT_CHARS` 调整；设为 `1` 即每轮自检）：

- **Claude Code**：`Stop` Hook 在达到步数间隔、`PreCompact` 压缩触发，或本轮改过文件但未更新交接单时返回 `decision: "block"` 触发自检；本轮已经主动调用过 `propose` 会重置计数，`stop_hook_active` 防止循环。
- **PI-Desktop**：插件在 `agent_settled`（本轮完全结束、会话空闲）且达到步数间隔或对话字符数接近阈值时，用 `sendUserMessage` 追加一条自检消息；主动调用过 `propose` 会重置计数，被中断的轮次不追加。自检消息及其回复不写入会话记录，也不参与记忆检索。
- **Codex / Cursor / Pi CLI**：当前没有接入 Hook，仍依赖 Agent 主动调用 `memory_propose`。

默认开启；在全局 `config.json` 中设置 `"selfCheck": { "enabled": false }`，或设置 `MEMHUB_SELF_CHECK=0` 即可关闭。

## 会话保存与续聊（PI 插件 0.3.5）

PI-Desktop 在请求前保存可取得的消息，在 `agent_end` 等待本轮基础落盘，`session_shutdown` 补存；保存不依赖任何模型。新会话启动时恢复同一工作区最近的其他主会话，注入独立的 `<memory-session>` 块，标明来源 Agent、时间、序号和摘要覆盖范围，并将来源固定到本次会话。后台摘要未完成或失败时仍能读取已保存原话。此自动流程已通过扩展事件测试，真实桌面端双窗口验收仍待执行。

插件实现入口与 bundled core 使用版本化路径（当前 `extension-0.3.5.js`、`core/0.3.5/src/`）：PI 0.22.0 会按入口路径缓存旧模块，同路径重装后仍会运行旧代码。测试包含直接使用 PI 0.22.0 加载器的缓存复现、保存/恢复，以及 `agent_settled` 后追加自检消息；完整桌面 UI 验收仍待安装新版后执行。

会话日志不进入长期目录、搜索或 Inbox；在 A 中讨论 B 的对话仍保存到 A。B 的当前阶段继续由 Agent 通过 `cwd` 指向 B 的交接工具维护。既有聊天不会自动批量导入。

基础保存默认开启。可在全局 `config.json` 中设置 `"sessions": { "enabled": false }`，或 `MEMHUB_SESSIONS_ENABLED=0` 关闭自动采集与恢复。摘要使用单独的 `summary` 配置段（字段：`enabled`、`url`、`model`、可选 `apiKey`、`timeoutMs`、`reasoningEffort`），也支持 `MEMHUB_SUMMARY_*` 环境变量；未配置完整 URL 和模型时不发送摘要请求。开启后，会将已过滤的会话文字发送到明确配置的端点，结果自动保存到会话记录。`summary.enabled=false` / `MEMHUB_SUMMARY_ENABLED=0` 只关闭模型摘要。

```bash
node packages/cli/bin/memhub.js session list --cwd /path/to/repo
node packages/cli/bin/memhub.js session load --cwd /path/to/repo --key <SESSION_KEY> --from 1 --to 10
node packages/cli/bin/memhub.js session status --cwd /path/to/repo
node packages/cli/bin/memhub.js session list --cwd /path/to/repo --cross-workspace
node packages/cli/bin/memhub.js session rebuild --cwd /path/to/repo
```

`capture` / `restore` 可从标准输入接收统一 JSON；`summarize --key <SESSION_KEY>` 手动补摘要。重建定位目录只读当前工作区、原定位目录中已知工作区，以及 `--workspace-roots '["/path/to/other"]'` 指定的目录；不扫描整台机器。`doctor` 和 `session status` 只输出定位与状态，不输出聊天正文，也不把宿主 Hook 信任状态推断为已启用。

PI 工具为 `session_capture` / `session_restore` / `session_list` / `session_load` / `session_status`；MCP 对应 `memory_session_*`。日志读取支持序号范围；摘要不可当作逐字引文。宿主未提供稳定消息 ID 或时间戳时会标注采集缺口：仅含单轮增量的相同文本可能无法区分，需宿主实测。支持范围与验收细节见 [会话层实施记录](docs/session-memory-implementation.md)。

## 接入方式

- **PI-Desktop 插件**（`adapters/pi-desktop/`）：进程内读写记忆库，不需要守护进程；提供启动目录、每轮与工具错误检索、会话保存与恢复，以及 4 个长期记忆工具和 5 个会话工具。
- **Claude Code**：`SessionStart` / `UserPromptSubmit` / `PostToolUse` / `PostToolUseFailure` / `Stop` 五个 Hook + MCP。`Stop` Hook 负责每轮结束自检（见上文）。旧版本注册过的 `SessionEnd` Hook 不再需要，重新运行 `memhub init --agents claude` 会自动清理。
- **Codex / Cursor / Pi CLI**：MCP（`memhub mcp`）+ `adapters/cursor-codex/SKILL.md` 规则。没有 Hook，只能靠 Agent 主动调用。安装 Codex 时会遵循 `CODEX_HOME` 环境变量。
- **纯文件兜底**：自描述的 `MEMORY.md` 与自动维护的 `index.md`。

MCP 提供原有的 `memory_boot` / `memory_search` / `memory_load` / `memory_propose` / `memory_forget` 和 5 个独立的 `memory_session_*` 工具。`memory_boot` 传 `source_session_id` 与 `origin_agent` 时复用统一会话恢复。`memory_propose` 默认直接写入（同标题替代旧结论，同 `task` 更新交接单），传 `requireReview: true` 时进入 Inbox 待审批；物理删除必须传 `confirm: true`。

## Web 控制台

`memhub serve` 启动本地守护进程与 Web 控制台（默认 `http://127.0.0.1:4789`），提供 SOUL 编辑、Inbox 审批、记忆浏览与关系图谱。守护进程只接受 Host 为 `127.0.0.1` / `localhost` / `[::1]` 的请求，带 `Origin` 时必须与本机地址一致，以防止网页跨站写入。

## 快速开始

```bash
node ./packages/cli/bin/memhub.js init --dry-run        # 预览将修改的配置
node ./packages/cli/bin/memhub.js init --agents claude  # 安装到指定 Agent
node ./packages/cli/bin/memhub.js serve
node ./packages/cli/bin/memhub.js doctor
node ./packages/cli/bin/memhub.js search "镜像 架构"
node ./packages/cli/bin/memhub.js uninstall             # 只移除 MemHub 自己添加的配置项
npm test
```
