# MemHub

面向所有 AI Agent（PI-Desktop、Claude Code、Codex、Cursor、DeepSeek Harness 等）的跨宿主本地记忆系统。记忆就是 Markdown 文件：全局库默认在 `~/.memory/`，项目库在 `<repo>/.memory/`，拷走目录即可迁移。纯 Node.js（≥ 18），零依赖。

## 记忆怎么分

| 类型 | 判断标准 | 位置 |
| --- | --- | --- |
| 全局长期记忆 `scope: global` | 任务结束后仍成立，换到别的项目也成立（用户偏好、环境坑、通用工作流） | `~/.memory/{user,skills,decisions,…}/` |
| 项目长期记忆 `scope: project` | 任务结束后仍成立，只对当前仓库成立（技术栈、约定、架构决策） | `<repo>/.memory/{projects,decisions,skills}/` |
| 短期交接单 `scope: handoff` | 跨会话的任务状态，任务结束就失效 | 项目内：`<repo>/.memory/handoffs/`（默认不提交 Git）；项目外：`~/.memory/handoffs/`，并记录所在目录，只在该目录下可见 |

项目根的判定顺序：最近的已有 `.memory/` 目录 → Git 仓库根（`.git` / `.workflow`）→ `package.json`、`pyproject.toml` 等清单文件。`~`、`~/Desktop`、`~/Downloads`、`~/Documents`、`/tmp` 本身不算项目（除非它本身就是 Git 仓库）。项目外写 `scope: project` 会被拒绝，并提示改用 `global` 或 `handoff`。

交接单规范：

- 同一任务用固定的 `task` 键（分支名或任务短名），重复提交会原地更新，不会堆出多份。
- 正文按「目标 / 验收标准（`- [ ]` 未完成、`- [x]` 已完成并附证据）/ 下一步 / 阻塞 / 相关文件」书写。
- `status`：`active`（进行中）、`blocked`（等用户或外部条件）、`done`（验收标准全部勾选且有证据）、`abandoned`（用户放弃）。`done` / `abandoned` 会自动移入 `archive/`。
- `ttl_days`（默认 14）从最后一次更新起算，过期后不再被检索，并在下次会话启动时自动归档。

## 记忆怎么读

1. **会话开始**：注入 `<memory-boot>`，包含 SOUL、记忆协议、当前目录的活跃交接单（最近两份附正文），以及全部长期记忆的标头目录 `<memory-catalog>`。Claude Code 在上下文压缩（`compact`）或 `clear` 后会重新注入。
2. **每次用户发消息**：按这句话检索相关标头注入 `<memory-context>`；像"继续"这类短句会结合上一轮助手回复一起检索。同一会话已注入过的条目不再重复。
3. **工具调用之后**：命令或工具失败时用报错文本检索；首次读写某个目录时按记忆的 `paths` 匹配。每轮最多补充 3 次。
4. **Agent 主动拉取**：任何时候都可以调用 `memory_search` / `memory_load(id)`。

检索默认是本地关键词匹配（中文二元切分 + 英文分词，标题、`keywords`、`triggers` 为强匹配字段）。写入时把标题写成结论、在 `triggers` 里写会遇到它的场景和同义词，召回效果会好很多。

可选的小模型精排：设置以下环境变量后，自动注入前会先让小模型从候选标头里挑出真正相关的条目；超时或出错时自动退回关键词结果。

```bash
export MEMHUB_RERANK_URL=https://<OPENAI_COMPATIBLE_HOST>/v1   # 任意 OpenAI 兼容接口
export MEMHUB_RERANK_MODEL=<small-model>
export MEMHUB_RERANK_API_KEY=<key>                              # 可选
export MEMHUB_RERANK_TIMEOUT_MS=1500                            # 可选
```

注意：开启后，候选记忆的标题与摘要、当前提问会发送到该接口。

## 后台复盘

Agent 经常忘了主动写记忆，后台复盘用来补这个缺口：每隔 N 轮对话，以及会话结束时，把这段对话交给一个模型，让它按写入规则挑出值得长期保存的内容。挑出的候选**不会直接写入**，而是进入 Inbox，确认后才生效（Web 控制台、`memhub inbox` / `memhub commit <batchId>`）。

```bash
export MEMHUB_REVIEW_URL=https://<OPENAI_COMPATIBLE_HOST>/v1   # 未设置则不复盘
export MEMHUB_REVIEW_MODEL=<model>
export MEMHUB_REVIEW_API_KEY=<key>                              # 可选
export MEMHUB_REVIEW_INTERVAL=10                                # 每 N 轮用户消息复盘一次，默认 10
export MEMHUB_REVIEW_TIMEOUT_MS=60000                           # 可选
```

Claude Code 在 `Stop` 达到间隔、或 `SessionEnd` 时启动一个独立后台进程（`memhub review`），不阻塞对话；PI-Desktop 插件在 `agent_end` 和 `session_shutdown` 时触发。发送前会去掉注入的 `<memory-*>` 块并把疑似密钥替换为 `<REDACTED>`，对话正文最多约 2.4 万字符。注意：开启后，对话内容会发送到该接口。

## 接入方式

- **PI-Desktop 插件**（`adapters/pi-desktop/`）：进程内直接读写记忆库，不需要守护进程；注入启动目录、每轮检索、工具报错后检索，并提供 search / load / propose / forget 四个工具。
- **Claude Code**：`SessionStart` / `UserPromptSubmit` / `PostToolUse` / `PostToolUseFailure` / `Stop` / `SessionEnd` 六个 Hook + MCP。`Stop` Hook 在本轮改过文件却没更新交接单时，会要求 Agent 先更新交接单（可用 `MEMHUB_STOP_NUDGE=0` 关闭）；`Stop` 与 `SessionEnd` 还负责按间隔触发后台复盘。已安装过的用户需重新运行 `memhub init --agents claude` 才会注册 `SessionEnd`。
- **Codex / Cursor / Pi CLI**：MCP（`memhub mcp`）+ `adapters/cursor-codex/SKILL.md` 规则。没有 Hook，只能靠 Agent 主动调用。安装 Codex 时会遵循 `CODEX_HOME` 环境变量。
- **纯文件兜底**：自描述的 `MEMORY.md` 与自动维护的 `index.md`。

MCP 提供 5 个工具：`memory_boot` / `memory_search` / `memory_load` / `memory_propose` / `memory_forget`。`memory_propose` 默认直接写入（同标题替代旧结论，同 `task` 更新交接单），传 `requireReview: true` 时进入 Inbox 待审批；物理删除必须传 `confirm: true`。

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
