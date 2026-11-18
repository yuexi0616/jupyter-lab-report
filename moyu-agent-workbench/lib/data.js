'use strict';

/**
 * 摸鱼Agent工作台 — 方案数据源（v0.2）
 * 所有条目来自本轮 GitHub 实查与方案汇编；star 数均标注为快照，前端显示时带"需以仓库实时页为准"。
 * 这里只放"方案数据"，不含任何真实凭据、路径或个人标识。
 */

const SNAPSHOT_NOTE = '星标数为 2026-09/10 不同来源快照，彼此差异较大，请以 GitHub 实时页为准。';

const sections = [
  {
    // 作业版块（母版）：原本硬编码在前端，现已收敛到后端单一事实源。
    id: 'homework',
    name: '作业版块',
    codename: 'jupyter_lab_report',
    icon: '▤',
    priority: 'S0 / P0（母版）',
    status: 'active',
    goal: '以 jupyter-lab-report 模板为母版，把课程作业从取题、分析、实验到报告交付编排成确定性 SOP；封面脱敏、凭据只存引用、每个结论可追溯到 notebook 单元输出。',
    definitionNote: '这是整套方案的母版：刷课 / 回复建议 / 毕设竞赛三版块的 SOP 与共享内核均由这套模板派生。',
    scenarios: [
      '读取作业要求与模板资产，生成带占位的可执行 notebook 骨架',
      '按单元运行代码产出图表/表格，audit 校验「结论有对应输出」',
      '导出脱敏 PDF/HTML 报告，打包可复现工作区（代码 + 数据引用 + 说明）',
    ],
    capabilities: [
      'jupyter-lab-report 模板解析与填充',
      'notebook 单元执行与产物管理',
      '封面/署名/路径脱敏 + 凭据引用化',
      'doctor / check 门禁与占位检测',
      '结论—输出追溯 audit',
      'pack 脱敏分享包',
    ],
    io: {
      input: ['作业要求 / 题目', 'jupyter-lab-report 模板资产', '数据集引用', 'profile（署名/路径，脱敏）'],
      output: ['可执行 notebook', '图表 / 表格产物', '脱敏报告 PDF / HTML', '复现说明 + 自检报告'],
      boundary: '不代写、不伪造数据；AI 生成边界按课程规则标注。',
    },
    reuse: {
      direct: ['SKILL.md 分节 SOP', 'profile 外置 + ask-first', 'doctor/check 门禁链', 'pack 脱敏分享'],
      extend: ['notebook 执行器', '结论—输出追溯 audit', '封面/署名脱敏自动化'],
      novel: ['jupyter-lab-report 模板本身（母版）'],
      note: '母版：其余三版块从这套 SOP 与共享内核派生，复用度最高。',
    },
    projects: [
      { role: '母版底座', repo: 'jupyter-lab-report（本地模板）', stars: '—', license: '内部模板', why: '作业版块的确定性 SOP 与资产目录，是其余三版块的复用基线。', verify: '' },
      { role: '首选执行底座', repo: 'anomalyco/opencode', stars: '~15.4万–20.8万（来源差异大）', license: 'MIT', why: 'BYOK 或接 Ollama，原生读 SKILL.md + MCP，作业版块零改造迁移。', verify: 'star 数为来源快照，需以 GitHub 实时页为准。' },
      { role: '备选底座', repo: 'openai/codex', stars: '~12.5万', license: 'Apache-2.0', why: '已有 ChatGPT 订阅则边际成本最低。', verify: '' },
      { role: '国内备选', repo: 'Qwen Code / Kimi CLI', stars: '~2.4万 / ~8千', license: 'Apache-2.0', why: '国内 API key 友好、有免费额度，适合学生。', verify: '' },
    ],
  },
  {
    id: 'course_auto',
    name: '刷课',
    codename: 'course_auto',
    icon: '▶',
    priority: 'S3 / P1',
    status: 'planned',
    goal: '在用户授权下无人值守推进网课播放，产出可核验的完成记录；不改成绩、不产证书，遇验证码/掉线暂停并交还用户。',
    scenarios: [
      '登录平台后逐集播放、静音倍速、跳弹窗弹题、断点续播',
      '遇滑块/人机验证自动暂停 → 用户手动处理 → 自动恢复',
      '结束产出「已学章节 + 时长 + 异常交接」清单供核对',
    ],
    capabilities: [
      '浏览器自动化（Playwright / CDP）',
      'DOM / iframe 视频元素识别',
      '状态机与断点续播',
      '异常检测与人工接管',
      '进度日志落盘 + 逐章节自检',
      '反检测节流（P2，需合规提示）',
    ],
    io: {
      input: ['profile（平台账号引用、浏览器路径）', '课程 URL 列表', '播放参数（倍速/静音/后台）'],
      output: ['结构化进度记录（章节/时长/状态）', '运行日志', '异常交接清单'],
      boundary: '不产出证书、不修改成绩',
    },
    reuse: {
      direct: ['SKILL.md 分节 SOP', 'profile 外置 + ask-first', 'CLI 命令链骨架', 'evals 行为断言', 'pack 脱敏分享'],
      extend: ['profile 增 course.* 分区', 'audit 改为「逐章节进度自检」', '新增人工接管状态机'],
      novel: ['浏览器自动化内核', '验证码检测与人工交接', '长时挂机进程守护'],
      note: '本质差异：模板是「一次性交付 notebook」，刷课是「长时在线状态机」。',
    },
    projects: [
      { role: '首选执行内核', repo: 'CXRunfree/Autovisor', stars: '活跃维护（2026-09 仍在更新）', license: '需核对', why: 'Playwright+Python/JS，自动登录/滑块/播放切集/跳弹题/静音倍速/暂停续播/后台进度/config.ini 外置；配置外置≈profile、暂停续播≈状态机、章节时长≈deliver。', verify: '作者公告「准备读研、佛系更新」，维护活跃度是最大变量。' },
      { role: '决策增强', repo: 'browser-use/jev-ultrafast', stars: '~21,477（快照）', license: 'MIT', why: 'Jev 驱动，一次请求同时决定「点什么+填什么」，可把平台 DOM 识别从硬编码选择器升级为模型决策。', verify: '' },
      { role: 'adapter 参考', repo: '油猴类脚本（如 xuexitongScript）', stars: '—', license: '需核对', why: '几十行的平台适配层，沉淀进 references/ 而非主流程。', verify: '' },
    ],
  },
  {
    id: 'jev_reply',
    name: 'jev 自动回复对象',
    codename: 'jev_reply',
    icon: '✦',
    priority: 'S4 / P2（解锁不抢跑）',
    status: 'unlocked',
    goal: '以 Jev 决策内核先判断对方意图/风险/是否该回，再由生成模型起草回复，默认人工确认后发送；可审计、可随时停止。',
    definitionNote: 'jev = 用于决策的大模型（TypeSafe Jev 及其开源生态），不再是早期猜测的 IM 平台/联系人/bot 框架。',
    scenarios: [
      '读屏/监听会话 → Jev 判意图、危险等级(1–9)、是否立即回、最佳动作',
      '生成模型起草 3 条候选 → Jev 按契合度排序 → 填入输入框',
      '只填输入框、不自动发送、不碰转账红包（fill-only）',
    ],
    capabilities: [
      'Jev 决策内核（choice / score / noul，POST /v1/systemone）',
      '生成 LLM 起草回复（第二把 API key）',
      '消息平台/读屏适配（无障碍服务 / OCR）',
      '会话上下文与联系人档案',
      '触发规则、频控、审计日志、一键停止',
      '双 key 管理与凭据只存引用',
    ],
    io: {
      input: ['profile 凭据引用（不存明文）', '人设/话术库', '触发规则', '对话历史快照'],
      output: ['回复草稿（默认）或用户确认后的发送', '会话审计日志'],
      boundary: '默认草稿优先；不擅自发送、不泄露 profile 隐私、不碰支付。',
    },
    reuse: {
      direct: ['profile 外置 + ask-first（凭据绝不写死）', 'doctor/check 体检', 'evals 行为断言', 'pack 排除凭据'],
      extend: ['profile 增 messaging.* 分区', '消息监听长驻（守护壳）', 'audit 增「合规自检 + 频控 + 可停止」', '草稿/发送双模'],
      novel: ['Jev 决策内核（已下沉为共享能力）', 'LLM 人格一致性', '会话记忆', '双 key Separation'],
      note: '架构差异最大：模板是一次性批处理，这里是长驻事件服务；Jev 只做决策不写文本。',
    },
    projects: [
      { role: '首选标杆实现', repo: 'jev-chat/jev-chat-jarvis', stars: '~5.2k–8.4k（多来源快照冲突）', license: 'MIT', why: 'Kotlin，读屏→Jev 判意图/危险等级→生成模型起草 3 条→Jev 排序→只填入输入框，绝不自动发送、不碰转账红包。直接印证「草稿优先」断言。', verify: '微信适配已撤回；QQ/X 覆盖为作者自述，需真机验证。' },
      { role: '决策内核（托管）', repo: 'TypeSafe Jev（OpenRouter）', stars: '闭源权重', license: '商业 API', why: 'choice/score/noul 三类接口，一次前向多问题、输出即类型化（厂商称 0% 结构化错误）、~100ms、$0.042/百万输入 token。', verify: '延迟/价格/193 倍对比均为厂商自报，无独立复现。' },
      { role: '决策内核（开源/免费）', repo: 'nokia-applied-research/AnyJev', stars: '~978（快照）', license: 'Apache-2.0', why: '把已有任意 LLM 变成 Jev 式决策模型，无需训练、返回真实概率——最贴合学生零预算。', verify: '' },
      { role: '本地 drop-in', repo: 'ollaya-dev/ollaya', stars: '~1,002（快照）', license: 'Apache-2.0', why: '本地起 TypeSafe 兼容 API，Jev 客户端改 base_url 即可，无迁移成本。', verify: '' },
      { role: '谨慎评估', repo: 'NandhaKishorM/laya', stars: '~28,881（快照）', license: 'Apache-2.0', why: '开源引擎，但 README 自述零样本 0.362 vs 随机 0.318≈接近随机，需带标注微调才 0.766。', verify: '不是 Jev 的即插即用替代。' },
    ],
  },
  {
    id: 'project_lab',
    name: '毕设 / 竞赛项目',
    codename: 'project_lab',
    icon: '∑',
    priority: 'S2 / P0',
    status: 'active',
    goal: '把毕设/竞赛从选题到交付的全流程以确定性 SOP 编排，产出可复现、可核验的项目包；论文每个数字可追溯到实验产物，杜绝编造。',
    scenarios: [
      '输入选题/赛题，联网检索相关工作，生成文献清单与 gap 分析',
      '设计并运行实验产出图表，audit 校验「图有对应实验产物」',
      'LaTeX/Typst 写作编译、校验引用完整性（每个 cite 有 bib）',
      '模拟评审生成修改清单与 rebuttal，deliver 打包（论文+代码+图表+复现说明）',
    ],
    capabilities: [
      '联网检索与文献管理',
      '实验代码执行与产物管理',
      'LaTeX/Typst 排版与 PDF 编译（中文方案）',
      '反幻觉门控（数字挂 Result ID、引用挂 Source ID）',
      '自动审稿 / rebuttal',
      '版本快照与可复现打包',
    ],
    io: {
      input: ['选题/赛题描述', '数据集来源', '学校/赛事模板（assets）', 'profile（署名/目录/编译器）'],
      output: ['论文/报告 PDF', '实验代码与产物', '图表 + 引用库', '答辩材料', '复现说明 + 自检报告'],
      boundary: '数字可追溯、引用须支撑论点；AI 生成边界需按赛事规则标注。',
    },
    reuse: {
      direct: ['SKILL.md SOP（几乎逐节映射）', 'profile 外置', '命令链 doctor→check→cover→build→run→audit→pdf→deliver→clean→pack', 'assets 模板资产', 'pack 排除个人成果'],
      extend: ['crawl 扩为「文献检索+引用抓取」', 'run 扩为「实验执行」', 'audit 增引用完整性/数字追溯', '新增 review/rebuttal'],
      novel: ['实验设计与执行引擎', '文献检索 API 集成', '研究闭环（版本快照/自动审稿）'],
      note: '三版块中复用度最高，最早落地可低成本验证共享内核。',
    },
    projects: [
      { role: '首选工程底座', repo: 'qing1989620/workbuddy-modex（OMMW）', stars: 'v1.0.0-rc1', license: '核心 MIT', why: '与模板哲学同构：Research Core 单一事实源、8 条强制反幻觉规则、doctor/status/verify/render/citations verify/parity/smoke-test/package 命令链≈模板链；LaTeX+Word 双渲染、CI、反幻觉测试；内置 WorkBuddy adapter。', verify: '核心 MIT；第三方 provider 有独立许可。' },
      { role: '首选能力参考', repo: 'jihe520/MathModelAgent', stars: '~5.1K', license: '个人免费·禁商用', why: '多 Agent + multi-LLM（litellm）、17 套 Typst 模板、RAG、HIL 六动作门禁、四层容错、9 步验收；已蒸馏成可 npx 安装的 SKILL.md。', verify: '禁商用；只能参考方法+署名，不可 vendored 进 MIT 核心。' },
      { role: '素材库', repo: 'logic1241/xiaohudie-math-modeling', stars: '—', license: '个人/竞赛免费·禁商用禁闭源', why: '4 套 LaTeX 模板 + 16 个可运行算法模板 + 论文质检门禁。', verify: '自定义许可，组合分发需逐一核对。' },
      { role: '评分闭环参考', repo: 'Escap1ng/math-modeling-skill', stars: '—', license: 'MIT', why: '七阶段 + 12 类算法库 + ≥85 分五维评分闭环（未达标最多循环 3 轮）。', verify: '' },
      { role: '愿景参考', repo: 'N-allpass/modex-mh-agent', stars: '~179（镜像快照）', license: '需核对', why: '标注「架构展示」：一键赛题→竞赛级论文，国赛/美赛/华为杯全覆盖的愿景参考。', verify: '成熟度需验证。' },
    ],
  },
];

const sharedKernel = {
  mustSink: [
    { name: 'profile / ask-first 引擎', reason: '无领域语义，三版块均需' },
    { name: 'CLI 命令链骨架 + 质量闸门', reason: 'doctor/check/audit/deliver/pack 语义统一' },
    { name: 'evals 断言框架', reason: '核心断言三版块共用' },
    { name: 'CredentialResolver（统一凭据解析点）', reason: 'profile 只存引用；Q4 确认后只换后端' },
    { name: '日志与审计基座', reason: '可审计、可停止' },
  ],
  optionalAdapters: [
    { name: '浏览器内核', consumers: '刷课（强）↔ jev（弱，若需网页登录）' },
    { name: 'LLM 客户端', consumers: 'jev（起草）↔ project（写作/审稿）' },
    { name: '联网检索', consumers: '刷课（爬课程）↔ project（检索文献）' },
    { name: 'Jev 决策内核', consumers: '刷课（弹题决策）↔ jev（意图判断）↔ project（模型选择/相关性打分）' },
  ],
  keepLocal: '刷课播放器状态机、jev 的 LLM 人格/会话记忆/频控、project 的检索/实验/编译/review、各版块领域 audit 规则。',
  namespace: {
    common: ['machine.*（OS/解释器/工作目录）', 'identity.*（署名/机构，脱敏）', 'credentials.*（只存 {引用ID, 环境变量名, 加密标志}）'],
    'course.*': ['platforms[]', 'courses[]', 'playback.*', 'takeover.*'],
    'messaging.*': ['accounts[]', 'persona.*', 'rules.*', 'send_policy.*（draft_only 默认 / auto_send）'],
    'project.*': ['topic.*', 'sources[]', 'toolchain.*', 'integrity.*'],
  },
  credentialRules: [
    '分区前缀强制：版块字段一律带 course./messaging./project. 前缀',
    '同名隔离：靠前缀区分，不做就近覆盖',
    '覆盖优先级：实例ID/$PROFILE_PATH > 版块分区 > common 默认值；只在同分区内生效',
    '凭据统一收敛 common.credentials.* 引用，版块只存引用 key',
    'check 阶段做 schema 校验，未登记字段即报错（顺带覆盖「占位档案能通过 check」缺陷）',
    'messaging.* 支持多凭据引用；run/listen 按 account_id 显式绑定；pack 不带出引用清单',
  ],
};

const harness = [
  { repo: 'anomalyco/opencode', stars: '~15.4万–20.8万（来源差异大）', license: 'MIT', why: '最接近 Claude Code 的开源终端 agent；BYOK（自带 Anthropic key）或接 Ollama；原生读 SKILL.md + MCP → 作业版块零改造迁移。', tag: '首选' },
  { repo: 'openai/codex', stars: '~12.5万', license: 'Apache-2.0', why: '已有 ChatGPT 订阅则边际成本最低。', tag: '备选' },
  { repo: 'google-gemini/gemini-cli', stars: '~10.7万', license: 'Apache-2.0', why: 'Google 官方开源 agent，读 SKILL.md。', tag: '备选' },
  { repo: 'Qwen Code / Kimi CLI', stars: '~2.4万 / ~8千', license: 'Apache-2.0', why: '国内 API key 友好、有免费额度，适合学生。', tag: '国内备选' },
];

const roadmap = [
  { stage: 'S0', priority: 'P0', name: '模板加固', content: '封面脱敏、凭据加密、check 拒占位、init 补齐字段', deps: '无', accept: '5 项已知缺陷均有断言；占位档案 check 失败；凭据零明文', risk: '加固改动需完整回归' },
  { stage: 'S1', priority: 'P0/P1', name: '共享内核 + 命名空间', content: 'profile 四分区 + 统一 ask-first + CLI 骨架 + 核心 evals', deps: 'S0', accept: '分区隔离、覆盖生效、断言全绿', risk: '过早抽象风险' },
  { stage: 'S2', priority: 'P0', name: 'project_lab MVP', content: '接 OMMW：检索 + 实验 + 编译 + 引用/数字追溯 audit + 快照', deps: 'S0,S1', accept: '全链真跑通；复用度最高', risk: '学术诚信边界 Q6；工具链环境差异' },
  { stage: 'S3', priority: 'P1', name: 'course_auto MVP', content: '接 Autovisor：浏览器内核 + 状态机续播 + 进度自检 + 接管', deps: 'S1', accept: '无人值守 + 可核验进度', risk: '合规 Q3/Q5；平台 DOM 易变' },
  { stage: 'S4', priority: 'P2→解锁', name: 'jev 版块', content: '接 jarvis 范式：messaging.* + 长驻 + Jev 决策 + 草稿双模', deps: 'Q1/Q2 已确认,S1', accept: '凭据零明文；合规/频控/可停止断言通过', risk: '读屏隐私面最敏感；平台适配需真机验证' },
  { stage: 'S5', priority: 'P2', name: '增值迭代', content: '反检测/守护、自动审稿/rebuttal、pack 选择性打包', deps: 'S3,S4', accept: '各 P2 断言通过', risk: '反检测伦理' },
];

const openQuestions = [
  { id: 'Q1', text: 'jev 确切含义', status: '已确认：用于决策的大模型', impact: '解锁 S4' },
  { id: 'Q2', text: '自动回复发送策略', status: '默认草稿后发（jarvis 范式背书）', impact: 'send_policy 默认值' },
  { id: 'Q3', text: '刷课平台清单与合规边界', status: '待确认', impact: 'adapter 范围与反检测' },
  { id: 'Q4', text: '凭据存储方案', status: '默认引导式本地加密（待拍板）', impact: 'CredentialResolver 后端' },
  { id: 'Q5', text: '刷课伦理边界（只推进度不改成绩）', status: '待确认', impact: 'eval 断言口径' },
  { id: 'Q6', text: 'AI 生成内容在毕设/竞赛的学术诚信边界', status: '待确认', impact: 'project review/rebuttal 范围' },
  { id: 'Q7', text: 'SKILL.md description 是否统一中英双语', status: '待确认', impact: 'frontmatter 复用标注' },
];

module.exports = {
  SNAPSHOT_NOTE,
  sections,
  sharedKernel,
  harness,
  roadmap,
  openQuestions,
  version: '0.2',
  updated: '2026-11-17',
};
