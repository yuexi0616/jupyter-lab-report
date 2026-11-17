# 开源来源标注（ATTRIBUTION）

本文件标注 `moyu-agent-workbench/`（摸鱼 Agent 工作台原型）与 `designs/`（落地设计文档）中，
**参考、借鉴或依赖的开源项目**。这些内容的检索与核实日期为 **2026-11-17**；star 数与版本均为
当日快照，集成前须复核。本项目遵循母仓库的 [Apache-2.0](./LICENSE) 许可。

## 一、核心原则

- **未 vendored 任何第三方源码**：所有 JS/Python 实现均为本项目自研。
- 第三方项目以三种方式出现：① **设计/方法论参考**（不复制代码）；② **适配器契约/协议封装**
  （自研代码调用其公开 API，运行时依赖单独安装）；③ **依赖声明**（见 `requirements.lock`，不随仓库分发源码）。
- 母仓库自身的九步作业 SOP（`doctor→…→pack`）是本工作台 P2「作业执行台」流程的来源，
  母仓库以 Apache-2.0 发布，本项目沿用其许可并在此致谢。

## 二、被参考 / 借鉴的开源项目清单

| 项目 | 上游地址 | 许可 | 快照日期 | 在本项目中的用途 | 是否 vendored |
|---|---|---|---|---|---|
| `yuexi0616/jupyter-lab-report`（本母仓库） | https://github.com/yuexi0616/jupyter-lab-report | Apache-2.0 | 2026-11-17 | P2 作业执行台九步 SOP、脱敏/追溯规则的流程来源 | 否（同一仓库内沿用，许可一致） |
| `browser-use/browser-use` | https://github.com/browser-use/browser-use | MIT | 2026-11-17（v1.0.0，2026-11-10 发布） | 刷课「内置浏览器」能力底座的选型参考；设计文档 §8.2 记录其高级 API 写法 | 否（仅设计参考） |
| `microsoft/playwright-mcp`（playwright-mcp） | https://github.com/microsoft/playwright-mcp | Apache-2.0 | 快照 2026-11-06（~39,252 star，第三方对比文章） | 浏览器不可用时的兜底原子工具参考 | 否（仅设计参考） |
| `ocsjs/ocsjs`（OCS 网课助手） | https://github.com/ocsjs/ocsjs | MIT | 2026-11-17（v5.4.0，2026-11-08 发布） | 刷课平台底座（超星/智慧树/职教云/智慧职教/中国大学 MOOC）的选型与平台清单来源 | 否（不 vendored OCS 源码，仅定义适配契约） |
| `CXRunfree/Autovisor` | https://github.com/CXRunfree/Autovisor | 快照未确认（作者公告 2026-09-15，v3.18.4） | 2026-11-17 | 「读取平台真实进度」作为 evaluator oracle 的思路参考 | 否（仅方法论参考） |
| `nokia-applied-research/AnyJev` | https://github.com/nokia-applied-research/AnyJev （官网 https://jevai.dev/anyjev ） | Apache-2.0 | 2026-11-17（pre-alpha） | 类型化决策内核参考；`tools_python/anyjev_server.py` 自研封装其 `Decider/Question/HFBackend` 公开 API | 否（HTTP 端点自研，pip 依赖单独安装） |
| `ollaya-dev/ollaya` | https://ollaya.dev | Apache-2.0 | 2026-11-17（创建 2026-09-23，~1.3k star，作者自报 8–10ms） | 本地决策服务的备选方案（未采纳，仅记录） | 否（仅选型记录） |
| `yohanchen1/MathModelingAgent` | https://github.com/yohanchen1/MathModelingAgent | MIT | 2026-11-17（v0.3.1） | P3 竞赛执行台的 Claim/Obligation/Evidence 证据驱动与独立审计（PASS/FAIL/INCONCLUSIVE）方法论参考，自研实现 | 否（不 vendored；不使用其 skill 文件） |
| `handsomeZR-netizen/mathmodel-skill` | https://www.claudecodeagents.com/skills/mathmodel-skill | MIT | 2026-11-17 | P3 竞赛十阶段流程与 decision_log 思路参考，自研实现 | 否（仅方法论参考） |
| `andiii208/dsh-ultramath`（DSH 插件） | https://dsh-plugin.org/plugins/andiii208/dsh-ultramath | MIT | 2026-11-17（v0.6.0） | 数字冻结 / 学术诚信门控的观察参考（未采纳） | 否（仅选型记录） |
| `Skyvern` | https://github.com/Skyvern-AI/skyvern | AGPL-3.0 | 快照 2026-07-29（~22,616 star） | 浏览器 agent 评估对象，因 AGPL 许可与项目目标不符未采纳 | 否 |
| `jihe520/MathModelAgent`（ojihe520/MathModelAgent） | https://github.com/jihe520/MathModelAgent | source-available（个人免费、禁商用） | 2026-11-17 | 最初候选，**已弃用**（用户拍板 U3「只开源」），仅作历史记录 | 否（从未 vendored 或使用） |
| `qing1989620/workbuddy-modex`（OMMW） | 见项目内 `lib/data.js` 既有记录 | 快照未独立复核 | 沿用项目内既有记录，2026-11-17 未联网复核 | 早期毕设/竞赛方向记录 | 否 |

## 三、运行时依赖（不随仓库分发源码）

`moyu-agent-workbench/tools_python/requirements.lock` 中以精确版本锁定：

- `anyjev==0.1.0`（Apache-2.0，AnyJev 官方发布包）
- `transformers>=4.44,<5`（Apache-2.0）
- `torch>=2.1,<3`（BSD-3-Clause）
- `sentencepiece>=0.1.99`（Apache-2.0）

这些依赖仅由用户按文档自行安装，本仓库不包含其源码。模型权重（如 `Qwen/Qwen3-8B`）来自 Hugging Face，
首次运行由用户自行下载，许可遵循各模型发布方。

## 四、选型声明的来源链接

设计文档 `designs/摸鱼Agent-四版块落地-harness-design-v2.md` 的「附录 A · 检索来源清单」逐条列出
选型声明的原始 URL 与核实要点（含第三方对比文章、官方博客、许可查询页）。star 与版本均为
2026-11-17 当日快照，仅供独立评审核对，不代表当前数值；集成前请复核上游最新状态。

## 五、未取得可靠快照的声明

- OMMW `workbuddy-modex` 的 star 与许可细节沿用项目内 `data.js` 既有记录，本轮未独立联网复核。
- `CXRunfree/Autovisor` 的具体许可本轮未独立复核，仅记录其作者公告与版本。
- 混元 Hy4 的确切 model id 官方文档未公开，以 TokenHub 控制台为准（见工作台 README）。
