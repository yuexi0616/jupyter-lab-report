# 摸鱼 Agent 工作台（方案原型 v0.2）

一个**本地前后端工作台**：用 Web UI 管理**课程表**，浏览「摸鱼 agent」四版块方案（作业版块模板 → 刷课 / jev 自动回复 / 毕设竞赛），查看 GitHub 选型、模拟任务计划与审批门禁、编辑脱敏档案、跑体检。

形态参考 DeepSeek Harness（dsh）的「本地 Web UI + 后端运行时」，含**自动任务执行引擎**（agent loop：计划→工具调用→观察→反思→闭环）：
- ✅ 零依赖（Node 内置 http，不需要 `npm install`）
- ✅ 前端原生 HTML/CSS/JS，无构建步骤
- ✅ **课程表**：周视图、单双周、当前/下节课、冲突检测、连续空闲窗口、ICS 日历导入导出、今日摘要与上课提醒（纯本地，不登录教务系统）
- ✅ 可替换大模型：9 个预设（腾讯混元 Hy4/智谱/硅基流动/火山方舟/通义/DeepSeek/Kimi/自定义/mock），均 OpenAI 兼容
- ✅ jev 场景闭环：决策→起草→排序→fill-only 填入→审计，含 gate 审批、重试/降级
- ✅ 真实桌面模式：剪贴板读写（Windows），读对方消息 → 写回复到剪贴板，fill-only
- ❌ 不自动发送消息、不碰支付、不接真实聊天软件；屏幕读取因安全策略禁用
- ❌ 不登录教务系统、不爬取、不代抢课；课程表数据只存本机
- ❌ API key 只从服务端环境变量读取，不落盘、不经过前端

## 运行

要求 Node.js ≥ 18（本机为 v22）：

```bash
cd moyu-agent-workbench
node server.js
# 打开 http://127.0.0.1:3080
```

自定义端口：`MOYU_PORT=3081 node server.js`

运行回归测试（零依赖，Node 内置 test runner，含单测 + HTTP 集成测试共 121 项）：

```bash
node --test
```

测试在独立端口拉起真实 server 子进程，覆盖访问控制、审批凭证、方案数据与计划生成，结束后自动清理，无需手动启动服务。

## 页面

| 页面 | 内容 |
|---|---|
| 总览 | 三版块卡片、架构四层图、迭代路线表 |
| **课程表** | 七周日视图（节次 × 星期）、单双周过滤、当前/下节课、连续空闲窗口、课程增删改、学期设置、JSON/ICS 导入、导出日历、上课提醒、独立自检 |
| 刷课 / jev / 毕设竞赛 | 各版块六项 + 与模板复用关系 + GitHub 选型表 |
| 会话 / 计划 | 选版块 → 生成模拟命令链 → 审批门禁（gate）演示 |
| **自动执行** | 选模型 + 填会话快照 → 跑 agent loop → 看决策/候选/填入/轨迹/异常；含历史运行 |
| **真实桌面模式** | 顶部勾选「真实桌面」：先复制对方消息 → 点发送 → 工具读剪贴板 → 决策起草 → **回复写入剪贴板**，用户自行粘贴；不自动发送 |
| 开源选型 | 全部候选项目，可按关键词过滤 |
| 环境档案 | 查看/编辑 `data/profile.json`（保存时后端强制脱敏清洗） |
| 体检 | 模拟 `doctor`，检测 `REPLACE-*` 占位档案并判 DEGRADED |

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/meta` `/api/sections` `/api/sections/:id` | 方案元数据与版块详情 |
| GET | `/api/kernel` `/api/harness` `/api/roadmap` `/api/questions` | 共享内核 / harness / 路线 / 待确认 |
| GET | `/api/health` | 体检（占位档案检测） |
| GET/PUT | `/api/profile` | 读取 / 写回脱敏档案 |
| POST | `/api/plan` | `{sectionId, task}` → 模拟计划与审批 gate |
| GET | `/api/models` `/api/tools` | 模型预设（含 key 就绪状态）/ 工具注册表 |
| DELETE | `/api/agent/runs/:id` `/api/agent/runs` | 删除单条 / 清空全部会话 |
| POST | `/api/agent/run` | `{preset, task, approvals, ...}` → 真实 agent loop 闭环，落盘轨迹 |
| GET | `/api/agent/runs` `/api/agent/runs/:id` | 历史运行 / 单次轨迹 |
| GET | `/api/projects/search?q=` | 全部开源选型，可过滤 |
| GET | `/api/timetable/meta` | 星期/节次/周次语法/边界说明 |
| GET | `/api/timetable?week=` | 指定周视图 + 今日 + 冲突 + 空闲窗口（`?at=` 可注入时钟） |
| GET | `/api/timetable/today` | 当前课 / 下一节 / 今日空闲 |
| GET | `/api/timetable/digest` | 今日摘要（侧栏 + 提醒器用；`?at=` 可注入时钟） |
| POST | `/api/timetable/term` | `{name,startDate,totalWeeks,periods?}` 设置学期 |
| POST | `/api/timetable/courses` | 添加课程，冲突返回 409（`force:true` 可强制） |
| PUT/DELETE | `/api/timetable/courses/:id` | 修改 / 删除单门课程 |
| DELETE | `/api/timetable/courses` | 清空全部课程 |
| POST | `/api/timetable/import` | `{term,courses,mode,dryRun}` 批量导入（预校验不写盘） |
| POST | `/api/timetable/import/ics` | `{ics,mode,dryRun}` 导入 .ics（需先设学期；事务式） |
| GET | `/api/timetable/export.ics` | 导出 `text/calendar`（含 10 分钟提醒） |
| POST | `/api/timetable/demo` | 载入示例课表（demo=true，可清空） |
| POST | `/api/timetable/eval` | 独立自检（PASS/FAIL/INCONCLUSIVE） |
| GET | `/api/course/meta` `/api/course/sessions` | 刷课平台清单/后端信息、会话列表 |
| POST | `/api/course/create` | `{url,total,sessionId}` → 识别平台并创建会话（答题不可开启） |
| POST | `/api/course/{id}/tick\|pause\|resume\|eval` | 推进章节 / 断点暂停恢复 / 验证码后恢复 / 独立核验 |
| DELETE | `/api/course/{id}` | 删除刷课会话 |
| GET | `/api/homework/meta` `/api/homework/sessions` `/api/homework/{id}` | 作业 SOP 说明 / 会话列表 / 单会话 |
| POST | `/api/homework/create` | `{title,genAuthToken}` → 生成 notebook 骨架（需 U2 生成前授权） |
| POST | `/api/homework/{id}/advance\|eval` | 推进 SOP 一步（deliver 需 adopt=true）/ 独立核验 |
| DELETE | `/api/homework/{id}` | 删除作业会话 |
| GET | `/api/project/meta` `/api/project/sessions` `/api/project/{id}` | 竞赛方法说明 / 会话列表 / 单会话 |
| POST | `/api/project/create` | `{topic,genAuthToken}` → 立题（需 U2 生成前授权） |
| POST | `/api/project/{id}/advance\|eval` | 推进阶段（write 需 adopt=true）/ 独立审计 |
| DELETE | `/api/project/{id}` | 删除竞赛会话 |

## 切换模型（live 模式）

前端只选预设，key 在服务端设置（前端传的 apiKey 会被忽略）：

```bash
export HUNYUAN_API_KEY=你的key   # 腾讯混元 Hy4 / 混元（当前对话同源模型）
export ZHIPU_API_KEY=你的key     # 智谱 glm-4-flash 永久免费
# 或 SILICONFLOW_API_KEY / ARK_API_KEY / DASHSCOPE_API_KEY / DEEPSEEK_API_KEY / MOONSHOT_API_KEY
node server.js
```

混元 Hy4 说明：`hy4` 预设走 `https://api.hunyuan.cloud.tencent.com/v1`，默认模型 `hunyuan-turbo`；Hy4 正式版需在腾讯云 TokenHub 开通、key 在 TokenHub 控制台创建。前端「模型 ID」框可填 `hunyuan-pro` / `hunyuan-lite` / `hy4` 覆盖默认值。**确切 model id 以 TokenHub 控制台为准**（文档未公开 Hy4 正式 model id，需实测确认）。

不设 key 时选 live 预设会返回 400 并提示缺哪个环境变量；mock 预设离线可跑。详见 `docs/自动执行方案.md`。

## P0：真实决策内核 + 两道询问门禁

落地设计见 `../designs/摸鱼Agent-四版块落地-harness-design-v2.md`。P0 已完成：

- **可插拔决策器**（`lib/decider.js`）：`GET /api/decider` 查看当前后端。默认 `mock`（离线闭环，保证回归）；三种后端 `mock` / `llm` / `anyjev`，由 `config/decider.json` 或环境变量 `MOYU_DECIDER_BACKEND` 配置。**前端不能改后端**（安全判断不受客户端影响）。
- **AnyJev 本地决策服务**（可选）：`tools_python/anyjev_server.py`，需 Python 3.10+。启用步骤：
  ```bash
  cd tools_python
  python -m venv .venv && source .venv/bin/activate   # Windows: .venv/Scripts/activate
  pip install -r requirements.lock
  python anyjev_server.py --port 11436                # 首次运行会下载 Qwen3-8B
  # 另开终端：MOYU_DECIDER_BACKEND=anyjev node ../server.js
  ```
  服务不可用时**失败转人工、绝不静默降级为 mock**（mock 高危判断靠关键词会漏判）。模型 id `Qwen/Qwen3-8B` 为能力余量选择，作者自报的 0.730 分数属 1.7B、本项目不引用其背书。
- **U2 两道询问门禁**：生成前询问（前端发送按钮两段式确认："发送"→"确认生成？"，4 秒超时复位）+ 完成后询问（fill-only，回复只填入输入框、用户手动决定发送）。`lib/agent.js` 提供 `askHooks.beforeGenerate` / `afterGenerate` 服务端钩子，未采用则草稿作废、禁止填入，全程写 trace。
- P0 阶段测试 10 项（全项目最终 **121 项**全绿；测试用独立 runs 目录隔离，不污染真实数据）。

## P1：刷课执行台（OCS 能力底座）

落地设计同见 `../designs/摸鱼Agent-四版块落地-harness-design-v2.md`。P1 已完成（**离线闭环**）：

- **能力底座**：OCS 助手（ocsjs/ocsjs, MIT）支持的 5 个平台（超星学习通/智慧树/职教云/智慧职教/中国大学MOOC）。本工作台**不 vendored OCS 源码**，只定义适配契约。
- **进度机**（`lib/course.js`）：创建会话 → 推进章节 → 断点暂停/恢复 → 验证码转人工（`awaiting_human` → 人工处理 → `resume`）。前端"刷课"版块内有执行台卡片。
- **U1 边界硬编码**：只推进度、不改成绩、不产证书；验证码/2FA 立即暂停。
- **K4 自动答题（用户决定不保守处理）**：默认关闭，但**允许显式开启**——须携带 U2 生成前询问签发的一次性 `answerAuthToken`，无 token 返回 `AUTO_ANSWER_AUTH_REQUIRED`（403）。开启后每次答题副作用记入轨迹，学术诚信责任由用户显式确认承担。
- **独立核验**（`lib/eval/course.eval.js`）：以平台真实进度为 oracle，三态 PASS/FAIL/INCONCLUSIVE（借鉴 MathModelingAgent 证据驱动）。**离线 mock 后端最多判 INCONCLUSIVE**——不把模拟进度当真实完成，这是"工具回执≠业务事实"的落实。
- **可插拔 bridge**：默认 `mock`；接入真实浏览器需本地 OCS bridge（监听 `:11437`，提供 `/tick`、`/progress`），设 `MOYU_COURSE_BACKEND=bridge`。bridge 不可用时**拒绝启动**，不伪造进度。用 `MOYU_COURSE_STATE_DIR` 可改会话存储目录。
- 全量测试最终 **121 项**（core 15 + http 20 + p0 10 + p1 15 + p2 12 + p3 12 + p4 22 + p5 15）全绿。

> **诚实说明**：离线 mock 下进度是模拟值，仅验证流程与边界；真实刷课需你自己部署 OCS/bridge 并在目标平台授权。本项目不提供、不内置任何绕过平台验证的能力。

## P2：作业执行台（母版 SOP）

- **流程**（`lib/homework.js`）：`doctor→check→cover→build→run→audit→deliver→clean→pack` 九步状态机，前端作业版块可逐步推进。
- **反占位/脱敏**：check 阶段拒绝 `REPLACE-*` 与疑似真实姓名/学号/路径（可注入泄漏样例测试）；不通过则流程 blocked。
- **结论—输出追溯**：audit 阶段每条结论必须绑定 notebook 单元输出 id，否则 blocked。
- **U2 门禁**：骨架生成需生成前授权 token（`genAuthToken`）；报告交付需生成后"采用"确认（`adopt=true`）。
- **独立核验**（`lib/eval/homework.eval.js`）：三态 PASS/FAIL/INCONCLUSIVE；mock 产物最多 INCONCLUSIVE。

## P3：竞赛执行台（证据驱动 + 独立审计）

- **方法**：借鉴 MIT 许可的 `yohanchen1/MathModelingAgent`（Claim/Obligation/Evidence + 独立 audit）与 `handsomeZR/mathmodel-skill`（10 阶段），**自研实现、不 vendored、不使用禁商用的 jihe520/MathModelAgent**。
- **反幻觉门控**（`lib/project.js`）：每条结论登记 Claim 并绑定证据；**数字冻结**（每个数字须有来源产物 id）、**引用完整性**（每条 cite 须有 sourceId）；证据不足判 **INCONCLUSIVE**，绝不强行 PASS。
- **U2 门禁**：检索/写作需生成前授权；论文交付需生成后采用确认。
- **独立审计**（`lib/eval/project.eval.js`）：独立上下文逐条裁决 Claim，三态输出；mock 证据链最多 INCONCLUSIVE。

> **诚实说明**：P2/P3 目前是离线 mock（流程、门禁、反幻觉规则可验证），产物为模拟。真实执行需你自己部署 bridge 对接 jupyter/检索/编译环境。

## P4：课程表（本地学期时间底座）

课程表是**真实功能模块**，不是方案卡片：它把「什么时候上课、什么时候连续空闲」变成可查询的本地事实，供刷课 / 作业等版块判断排期。

- **周视图**（`public/app.js`）：7 天 × 12 节的网格，课程块按节次跨行着色；单双周按周次表达式过滤；上一周 / 本周 / 下一周切换。
- **能力层**（`lib/timetable.js`）：
  - 学期：`startDate`（第 1 周周一）+ `totalWeeks` + 可选自定义作息（节次时间表）；
  - 周次语法：`1-16` / `1-16单` / `2-16双` / `1,3,5-9`，解析失败**明确报错不猜**；
  - 冲突：同一天 + 节次重叠 + 周次有交集 → 默认拒绝写入（HTTP 409），`force:true` 可强制并标记 `conflict`；
  - 今日：当前课（含剩余分钟）/ 下一节（含倒计时，可跨天）；
  - 空闲窗口：按节次表计算连续空闲段（默认 ≥2 节），用于「摸鱼窗口」。
- **独立自检**（`lib/eval/timetable.eval.js`）：重新解析落盘数据，检查结构、重复 id、冲突、周次越界；三态 `PASS` / `FAIL` / `INCONCLUSIVE`。空课表或未设学期判 **INCONCLUSIVE**，不把「没数据」当「没问题」。
- **批量导入**：JSON `{term, courses}`，`dryRun` 预校验不写盘；有任一错误则整体拒绝（事务式）。
- **ICS 日历通道**（`lib/ics.js`）：导入教务系统/手机日历导出的 `.ics`（WEEKLY 重复规则、COUNT/UNTIL/INTERVAL/BYDAY、行折叠、±10 分钟节次容差），日期按学期换算成周次；导出 `.ics` 可导入手机日历并带**上课前 10 分钟提醒**。**只读文件，不需要账号密码**；不支持的规则（DAILY/MONTHLY、全天事件、EXDATE）明确给出 warning 而不是猜。
- **课程编辑**：点课程块回填表单 →「保存修改」（PUT），不必删除重建。
- **今日摘要与上课提醒**：`digest()` 统一生成文案（侧栏显示「第 N 周 · 今天 X 节 · 下一节 14:00 体育」）；课程表内可开启浏览器通知，**上课前 10 分钟与 1 分钟各提醒一次**，已提醒课次记在 `localStorage`（`moyu_tt_sent`）去重，不会重复打扰。需保持页面打开；不申请定位/麦克风等权限，课表数据不出本机。通知被拒绝时会提示改用导出的 `.ics` 到手机日历。
- **数据位置**：`data/timetable.json`（个人数据，已加入 `.gitignore`），可用 `MOYU_TIMETABLE_FILE` 覆盖；测试用独立临时文件，互不污染。
- **边界（硬编码）**：不登录教务系统、不爬取、不代抢课、不修改学校数据；不提供「自动排课」——课表是事实输入，排期决策仍归用户。

> 示例课表（`POST /api/timetable/demo`）明确标记 `demo=true`，前端提示「示例数据」，可一键清空。

## 目录

```
moyu-agent-workbench/
  server.js               # 零依赖后端 + API（含 /api/agent/*）
  lib/data.js             # v0.2 方案结构化数据
  lib/profile.js          # 档案读写 + 脱敏清洗 + 占位检测
  lib/models.js           # 可替换大模型适配层（9 预设含 mock，OpenAI 兼容）
  lib/agent.js            # agent loop 执行引擎（计划/工具/观察/门禁/重试降级/轨迹）
  lib/jev-tools.js        # jev 男女朋友场景工具集（fill-only）
  lib/decider.js          # 可插拔决策器（mock/llm/anyjev）
  lib/course.js           # 刷课能力层（平台识别/进度机/断点/验证码/边界）
  lib/homework.js         # 作业能力层（notebook SOP/脱敏/追溯）
  lib/project.js          # 竞赛能力层（证据驱动/数字冻结/引用完整性）
  lib/timetable.js        # 课程表能力层（学期/周次/冲突/今日/空闲窗口/导入）
  lib/ics.js              # iCalendar 解析与生成（教务系统/日历 .ics 通道）
  lib/eval/course.eval.js # 刷课独立核验（三态/权威进度）
  lib/eval/homework.eval.js # 作业独立核验
  lib/eval/project.eval.js  # 竞赛独立审计（Claim 三态）
  lib/eval/timetable.eval.js # 课程表独立自检（结构/冲突/周次越界）
  config/decider.json     # 决策后端配置
  config/sections/*.yaml  # 版块声明式流程
  tools_python/           # 可选 Python 工具（AnyJev 决策服务）
  public/index.html       # 前端外壳
  public/app.js           # 前端视图与交互（含自动执行面板）
  public/style.css        # 深色主题样式
  data/profile.json       # 占位档案（首次运行自动生成，全为 REPLACE-*）
  data/timetable.json     # 个人课表（首次添加课程时生成；默认 gitignore，不提交）
  runs/                   # 运行轨迹与审计日志（默认脱敏 + 保留期清理）
  test/core.test.js       # 核心逻辑单测（extractJson/清洗/门禁/降级/脱敏）
  test/http.test.js       # HTTP 集成测试（访问控制/审批凭证/方案数据）
  test/p0.test.js         # P0 专项（决策器/两道询问门禁）
  test/p1.test.js         # P1 专项（平台识别/进度机/验证码/核验三态）
  test/p2.test.js         # P2 专项（SOP/脱敏/追溯/U2门禁/核验三态）
  test/p3.test.js         # P3 专项（证据驱动/数字冻结/引用/独立审计）
  test/p4.test.js         # P4 专项（周次解析/冲突/今日/空闲窗口/导入/自检）
  test/p5.test.js         # P5 专项（ICS 解析/重复规则/节次映射/导出回环/事务性）
  docs/方案-v0.2.md        # 三版块方案
  docs/自动执行方案.md      # 模型替换/接口适配/能力范围/异常处理/验收标准
  README.md
```

## 安全说明

### 本地 API 访问控制（防 DNS rebinding / 跨站伪造）
- 默认启用三重防护：**Host 白名单**（仅 `127.0.0.1`/`localhost`/`::1`）、**同源 Origin 校验**（写操作）、**会话 token**（首页注入 `X-Moyu-Token`，所有 API 必带）。恶意网页借 DNS rebinding 指向本地也无法读取对话/触发执行。
- 调试/集成时可设 `MOYU_ALLOW_INSECURE=1 node server.js` 关闭上述校验，启动日志会给出醒目警告。**切勿在联网环境使用此开关。**
- 第三方脚本调用 API 需先 `GET /` 提取 `<meta name="moyu-token">`，并在每次请求带 `X-Moyu-Token` 头。

### 执行引擎安全下限（服务端强制，前端不可绕过）
- **审批凭证**：前端不再自造 `approvals`，改为先 `POST /api/agent/approval {steps}` 领取服务端签发的**一次性、60 秒有效、绑定会话**的 token，再随 `/api/agent/run` 提交；token 用后即焚，重放返回 403。裸 `approvals` 仅保留给 node:test / CLI 直接调用。
- **高危强拦**：决策为 `ask_human`（转账/验证码/密码等）时，服务端拒绝一切写入（填入/写剪贴板），即使持有有效审批凭证。
- **副作用工具强制 gate**：即便自定义 plan 把 `jev.fill`/`desktop.writeClipboard` 标为 `gate:false`，服务端也会改回 gate 并要求审批。
- **决策工具禁降级**：决策模型调用失败不再静默转 mock（mock 高危判断仅靠关键词会漏判），而是失败转人工。
- **降级透明化**：非决策工具降级会标记 `degraded:true` 与 `provider.mode:"mixed"`，前端明确提示，不再伪装成 live 结果。

### 数据单一事实源
- 四个版块（含作业母版）的方案数据统一由后端 `lib/data.js` 提供，前端不再硬编码 `HOMEWORK_SECTION`。
- 所有版块的演示计划统一由后端 `/api/plan` 生成，删除了前端同构的 `buildDemoPlan`，杜绝双份逻辑漂移。作业版块计划使用 notebook 命令链，毕设竞赛使用 ommw 命令链。

### 隐私与数据保留
- 凭据字段采用**正向白名单**，只允许 `{ref, env, encrypted:true}`，任何未知字段（含 `token`/`apiKey` 等）保存时一律丢弃，杜绝明文夹带。
- 审计与轨迹**默认脱敏**：对话原文只存 SHA-256 指纹，不落明文；需要完整内容做本地调试时显式设 `MOYU_AUDIT_FULL=1`（自带风险）。侧栏标题仅保留前 24 字预览。
- 运行记录有保留期与上限：默认 7 天 / 最多 100 个 run，可用 `MOYU_RUN_TTL_DAYS`、`MOYU_RUN_MAX` 调整（设为 0 关闭）。
- **课表属个人数据**：含作息、教室与教师，`data/timetable.json` 默认被 `.gitignore` 忽略；接口同样受 Host/Origin/token 三重防护，不联网、不上传。
- `data/profile.json` 是可分享的占位档案，不含真实信息；`pack` 语义上不带出凭据引用清单。
- 本工作台不会主动访问外部网络；仅在选择 live 模型时由服务端按环境变量中的 key 调用对应 API。
