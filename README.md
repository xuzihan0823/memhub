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

从 Dock / Finder 启动 PI-Desktop 时，推荐在全局记忆库的 `config.json`（默认 `~/.memory/config.json`）配置，无需设置系统环境变量。文件不应包含真实密钥并提交到 Git；本机 Magpie 通常无需 API Key：

```json
{
  "review": {
    "enabled": true,
    "url": "http://127.0.0.1:3425/v1",
    "model": "<provider>/<light-model>",
    "reasoningEffort": "low",
    "interval": 3,
    "timeoutMs": 60000
  }
}
```

`model` 填 Magpie `/v1/models` 中的完整 ID，选你希望用于复盘的轻量模型。短请求或“复盘”提示词不保证网关自动降级；`group/coding` 也可能被配置为主模型，不能视作低价模型别名。`reasoningEffort` 是可选的思考强度，需模型支持。此配置只开启复盘；精排可另加 `rerank` 配置段。

仍支持环境变量，逐字段覆盖文件配置。把文件中 `review.enabled` 改为 `false`，或设置 `MEMHUB_REVIEW_ENABLED=0` 即可关闭；未提供完整的 URL 与模型时保持关闭：

```bash
export MEMHUB_REVIEW_URL=https://<OPENAI_COMPATIBLE_HOST>/v1
export MEMHUB_REVIEW_MODEL=<model>
export MEMHUB_REVIEW_API_KEY=<key>                              # 可选
export MEMHUB_REVIEW_INTERVAL=10                                # 每 N 轮用户消息复盘一次，默认 10
export MEMHUB_REVIEW_TIMEOUT_MS=60000                           # 可选
export MEMHUB_REVIEW_REASONING_EFFORT=low                        # 可选
export MEMHUB_REVIEW_ENABLED=0                                  # 可选：关闭复盘
```

Claude Code 在 `Stop` 达到间隔、或 `SessionEnd` 时启动一个独立后台进程（`memhub review`），不阻塞对话；PI-Desktop 插件在 `agent_end` 和 `session_shutdown` 时触发。发送前会去掉注入的 `<memory-*>` 块并把疑似密钥替换为 `<REDACTED>`，对话正文最多约 2.4 万字符。注意：开启后，对话内容会发送到该接口。

## 会话保存与续聊（PI 插件 0.3.1）

PI-Desktop 在请求前保存可取得的消息，在 `agent_end` 等待本轮基础落盘，`session_shutdown` 补存；不依赖长期复盘模型。新会话启动时恢复同一工作区最近的其他主会话，注入独立的 `<memory-session>` 块，标明来源 Agent、时间、序号和摘要覆盖范围，并将来源固定到本次会话。后台摘要未完成或失败时仍能读取已保存原话。此自动流程已通过扩展事件测试，真实桌面端双窗口验收仍待执行。

0.3.1 修复已安装但未采集的升级场景：PI 0.22.0 会缓存旧入口模块，实现入口和 bundled core 改用版本化路径，防止同路径重装后仍运行旧代码。另修复会话工具上下文无 cwd 时的工作区回退。43 项测试通过，包含直接使用 PI 0.22.0 加载器的缓存复现与保存/恢复测试；完整桌面 UI 验收仍待安装新版后执行。

会话日志不进入长期目录、搜索或 Inbox；在 A 中讨论 B 的对话仍保存到 A。B 的当前阶段继续由前台助手通过 `cwd` 指向 B 的交接工具维护。既有聊天不会自动批量导入。

基础保存默认开启。可在全局 `config.json` 中设置 `"sessions": { "enabled": false }`，或 `MEMHUB_SESSIONS_ENABLED=0` 关闭自动采集与恢复。摘要使用单独的 `summary` 配置段（字段同 `review`：`enabled`、`url`、`model`、可选 `apiKey`、`timeoutMs`、`reasoningEffort`），也支持 `MEMHUB_SUMMARY_*` 环境变量；未配置完整 URL 和模型时不发送摘要请求，且不会隐式复用复盘通道。开启后，会将已过滤的会话文字发送到明确配置的端点，结果自动保存到会话记录。`summary.enabled=false` / `MEMHUB_SUMMARY_ENABLED=0` 只关闭模型摘要。

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
- **Claude Code**：`SessionStart` / `UserPromptSubmit` / `PostToolUse` / `PostToolUseFailure` / `Stop` / `SessionEnd` 六个 Hook + MCP。`Stop` Hook 在本轮改过文件却没更新交接单时，会要求 Agent 先更新交接单（可用 `MEMHUB_STOP_NUDGE=0` 关闭）；`Stop` 与 `SessionEnd` 还负责按间隔触发后台复盘。已安装过的用户需重新运行 `memhub init --agents claude` 才会注册 `SessionEnd`。
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
