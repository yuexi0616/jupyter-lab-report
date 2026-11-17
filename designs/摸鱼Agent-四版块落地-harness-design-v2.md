# 摸鱼 Agent 四版块真实能力落地 · Agent Harness 架构设计

> 设计台账：2026-11-17 · 摸鱼 Agent 工作台 · **v2（决策落定版）** · 关键决策 15 项 · 未知区 2 项（U4 预算待定 / 许可复核）· 独立评审 v1 存疑 12 项已回修 + 复审通过 / v2 变更见 §0.1
> **落地状态（同日）**：P0 jev 决策内核、P1 刷课、P2 作业、P3 竞赛四阶段均已编码落地（离线 mock 闭环 + U2 门禁 + 独立 evaluator）；全量 76 项测试全绿。K4 按用户决定不保守处理——自动答题默认关但允许凭 U2 授权 token 显式开启。真实执行仍需各自 bridge（见 README）。
> v2 变更：用户拍板 U1–U6（见 §0.1）；刷课首选由 browser-use 调整为 **OCS 助手（ocsjs/ocsjs）** 作平台能力底座；弃用 MathModelAgent，竞赛改为 **yohanchen1/MathModelingAgent（MIT）**；确认引入 Python 运行时；新增"生成前询问 + 完成后询问"交互门禁。

> 轨别：**重构轨**（在现有 mock harness `moyu-agent-workbench/lib/` 上落地真实能力，非从零起步）
> 依据：GitHub 真机检索（2026-11-17）、现有源码全量审计（server.js + 6 lib + 前端 3 文件 + 2 份方案文档）、知识库框架案例与模式。
> SKILL_DIR：`C:\Users\lwr\.workbuddy\plugins\cache\experts\agent-harness-architect\1.7.0\skills\agent-harness-architect`

---

## 0. 决策状态标注（先读）

| 分类 | 内容 |
|---|---|
| **用户已确认** | ① 四版块全部落地真实能力；② GitHub 找成熟可行项目；③ 刷课优先内置浏览器 agent → U1 细化为"类似 OCS 助手"；④ 开源项目；⑤ 授权技术细节自决。 |
| **用户拍板 U1–U6（2026-11-17）** | **U1** 刷课边界=类似 OCS 助手（平台能力对齐 OCS：超星学习通/智慧树/职教云/智慧职教/中国大学MOOC；"只推进度不改成绩"仍为硬底线，详见 §0.1 注）；**U2** 学术诚信=生成前询问 + 完成后询问（两道人在回路门禁）；**U3** 只接受开源，不用商用 MathModelAgent，改用开源 agent/skill/工作流替代；**U4** 模型预算待定；**U5** 是，允许引入 Python 运行时；**U6** 版本锁定由架构师决定（=精确 pin + release notes 复核，见 §15）。 |
| **默认假设（可推翻）** | A1 保留 Node 主控 + Python 子进程桥接；A2 单机；A3 单 Agent + 循环内多档；A4 落地顺序 jev → 刷课 → 作业 → 竞赛；A5 工具适配层接入、不改外部源码；A7（新增）两道询问门禁统一走现有审批凭证机制（一次性 token + gate）。 |

### 0.1 用户拍板落实与关键修正

| 编号 | 用户答复 | 落实方式 | 对 v1 的改动 |
|---|---|---|---|
| U1 | 类似 OCS 助手 | 刷课能力底座改用 **ocsjs/ocsjs**（MIT，~4.3k stars，v5.4.0 / 2026-11-08，活跃）；平台清单以 OCS 支持列表为准 | §3.1 首选由 browser-use 改为 OCS；browser-use 降级为"通用浏览器 agent 备选/补位" |
| U2 | 生成前询问，完成后询问 | 两道人在回路门禁：生成动作前弹确认（范围/目标/口径），产物完成后弹确认（是否采用/披露声明） | §4.5 人在回路四档细化；§8 新增 `askBeforeGenerate` / `askAfterGenerate` 钩子 |
| U3 | 只开源，弃 MathModelAgent，开源替代 | 竞赛改用 **yohanchen1/MathModelingAgent（MIT，证据驱动 Claim/Obligation/Evidence + 独立 audit skill）** + **handsomeZR-netizen/mathmodel-skill（MIT，10 阶段）** | §3.3 整表替换；§4.6 的 V 层直接采用其"独立审计/INCONCLUSIVE"方法论（自研实现） |
| U4 | 待定 | 保留默认：本地/免费端点优先，付费显式开启 | 无变化，仍列未知区 |
| U5 | 是 | Python 运行时作为声明式硬依赖，`requirements.lock` 精确 pin | §3 技术栈、§7 目录补 `tools_python/venv` 说明 |
| U6 | 架构师决定 | 精确 pin（如 `browser-use==1.0.6`）+ 升级走 release notes 复核；适配层隔离变更半径 | §15 U6 标记为由架构师决定并给出策略 |

> **U1 注（诚实标注）**：OCS 助手能力范围比 v1 设想更宽——它含"自动答题/在线搜题"。用户答复"类似 OCS"指**能力形态对齐 OCS**，但 v1 硬约束"只推进度、不改成绩"仍然有效。二者交集处理为：**自动播放/课件阅读/弹窗跳过照 OCS 实现；"自动答题"仅在用户显式开启且经 U2 的"生成前询问"授权后启用，默认关闭**。此项为默认判断，若用户希望完全照搬 OCS（含默认自动答题）需再确认——列为 §15 残余未知。

---

## 1. 需求规格

| 维度 | 内容 | 状态 |
|---|---|---|
| 目标与用途 | 把四个版块从 mock 演示升级为真实可执行：刷课=浏览器自动化推进度；作业=notebook 骨架→执行→脱敏报告；毕设竞赛=检索→实验→反幻觉→双渲染；jev 回复=类型化决策→起草→fill-only | 已确认 |
| 成功标准 | 每个版块至少一条端到端真实闭环可复现，且通过独立 V 验证（非 agent 自评）；mock 链路保持回归全绿 | 已确认 |
| 验收来源（oracle） | 刷课=学习平台真实进度值；作业/竞赛=产物文件+编译通过+引用/数字追溯断言；jev=用户手动确认填入且高危零自动写入 | 默认假设 A4 |
| 任务结构 | 四个版块 = 四条领域管线；共享内核（profile/凭据/审计/审批）不变 | 已确认 |
| 数据/资源边界 | 凭据只存引用（沿用现有 profile.sanitize 正向白名单）；对话原文默认脱敏落指纹 | 已确认 |
| 硬约束 | fill-only 不自动发送、不碰支付；高危强制转人工（现有 `agent.js` 三条服务端安全策略保留）；开源许可合规 | 已确认 |
| 用户与场景 | 学生个人本地使用；单机；可 supervise 长任务 | 默认假设 A2 |
| 边界（不做什么） | 不产出证书、不改成绩、不代写、不伪造数据、不 vendored 禁商用代码 | 已确认 + U1/U2/U3 |
| 技术栈约束 | 主控 Node（零依赖起步），外部成熟项目允许 Python/TS 运行时 | 默认假设 A1/A5 |
| 模型策略与成本 | 循环内多档：决策型（本地 AnyJev）+ 快 LLM（起草）+ 强力 LLM（规划/建模）；预算上限待定 | 默认假设 A3 + U4 |
| 效率与体感 | 浏览器长任务需流式步骤 + 可中断；登录态 profile 复用；前缀字节稳定 | 默认假设 A3 |

---

## 2. 架构范式 P

| 子维度 | 决策 | 理由 |
|---|---|---|
| 扩展方式 | 插件化 —— 版块能力以适配器注册进 `tools` 注册表 | 与现有 `SIDE_EFFECT_TOOLS` / `DECISION_TOOLS` 策略无缝衔接；新增版块不改内核 |
| 配置方式 | 声明式 —— YAML 流程定义 + profile 外置；代码只实现原子工具 | 刷课平台差异、竞赛模板差异都是配置问题；贴切先例是 Autovisor 的 `config.ini` 外置与现有 profile 分区（**不**引用 MathModelAgent skills——那是能力编排流水线，非声明式配置） |
| 部署拓扑 | 单机 —— Node 主控 + 受限子进程（Python 工具）+ 本地 HTTP（决策模型） | 个人开源项目；避免分布式运维成本（A2） |
| 编排模式 | 中心化 —— 现有 agent loop 作 lead，版块适配器作 as-tool 被调用 | 单 Agent 优先；浏览器 agent 自带 loop 时作为 as-tool 子 harness 而非 full handoff |
| 能力供给形态 | 混合：**内置工具**（现有 Node tools）+ **外部子进程 harness**（browser-use / OMMW CLI）+ **MCP**（playwright-mcp 备选）+ **本地决策服务**（AnyJev/ollaya） | 按能力来源分型：通用浏览器循环用外部 agent、确定性管线用内置工具、决策用本地模型服务（见 §11 层间交叉） |

> 范式 P 对 E 层的影响：插件化 + 混合供给 → E 层固定为"plan→tool→observe"，能力增减通过注册/注销工具实现；browser-use 这类自带 loop 的 agent 以 `browser.run_task` 单个工具暴露，其内部循环对主控透明（黑盒 as-tool）。

---

## 3. 技术栈选型（GitHub 真机检索，快照 2026-11-17）

> 声明：star 数为检索当日快照，为 popularity 信号非质量证明；许可以仓库 LICENSE / 官方 README 为准，集成前须复核。

### 3.1 刷课（首选内置浏览器 agent）

| 候选 | 许可 | star 快照 | 形态 | 可编程接口 | 结论 |
|---|---|---|---|---|---|
| **ocsjs/ocsjs（OCS 网课助手）** | **MIT** | **~4.3k–4.5k**（2026-11 快照，活跃） | 用户脚本（油猴/脚本猫）+ 桌面端，Playwright 驱动 | TypeScript 脚本库 + `ocs-desktop` 启动器；支持超星学习通/智慧树/职教云/智慧职教/中国大学MOOC | **首选平台能力底座（U1 用户指定"类似 OCS"）** — 平台适配最全、MIT、千万级用户、2026-11-08 发 v5.4.0 仍活跃；能力含自动播放/课件阅读/弹窗跳过/自动登录 |
| **browser-use/browser-use** | MIT | **121.3k**（GitHub 页面直读） | 通用浏览器 agent，`Browser('chromium')` 内置浏览器 over CDP | Python `Agent(task,llm,browser).run_sync()` | **备选 / 通用补位** — 命中"内置浏览器 agent"原始要求，用于 OCS 未覆盖平台的通用播放任务；仍是 U1 之外的技术储备 |
| microsoft/playwright-mcp | Apache-2.0 | ~39k | 无障碍树驱动，工具而非 agent | MCP `npx @playwright/mcp@latest` | **确定性兜底** — 主控持 loop 的脚本子集路径（§5 降级链） |
| CXRunfree/Autovisor | 需核对 | 未取可靠快照 | Playwright 专用脚本 | `config.ini` 外置 | **适配器参考** — 智慧树断点续播/进度读取思路可借鉴；许可风险未消，不作依赖 |
| browser-use/jev-ultrafast | MIT（随主仓） | ~24k | 浏览器 agent | Python | **观察项** — browser 层非决策层，不与 AnyJev 混淆 |
| Skyvern | AGPL-3.0 | ~22k | vision-first | Python SDK + Docker | **不选** — AGPL 强 copyleft；独立进程调用义务边界仍有争议 + vision 成本高 |
| LaVague | Apache-2.0 | ~6k | 浏览器 agent | Python | **不选** — 自 2025-01 无 push，已休眠 |

**关键事实（browser-use v1.0，作为备选仍需按此编码，勿照抄旧教程）**：
- 2026-11-10 发布 1.0.0 首个稳定版，**变化在内部执行架构**——从 0.x 的"逐步 DOM 选择"重写为"模型写 Python + 持久 REPL + 原生 CDP"，底层 Pydantic AI。**但高级 Python API `Agent(task, llm, browser).run_sync()` 在官方 1.0 README 中依然是推荐写法**（§8.2 采用它）；变化的是内部机制、默认模型（bu-4.0）与默认浏览器（云浏览器），不是这个高级签名。必须锁定版本：`browser-use==1.0.6`，官方明确"pin exact，`never >=`"（发布频繁、行为与默认值可能变）。
- 1.0 默认 `model=bu-4.0` + **云浏览器（需 API key）**；本地免费路径必须显式 `Browser('chromium')` + 自己的 `ChatOpenAI(model, base_url=...)`。
- README 自带安全告警：本地 `Browser('chromium')` / `Browser('chrome')` 在 `127.0.0.1` 开**未鉴权调试端口**，共享机器上其他本地用户可 attach——本机个人使用可接受，多用户环境须用容器/VM。
- 内置反检测 / CAPTCHA 属**云服务**，开源 core 不含——刷课的验证码只能走"转人工"策略（与现有 fill-only 边界一致）。

### 3.2 作业（母版）

| 候选 | 许可 | 结论 |
|---|---|---|
| 内部模板 `jupyter-lab-report` | 内部模板 | **母版底座** — 现有 data.js 已定义确定性 SOP（doctor→check→cover→build→run→audit→deliver→clean→pack） |
| OMMW `qing1989620/workbuddy-modex` | 核心 MIT | **工程底座首选** — Research Core 单一事实源、反幻觉门控、命令链与母版同构；MIT 友好。star 未取可靠快照，集成前复核 |

### 3.3 毕设 / 竞赛

| 候选 | 许可 | 结论 |
|---|---|---|
| **yohanchen1/MathModelingAgent** | **MIT** | **首选（U3 开源替代）** — DSH 插件，两个 skill：`math-modeling-agent`（建模推进）+ `math-modeling-audit`（独立审计）；核心机制 Claim/Obligation/Evidence，裁决三态 PASS/FAIL/**INCONCLUSIVE**（证据不足不强行确定）。可选 Python/Lean/Wolfram 工具，工具缺失不伪装成功。**其"独立审计 + 不伪造成功"与本项目 V 层设计高度契合** |
| **handsomeZR-netizen/mathmodel-skill** | **MIT** | **工作流参考** — CUMCM/MCM/ICM 端到端 10 阶段、持久决策状态 `decision_log.json`、竞赛专属规则/模板、确定性评分助手、Codex/Claude 交接 |
| OMMW `workbuddy-modex` | 核心 MIT | **可 vendored 工程底座** — 反幻觉规则与命令链可落地为核心能力 |
| ~~jihe520/MathModelAgent~~ | ~~禁商用 source-available~~ | **已弃用（U3 用户拍板）** — 不用商用/非 OSI 许可，不进入依赖树；其方法论已被上述 MIT 项目覆盖 |
| andiii208/dsh-ultramath | MIT | **观察项** — 5 角色预设 + 33 篇模型库 + 三席盲评 + 数字冻结 + 学术诚信 7 门控；但为 DSH 生态插件，接入成本高于前两项 |

### 3.4 jev 回复（决策内核）

| 候选 | 许可 | 成熟度 | 结论 |
|---|---|---|---|
| **AnyJev** `nokia-applied-research/AnyJev` | Apache-2.0 | pre-alpha | **决策内核首选** — 把开源 LLM 变类型化决策（choice/score/noul），L0 零标注去偏、L2 小外挂校准；Qwen3-1.7B 达 0.730 追平 Jev 0.727； politique 全在代码层，契合 fill-only |
| ollaya `ollaya-dev/ollaya` | Apache-2.0 | 很新（2026-09-23 创建，~1.3k star） | **备选本地 drop-in** — Rust 运行时，`POST /v1/systemone` wire 兼容，本地毫秒级；成熟度不足，观察 |
| 现有 9 预设 LLM（models.js） | 各服务条款 | 已集成 | **起草层沿用** — hy4/智谱/硅基流动等继续做候选回复生成 |

**模型组合**（四分类档位；候选来自 2026-11-17 真机检索，禁止虚构规格。知识库 model 条目当前仅收录 Jev、CLM-8B，本文选用的 AnyJev / ollaya / Qwen3 / glm-4-flash / browser-use 默认模型**均属知识库未收录**，按 knowledge-policy 5.3 未收录通则处理：只作真机检索所得数据、不冒充知识库背书、集成前实测复核；来源 URL 见附录 A）

| 档位 | 候选模型/组件 | 职责 | 单价量级（注明核实） | 主控计费 token 占比 |
|---|---|---|---|---|
| 确定性代码 | 现有 `agent.js` 高危关键词兜底 + 路径/许可校验 | 高危拦截、schema 校验、进度核对 | — | 0 |
| 决策型模型（System One） | AnyJev + 本地 Qwen3-8B（Apache-2.0） | jev 意图/危险/是否回；刷课弹题/暂停决策 | 本地推理，无 token 费（电费/算力自担） | 0（本地） |
| 快速低价 LLM | 现有预设中低价档（如 zhipu glm-4-flash 永久免费，官网口径） | 候选起草、页面元素筛选、中间摘要 | 免费档存在；以官网为准 | ~20% |
| 强力 LLM | browser-use 主循环模型（端点见下）/ 竞赛建模档 | 浏览器多步规划、建模推理 | 端点未锁前成本不定；竞赛预算 U4 待定 | ~80%（若走本地免费端点则计费占比归 0，见 U4） |

> **浏览器主循环端点（统一成本口径）**：默认走 `Browser('chromium')` + 现有 `models.js` 的 OpenAI 兼容端点（`base_url` 指向本地/免费服务），此时浏览器主循环**无 API token 费**（算力自担），表中 ~80% 是"推理调用量占比"而非计费额；仅当用户显式开启付费强力模型（如 bu-4.0 云网关）时才成为真实主成本。两种口径不得并存表述——默认=免费端点，付费=显式开启（U4）。
> **来源诚实声明**：AnyJev 作者自报的 0.730 是 **Qwen3-1.7B** 的成绩，**不代表本项目选用的 8B**（8B 为留能力余量，未引用该分数背书）；ollaya 的 8–10ms 亦为作者自报。两者均未经本项目独立复现；模型价格以各官网实时为准，本文档不代厂商承诺。

---

## 4. 六层设计（现有 mock harness → 真实能力）

### 4.1 E 执行循环
- **设计决策**：沿用 `agent.run` 的 `plan→tool→observe` 固定管线；外部 agent（browser-use）作为单个 `browser.run_task` 工具黑盒调用，其内部循环不纳入主控轮次计数。终止条件归 V（单一来源=§4.6 的 `eval.*` 返回值）：刷课=`eval.course` 判定进度达标或遇验证码转人工；竞赛=`eval.project` 判定通过；jev=`eval.jev` 判定用户确认填入。三道保险沿用（maxSteps≤50、token 预算、每步 timeout）。失败分类回喂：瞬时重试（现有 retry）、模型错误带纠正重 prompt、永久走 fallback、资源不足转人工。**打转检测新增**：连续 N 次相同 `tool+args` 指纹打断（现有缺失）。墙钟预算：浏览器长任务上限 + 可中断（streaming-interruptibility 模式）。
- **落地规格**：在 `agent.js` 增加 `fingerprintLoop(trace)` 与 `wallClockBudgetMs`；`browser.run_task` 以 `abortSignal` 支持取消；取消时输出"已发生副作用清单"（已播放章节 / 已写文件）。

### 4.2 T 工具注册
- **设计决策**：现注册表扩为四族——`browser.*`（browser-use / playwright-mcp）、`notebook.*`（作业）、`research.*`（竞赛）、`decide.*`（AnyJev）+ 既有 `jev.*`/`desktop.*`/`audit.*`。**注册≠披露≠授权**：副作用工具强制 gate（已实现），新增 `sideEffect` / `external` / `licenseTag` 元数据；第三方工具描述（name/description/schema）来自不可信外部，须过审且版本锁定（U6）。Python 工具在**受限子进程**执行。**凭证隔离的具体机制（统一口径）**：真实 LLM key 只存在于父进程（沿用现有"从 `process.env` 读、不落盘"），父进程在 `127.0.0.1` 起一个最小 LLM 反向代理；子进程只拿到代理地址与一个无意义的占位 key（如 `local-proxy`），由代理注入真实 key 后转发。因此 §8.2 代码里的 `api_key` 是**占位值**，不是真实凭证——子进程全程不接触真实 key。有界并行池上限 ≤4（防止多浏览器并发打爆）。
- **落地规格**：`lib/tools/registry.js` 统一注册；每个适配器实现 `{ name, description, schema, sideEffect, external, licenseTag, run(provider, args, ctx) }`；`browser-use` 适配器通过 `child_process.spawn` + JSON-over-stdio 通信；父进程代理实现为 `lib/proxy/llm-relay.js`（仅监听 127.0.0.1、仅转发白名单端点）。

### 4.3 C 上下文管理
- **设计决策**：主控 prompt 前缀字节稳定（prefix-stable-context 模式）：系统指令 / 工具定义 / 规则固定序，时间戳与随机 id 只进可变尾部；工具子集按固定序披露而非按相关性重排（deterministic-serialization 模式）。浏览器页面快照、检索片段作为"待分析数据"截断并标记，与指令分隔（防 prompt injection）。昂贵且确定的结果复用（result-memoization）：同一课程页 DOM 快照、同一赛题检索结果，按内容寻址键缓存。
- **落地规格**：`lib/context/assemble.js` 输出 `{ stablePrefix, volatileTail }`；缓存键 = sha256(输入+版本)，失效条件先于实现定义（版本/TTL/权限）；写操作与非幂等调用禁止缓存。

### 4.4 S 状态存储
- **设计决策**：沿用 `runs/*.trace.json`（事件溯源），新增版块运行态 `runs/{runId}.state.json`（进度/产物路径/幂等键）。**会话恢复 ≠ 外部行动恢复**：刷课/竞赛写操作带幂等键 + 状态查询（如读取真实进度确认），超时后先查状态再决定是否重试。证据版本绑定：验证结论绑定外部项目版本（browser-use 版本 / 模板版本），版本变则旧结论失效。
- **落地规格**：`lib/state/store.js` 提供 `loadState/saveState/withIdempotencyKey`；并发写单写进程串行化。

### 4.5 L 生命周期钩子
- **设计决策**：沿用已加固的审批凭证（一次性/60s/绑定会话）+ Host/Origin/token 三重访问控制 + 高危强拦。**人在回路四档**落到每个版块：刷课验证码=直接阻断转人工；作业脱敏导出=执行前确认；竞赛交卷=执行前确认；jev 填入=自动执行+执行后告知（用户手动发送）。快筛（若有）不得看执行者推理。
- **两道询问门禁（U2 用户拍板，全局强制）**：任何"生成类"动作（起草回复 / 生成计划 / 生成论文Sections / 生成答题答案）必须经过 **生成前询问 → 生成 → 完成后询问** 三段式：
  1. `askBeforeGenerate`：生成前弹出确认卡，展示"将生成什么 / 目标 / 口径 / 预计成本"，用户确认后才调用模型；
  2. 生成产物；
  3. `askAfterGenerate`：完成后展示产物 + AI 生成披露声明，用户选择"采用 / 修改 / 丢弃"，未确认不得进入下一步（填入/导出/提交）。
  两道门禁复用现有审批凭证机制（一次性 token + gate），计入 trace；`auto-approve` 开关仅影响起草类轻量步骤，作业/竞赛的生成后采用必须人工点选，不可自动批准。
- **落地规格**：`pre-hook` 挂 gate 校验与 `askBeforeGenerate`，`post-hook` 挂 `askAfterGenerate` + 审计与脱敏；新增 `onInterrupt` 收集副作用清单。前端新增统一确认卡组件（复用 `.d-card`/`.btn` 样式），后端 `/api/agent/approval` 已支持 steps 级审批，扩展为携带 `{kind:'before'|'after', artifact}` 的审批请求。

### 4.6 V 评估接口
- **设计决策**：**工具回执 ≠ 业务事实**。刷课以平台真实进度为 oracle（借鉴 Autovisor 的"读取真实进度"思路）；作业/竞赛以产物文件存在 + 编译退出码 + 引用/数字追溯断言为 oracle；jev 以"高危零自动写入 + auto_sent=false"断言。**生成者与评估者分离**：竞赛的 `eval.project` 用独立上下文、不看生成推理、显式标准、迭代预算≤3（借鉴 MathModelAgent 第六技能 `6verity` 的**方法论**——其六技能流水线与"9 步验证"是被参考对象，本 harness **自研实现**，不复制其代码、不复用其 skill 文件）。终止判据唯一来源 = 本节 evaluator，§1 的 oracle 表述同此。
- **落地规格**：`lib/eval/` 每版块一个 evaluator，返回结构化 `{ pass, evidence[], failures[] }`，禁止自由散文。

---

## 5. 模型组合与任务分派

- **形态判定**：**形态 B（单智能体 + 循环内多档模型）**。显式质疑：为何不是 A 单模型？——任务异质（浏览器多步规划 vs 类型化决策 vs 起草），且成本敏感（学生），满足分档触发条件。为何不是 C 多 Agent？——未命中三条硬墙（无实测上下文退化、无需新鲜上下文并行、工具选择未冲突），单 Agent + 多档模型已足够，按编排决策卡不放行多 Agent。
- **任务-模型分派表**

| 步骤 | 档位 | 理由 | 成本/延迟预算 |
|---|---|---|---|
| 高危意图/风险判定 | 决策型（AnyJev 本地） | 封闭答案集、高频、需置信度 | 本地，ms 级；配额 0 |
| 候选回复起草 | 快速低价 LLM | 语义简单、容错大 | 免费档优先；~20% token |
| 浏览器多步规划 | 强力 LLM（browser-use 内） | 开放推理、跨步因果 | 默认免费端点→计费 0、推理量~80%；付费档开启才成主成本（见 §3 统一口径） |
| 竞赛建模/写作 | 强力 LLM | 开放推理 | 预算 U4 待定 |
| 进度/产物核对、脱敏、schema | 确定性代码 | 可枚举可断言 | 0 |

- **token 预算按档位分配**：见上表百分比；评估步骤（V）计入预算，不做事后隐性支出。**口径统一**：§3 表头"token 占比"改为"主控计费 token 占比"，本地决策/免费档记 0 但仍有算力消耗；浏览器黑盒内部的 token 消耗不计入主控占比（见下条缓存作用域）。
- **缓存与重算账**：稳定前缀命中率目标 ≥80%，**作用域限定为主控 `assemble.js` 产出的 prompt 前缀**（观测口径：主控命中 token / 主控总 token），不含外部 browser-use 黑盒内部循环——后者前缀由外部项目自管，主控够不着，不可混入本指标。浏览器 profile 复用登录态；换模型 = 前缀失效，级联升级时记账。
- **级联升级条件**：决策型模型置信度 < 阈值 → 升级强力 LLM 复核；起草被 V 判不合格 → 换档重试 ≤2 次。
- **降级链**：AnyJev 不可用 → 关键词硬规则兜底 + 强制转人工（绝不静默降级为"通过"）；强力 LLM 限流 → 退低价档并标注降级；**浏览器 agent（browser-use）不可用 → 不改变工具接口，切到"确定性脚本子集"：由主控持 loop，经 playwright-mcp 的原子工具按 `config/sections/*.yaml` 预定义步骤执行**——能力损失明确为"失去 agent 自主规划，仅能跑预定义路径"，且此路径须在 P1 阶段与 browser-use 适配器一并实现才可降级；两者皆不可用时直接转人工，不静默失败。
- **评估者档位与生成者档位关系**：评估用独立上下文 + 显式标准，可与生成同档但必须分离（便宜不是跳过分离的理由）。

---

## 6. 多 Agent 编排

不适用 + 理由：四版块均为单 Agent 循环内多档模型（形态 B）。browser-use 与 MathModelAgent 虽内部多角色/自带 loop，但作为 as-tool 黑盒被调用，其编排属外部项目内部实现，不是本 harness 的多 Agent 决策。本 harness 未命中三条硬墙，按 h-framework 编排决策卡不放行多 Agent（避免组织架构翻版与 Frankenprompt）。

---

## 7. 模块 / 目录结构（代码骨架）

```
moyu-agent-workbench/
  server.js                       # 主控 HTTP（已加固：Host/Origin/token、审批凭证）
  lib/
    agent.js                      # E 执行循环（扩：打转检测/墙钟预算/副作用清单）
    models.js                     # 模型适配层（沿用 9 预设）
    profile.js                    # 凭据正向白名单（沿用）
    jev-tools.js                  # 既有 jev/desktop/audit 工具
    proxy/llm-relay.js            # 父进程本地 LLM 反代（注入真实 key，子进程只拿占位 key）
    tools/
      registry.js                 # T 工具注册（新增）
      browser-use.adapter.js      # 刷课：browser-use 子进程桥接（新增）
      playwright-mcp.adapter.js   # 刷课兜底（新增）
      notebook.adapter.js         # 作业：notebook 骨架/执行/脱敏（新增）
      research.adapter.js         # 竞赛：检索/实验/渲染（新增）
      decide.adapter.js           # jev：AnyJev 本地决策服务桥接（新增）
    context/assemble.js           # C 前缀稳定组装（新增）
    state/store.js                # S 运行态 + 幂等键（新增）
    eval/                         # V 四版块 evaluator（新增）
      course.eval.js / homework.eval.js / project.eval.js / jev.eval.js
  tools_python/                   # 外部 Python 工具宿主（新增，独立 venv）
    browser_runner.py             # 封装 browser-use Agent，JSON-over-stdio
    anyjev_server.py              # 封装 AnyJev Decider，本地 HTTP
    requirements.lock             # 精确版本（browser-use==1.0.6 等）
  config/
    sections/*.yaml               # 四版块声明式流程（新增）
  test/
    core.test.js / http.test.js   # 既有回归（27 项）
    adapters.test.js              # 新增适配器单测
  designs/ → 本文档（位于工作区根 designs/）
```

---

## 8. 关键接口签名

### 8.1 工具适配器接口
```js
// lib/tools/registry.js
/**
 * @typedef {Object} ToolAdapter
 * @property {string} name               // 唯一工具名，如 'browser.run_task'
 * @property {string} description        // 写入 prompt 的描述（不可信外部来源需过审）
 * @property {Object} schema             // JSON Schema，入参校验
 * @property {'none'|'fill'|'clipboard'|'external'} sideEffect
 * @property {boolean} external          // 是否外部 harness
 * @property {string} licenseTag         // 'MIT'|'Apache-2.0'|'source-available'|'internal'
 * @property {(provider:Provider,args:Object,ctx:Ctx)=>Promise<Object>} run
 */
function registerTool(adapter: ToolAdapter): void;
function listTools(opts:{ disclose?:string[] }): ToolAdapter[]; // 固定序披露
```

### 8.2 浏览器工具接口（browser-use 桥接）
```js
// lib/tools/browser-use.adapter.js
/**
 * @typedef {Object} BrowserTaskArgs
 * @property {string} task           // 自然语言任务
 * @property {string[]} allowedDomains
 * @property {number} maxSteps
 * @property {boolean} reuseProfile // 复用登录态 profile
 * @property {number} wallClockMs
 */
// 返回 BrowserTaskResult
/**
 * @typedef {Object} BrowserTaskResult
 * @property {string} finalResult
 * @property {Array<{step:number,action:string,observation:string}>} trace
 * @property {string[]} sideEffects     // 已发生副作用清单（可中断时输出）
 * @property {boolean} aborted
 */
async function run(provider, args: BrowserTaskArgs, ctx): Promise<BrowserTaskResult>;
```
Python 侧（`tools_python/browser_runner.py`，真实 API）：
```python
from browser_use import Agent, Browser, ChatOpenAI
# base_url 指向父进程本地 LLM 代理(127.0.0.1)，api_key 为占位值——真实 key 只在父进程注入
agent = Agent(
    task=args["task"],
    llm=ChatOpenAI(model=model, base_url="http://127.0.0.1:RELAY_PORT/v1", api_key="local-proxy"),
    browser=Browser("chromium", headless=True),
)
result = agent.run_sync()
print(json.dumps({"finalResult": result.final_result(), ...}))
```

### 8.3 决策工具接口（AnyJev 桥接）
```python
# tools_python/anyjev_server.py（真实 API）
from anyjev import Decider, Question
from anyjev.backends.hf import HFBackend
decider = Decider(HFBackend("Qwen/Qwen3-8B"))
route = Question.choice("Which action?", ["draft","ask_human"], name="route")
risky = Question.noul("Is this high-risk?", name="risky")
result = decider.decide(state, [route, risky])
# result["route"].distribution, result["risky"].p_true, result.level
```
```js
// 本地 HTTP 暴露给主控（沿用 /api 风格，走既有 token 防护）
POST /tool/decide  body:{state,questions}  -> {distributions, level, confidence}
```
> 策略全在代码层：`confidence < 阈值 → ask_human`，禁止模型自判放行（对齐 L 层高危纵深）。

### 8.4 询问门禁钩子接口（U2 新增）
```js
/**
 * @typedef {Object} AskRequest
 * @property {'before'|'after'} kind
 * @property {string} runId
 * @property {number} stepId
 * @property {string} summary          // 将生成/已生成的摘要
 * @property {string} [disclosure]     // after 时必填：AI 生成披露声明
 * @property {Object} [artifact]       // after 时：产物引用（路径/id，非全文）
 */
/**
 * @typedef {Object} AskDecision
 * @property {boolean} approved
 * @property {'adopt'|'revise'|'discard'} [action]   // after
 * @property {string} [token]           // 服务端签发的一次性审批 token
 */
// 生成前：返回审批 token，未获批准则跳过生成步骤并记 trace
async function askBeforeGenerate(req: AskRequest): Promise<AskDecision>;
// 生成后：未 adopt 则产物不进入填入/导出/提交
async function askAfterGenerate(req: AskRequest): Promise<AskDecision>;
```
前端统一确认卡消费 `/api/agent/approval` 扩展字段 `{kind, artifact}`；两钩子均写 trace，`after` 未通过时 `ctx.filled` / 产物引用保持为空。

---

## 9. 核心数据结构

### 9.1 运行态（runs/{runId}.state.json）
```json
{
  "runId": "string",
  "section": "course_auto|homework|project_lab|jev_reply",
  "status": "running|awaiting_approval|done|failed|interrupted",
  "progress": { "current": 0, "total": 0, "unit": "chapter|cell|step" },
  "artifacts": ["相对路径数组"],
  "idempotencyKeys": ["幂等键数组"],
  "sideEffects": ["已发生副作用描述"],
  "externalVersions": { "browser-use": "1.0.6", "template": "vX" },
  "updatedAt": "ISO8601"
}
```

### 9.2 审批凭证（已实现，沿用）
`server.js` 内 `approvals: Map`（键为 token，值为 `{steps, exp, session}`），一次性 / 60s / 绑定会话。

### 9.3 工具元数据
见 §8.1 `ToolAdapter` typedef。

---

## 10. 配置文件格式（声明式流程 schema）

```yaml
# config/sections/course_auto.yaml
id: course_auto
name: 刷课
kernel: browser-use            # browser-use | playwright-mcp
browser:
  provider: chromium           # chromium（本地CDP） | chrome（复用登录）
  reuse_profile: true
  headless: false
  allowed_domains: ["example.edu.cn"]   # U1 平台清单待拍板
  wall_clock_ms: 3600000
  on_captcha: ask_human        # 直接阻断转人工
steps:
  - id: 1
    tool: browser.run_task
    args: { task: "登录并进入课程列表", max_steps: 15 }
    gate: false
  - id: 2
    tool: browser.run_task
    args: { task: "播放当前章节并跳到下一节", max_steps: 8 }
    gate: false
    loop_until: "progress.current == progress.total"   # 终止条件归 V
  - id: 3
    tool: eval.course
    args: { oracle: "platform_reported_progress" }      # 工具回执≠业务事实
    gate: false
boundary: "只推进度，不改成绩，不产证书"   # U1 需用户确认
license_note: "browser-use MIT；本地浏览器 CDP 端口未鉴权，勿在多用户共享机使用"
```

---

## 11. 层间交叉检查

| 关系 | 说明 |
|---|---|
| E ↔ V | 终止条件由 V 的 evaluator 给，executor 不自评；`loop_until` 引用 V 产出的 progress |
| T ↔ L | 注册的工具经 L 层 gate 披露；`external:true` 工具额外要求版本锁定与许可过审 |
| C ↔ T | 工具描述来自外部（不可信），进前缀前须消毒 + 固定序，避免前缀失效与注入 |
| S ↔ V | evaluator 结论绑定 `externalVersions`，版本变则结论失效 |
| P ↔ 单/多 Agent | 混合供给决定了 browser-use 走 as-tool，而非 full handoff，故不上多 Agent |

---

## 12. 六层决策表

| 层 | 决策 | 依据 | 状态 | 是否有意不做（及理由） |
|---|---|---|---|---|
| E | 固定管线 + 外部 agent 黑盒 as-tool；新增打转检测/墙钟预算 | 现有 agent.run；h-framework E Q5/Q8 | 默认假设 | 不做动态脚本模式（任务结构已清晰） |
| T | 四族注册 + 注册≠披露≠授权 + 子进程隔离 + 有界并行≤4 | efficiency-and-caching 有界并行；现有安全策略 | 默认假设 | 不全量暴露工具（按需固定序披露） |
| C | 前缀稳定 + 外部内容消毒 + 结果复用 | prefix-stable-context / deterministic-serialization / result-memoization | 默认假设 | 不做按相关性重排工具（会作废前缀） |
| S | 事件溯源 + 运行态 + 幂等键 + 证据版本绑定 | state-and-history 模式；现有 trace | 默认假设 | 不做多节点状态同步（单机） |
| L | 审批凭证 + 三重访问控制 + 高危纵深 + 四档人在回路 | 现有加固；capability-security 模式 | 已确认 | 快筛模型暂不引入（审批量未到阈值） |
| V | 独立 evaluator + 权威系统核对 + 生成/评估分离 + 迭代≤3 | h-framework V Q1/Q3/Q5；MathModelAgent `6verity` 方法论参考（自研实现） | 默认假设 | 不用 agent 自评（禁止） |

---

## 13. 生产级必答项

| # | 必答项 | 结论 |
|---|---|---|
| 1 | 执行环境 / 凭证是否进环境 | Python 工具在受限子进程；凭证不进子进程环境，父进程代理注入（现状已"key 只从服务端 env 读"） |
| 2 | 错误回喂 | 分类四种回喂 observe；禁止吞异常（现有 agent.js 已记 retry/degrade） |
| 3 | 打转检测与熔断 | 新增连续 N 次 tool+args 指纹检测；墙钟上限 + maxSteps 双保险 |
| 4 | 记忆治理 | 运行态存 runs/，带 externalVersions；未验证推测不升级为事实（沿用脱敏 Фиingerprint） |
| 5 | 外部副作用幂等 | 刷课/竞赛写操作带幂等键 + 状态查询；超时先查状态再重试 |
| 6 | 证据版本绑定 | evaluator 结论绑 externalVersions，版本变失效 |
| 7 | 生成者与评估者分离 | V 用独立上下文 + 显式标准 + 迭代预算≤3；不看生成推理 |
| 8 | 前缀稳定与缓存命中 | stablePrefix/volatileTail 划分；固定序序列化；命中率 ≥80% 观测；换模型记失效 |

---

### 13.1 可编码三门槛自检（硬性）

| 门槛 | 结论 | 落点 |
|---|---|---|
| **类型完整** | 通过 | §8 所有接口签名引用的类型均已在 §8.1（`ToolAdapter`/`@typedef`）、§8.2（`BrowserTaskArgs`/`BrowserTaskResult`）、§9（运行态/审批/工具元数据）给出字段定义，无悬空类型名 |
| **API 真实** | 通过 | §8.2/§8.3 的 `Agent(task,llm,browser).run_sync()`、`final_result()`、`Browser('chromium')`、`ChatOpenAI(model,base_url,api_key)`、`Decider(HFBackend(...))`、`Question.choice/noul`、`decider.decide(...)` 均来自 2026-11-17 真机检索的官方 README，未虚构参数；`browser-use==1.0.6` 为官方强制 pin |
| **标准可达** | 通过（含未知区） | 量化项均拆为验证路径：进度达标=平台真实进度（§4.6）、编译=退出码+产物存在、高危=零自动写入断言、命中率≥80%=命中token/总token；模型成功率上限作者自报不可独立复现的已标 K3 未知区，不写死指标 |

### 13.2 多 Agent 评估面标注

不适用 + 理由：本文档形态为单智能体 + 循环内多档模型（§5、§6），未引入多 Agent 编排，故 h-framework 多 Agent 编排决策卡的「任务集 / 路由准确率 / 折叠口径 / 嵌套循环账 / 回传损失」评估面不适用。browser-use 与 MathModelAgent 的内部多角色属外部项目实现，作为 as-tool 黑盒调用，其评估由各自 V 层 evaluator（§4.6）按权威来源独立核对，不构成本 harness 的多 Agent 编排。

## 14. 参考架构图

```
用户 ──HTTPS/token──> Node 主控 server.js (E 执行循环)
                          │  register/limit
                          ▼
                    T 工具注册表 (registry.js)
        ┌─────────────┬─────────────┬──────────────┬──────────────┐
        ▼             ▼             ▼              ▼              ▼
   jev.*/audit.*  browser.*     notebook.*    research.*     decide.*
   (内置 Node)    子进程桥接     (Python/CLI)   (Python/skills) 本地HTTP
        │             │             │              │              │
        │        browser-use      jupyter       OMMW/Math*     AnyJev
        │        Chromium/CDP     notebook      (版本/许可)    Qwen3 本地
        │        (内置浏览器)                                     │
        └─────────────┴─────────────┴──────────────┴──────────────┘
                          │ observe（结构化）
                          ▼
                    V evaluator（独立上下文）
                    权威系统核对（进度/产物/编译/追溯/高危零写入）
                          │ pass/fail
                          ▼
                    S state + 审计（脱敏 + 版本绑定）
```

---

## 15. 遗留问题与未知区（诚实标注）

| 编号 | 未知 / 风险 | 状态 | 处理 | 需谁拍板 |
|---|---|---|---|---|
| U1 | 刷课合规边界 | **已拍板**（类似 OCS） | 平台=OCS 支持列表；只推进度不改成绩为硬底线。残余：OCS 含"自动答题"，默认关闭、需 U2 生成前询问显式开启 | 残余答题边界待用户确认 |
| U2 | 学术诚信 | **已拍板**（两道询问） | 生成前询问 + 完成后询问，全生成类动作强制；产物附 AI 披露声明 | 已定 |
| U3 | 许可 | **已拍板**（只开源） | 弃 MathModelAgent；竞赛用 yohanchen1/MathModelingAgent（MIT）等 | 已定 |
| U4 | 模型成本预算上限 | **待定** | 默认本地/免费端点优先，付费显式开启 | **用户** |
| U5 | Python 运行时 | **已拍板**（是） | 独立 venv + requirements.lock 精确 pin | 已定 |
| U6 | 版本锁定策略 | **已拍板**（架构师决定） | 精确 pin + release notes 复核；适配层隔离变更半径 | 已定 |
| K1 | 外部工具破坏性变更频繁 | 已处理 | 精确 pin（如 `browser-use==1.0.6`、OCS `v5.4.0`），封装在单一适配器 | 已默认处理 |
| K2 | 本地端口未鉴权（CDP + LLM 反代） | 已处理 | 仅监听 127.0.0.1；个人单机；共享机须容器/VM | 已默认处理 |
| K3 | 浏览器 agent 真实成功率上限（作者自报 ~63%） | 已处理 | 关键步骤 gate + 可中断 + 转人工，不承诺全成功 | 已默认处理 |
| K4 | OCS 自动答题触及学术诚信（U1 残余） | 默认关闭 | 仅在用户显式开启 + U2 生成前询问授权后启用；默认只推进度 | 用户可选确认 |

---

## 16. 分阶段落地路线（建议，A4）

| 阶段 | 版块 | 交付 | 依赖 | 风险 |
|---|---|---|---|---|
| P0 | jev 回复 | AnyJev 决策适配器 + 现有 LLM 起草闭环 + 两道询问门禁 | U5 ✅ | 低 — 现有链路最完整，仅替换决策内核 |
| P1 | 刷课 | OCS 助手适配器（平台能力底座）+ browser-use 通用补位 + 进度 evaluator + 断点续播 | U1 ✅/U5 ✅/K1/K2 | 中 — OCS 脚本集成与平台 DOM 变动；答题默认关 |
| P2 | 作业 | notebook 骨架→执行→脱敏报告 + 追溯 audit + 两道询问 | U2 ✅/U5 ✅ | 中 — 产物可复现性 |
| P3 | 竞赛 | 检索→实验→反幻觉→双渲染；用 yohanchen1/MathModelingAgent（MIT）证据驱动 + 独立审计；全程 U2 两道询问 | U2 ✅/U3 ✅/U4 待定 | 高 — 学术诚信门禁 |

> 每阶段完成后必须：单测/集成测试全绿 + V evaluator 独立通过 + 回归 mock 链路不破。U1–U3/U5/U6 已拍板，可全程推进；仅 U4（预算）与 K4（OCS 答题默认关）留有默认假设，不阻塞开工。

---

## 附录 A · 检索来源清单（2026-11-17，供独立评审核对）

> 以下为本文档选型声明的原始来源。star 与版本为检索当日快照，集成前须复核。

| 声明 | 来源 URL | 核实要点 |
|---|---|---|
| browser-use MIT / 121.3k stars / v1.0 / 高级 API 写法 / CDP 未鉴权告警 | https://github.com/browser-use/browser-use | 官方 README + LICENSE；v1.0.0 (2026-11-10)、本地 `Browser('chromium')`、`ChatOpenAI(model,base_url,api_key)`、pin `==1.0.6` |
| browser-use 云/开源区分、MCP 形态 | https://browser-use.com/posts/best-browser-agent-mcp-servers | 开源 MCP stdio、本地 Chromium over CDP、无 stealth/CAPTCHA |
| playwight-mcp / Browser Use / Stagehand / Skyvern star 对比 | https://dedupedai.com/best-ai-repos-for/browser-automation | 快照日期 2026-11-06：playwright-mcp 39,252、browser-use 120,170、chrome-devtools-mcp 54,867 |
| 浏览器 agent 真实成功率上限 ~63%（BU Bench）/ 各项目许可 | https://www.digitalapplied.com/blog/open-source-browser-computer-use-agents-2026 | browser-use 108,128 MIT、Stagehand 23,753 MIT、Skyvern 22,695 AGPL；开源库 63.3% ≠ 云 97% |
| Skyvern AGPL-3.0 / vision-first | https://runany.dev/blog/skyvern-browser-automation | GitHub API license.spdx_id=AGPL-3.0，stars 22,616 (2026-07-29 快照) |
| MathModelAgent 六技能流水线 / 17 Typst 模板 / 禁商用 / SKILLS-first | https://pyshine.com/MathModelAgent-AI-Math-Modeling-3-Days-to-1-Hour/ 、 https://techmoon.xyz/?p=32367 | `1start…6verity`、个人免费禁商用（source-available）、npx skills add |
| AnyJev Apache-2.0 / pre-alpha / choice-score-noul / 0.730 属 1.7B | https://jevai.dev/anyjev | 官方站：Nokia Applied Research、L0/L2、`Decider/Question/HFBackend`、1.7B=0.730 |
| ollaya Apache-2.0 / 很新 / wire 兼容 / 8–10ms 作者自报 | https://ollaya.dev 、 https://jev.aitools.fyi/tools/ollaya-dev-ollaya | 创建 2026-09-23、~153→1.3k star、`POST /v1/systemone`、:11435 |
| Autovisor 智慧树刷课 / config.ini 外置 / 进度读取 | https://github.com/CXRunfree/Autovisor | 2026-09-15 公告、3.18.4、Playwright、作者佛系更新 |
| **OCS 网课助手 MIT / ~4.3–4.5k stars / v5.4.0 / 平台列表** | https://github.com/ocsjs/ocsjs 、 https://github.com/orgs/ocsjs/repositories 、 https://docs.ocsjs.com/ | MIT；2026-11-08 发 v5.4.0；支持超星学习通/智慧树/职教云/智慧职教/中国大学MOOC；含自动播放/课件阅读/弹窗答题/AI 搜题（答题默认关，见 K4） |
| **yohanchen1/MathModelingAgent MIT / 证据驱动 / 独立审计 skill** | https://blog.yeyupiaoling.cn/article/1788106723596 | MIT、v0.3.1；`math-modeling-agent` + `math-modeling-audit` 两 skill；Claim/Obligation/Evidence、PASS/FAIL/INCONCLUSIVE |
| **handsomeZR-netizen/mathmodel-skill MIT / 10 阶段 / decision_log** | https://www.claudecodeagents.com/skills/mathmodel-skill | MIT；CUMCM/MCM/ICM、10 stages、持久决策状态、确定性评分助手 |
| dsh-ultramath MIT / 三席盲评 / 数字冻结（观察项） | https://dsh-plugin.org/plugins/andiii208/dsh-ultramath | MIT、v0.6.0；5 角色预设、33 篇模型库、学术诚信 7 门控；DSH 生态 |

**未取得可靠快照的声明**（诚实标注）：OMMW `workbuddy-modex` 的 star 与许可细节沿用项目内 `data.js` 既有记录，本轮未独立联网复核；ojihe520/MathModelAgent 已弃用（U3），其数据仅作历史记录。
