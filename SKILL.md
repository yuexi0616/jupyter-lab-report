---
name: jupyter-lab-report
description: 把课程实验课件（PDF / 截图 / md 讲义 + 数据集，或从 LMS 爬取）复刻成本人可提交的 .ipynb 并出中文 A4 PDF（含学校封面表头）的一条龙：问询落盘、爬 LMS 课件页、读课件、找数据、markdown 章节与代码块交替建 notebook、nbconvert 真跑自检、按档案命名规则交付、无头浏览器打印 PDF。署名与各类目录不写死在流程里，统一由 profile.json 提供，缺字段必须先询问用户。Use when the user hands over course lab courseware/PDF and asks to 复刻该 pdf 的流程 / 创建一个 NNNN.ipynb / 调用合适的 csv / 重命名为学号-姓名-实验名称 / 把 ipynb 生成为 pdf / 按这份课件做实验报告 / 爬取 LMS 课件 / 加实验报告封面, or in English: reproduce a Jupyter notebook from lab handouts (or a crawled LMS page) and export a Chinese PDF with a school cover.
---

# jupyter-lab-report — 课件 → ipynb → PDF

流程与机器无关；「谁交付、课件在哪、成果放哪、用哪个解释器、用什么打印 PDF、LMS 账号」全部来自
环境档案 `profile.json`。交付物固定三件：**真跑过的** `.ipynb` + 同名 A4 `.pdf`（第一页是学校封面）+ 
notebook 依赖的 `data/`。中间 HTML、构建脚本是临时件，出完 PDF 就删。

**该不该开这个技能**：输入是"课件/讲义/LMS 实验手册"、输出是"我自己的 notebook 报告"，就是它。
纯数据分析、随手画图（不交报告）不算；要交 md + 终端截图的走终端截图类技能。

所有命令都在本技能目录下执行（`<skill>` 指本 SKILL.md 所在目录），脚本是纯 CLI，任何 agent 都能驱动：

```bash
python <skill>/scripts/nbkit.py doctor      # 第一次用先体检：依赖 / 中文字体 / 浏览器 / 档案
python <skill>/scripts/nbkit.py check       # 摊开本次要用的路径
```

## 部署（刚拿到技能包时先做这节；已装好直接进第 0 节）

适用：别人发来的 zip / 刚解压的目录，本机还没装。按顺序做完再开始：

1. **验完整**：`SKILL.md`、`scripts/nbkit.py`、`scripts/crawl_lms.py`、`assets/表头.docx`、
   `references/`、`requirements.txt`、`profile.example.json` 缺一不可。缺件就让对方在源机跑
   `python scripts/nbkit.py pack` 重发完整 zip，别拿缺件的包硬装。
2. **放对位置**：整个目录放进当前 agent 的技能目录（Qoder `~/.agents/skills/`、
   Claude Code `~/.claude/skills/`、Codex `~/.codex/skills/`）。目录名即技能名，
   与 frontmatter 的 `name` 保持一致（默认 `jupyter-lab-report`；想改名两处一起改）。
   放好后所有命令改用新位置的路径。
3. **装依赖 + 体检**：`python -m pip install -r <skill>/requirements.txt`，再跑
   `python <skill>/scripts/nbkit.py doctor`，按输出补齐中文字体 / 浏览器缺项。
4. **建档**：进第 0 节向用户本人问初始化信息。**不要向对方要源机器的 profile.json**——
   署名、目录、LMS 账号每人一份，分享包里本来就不该有别人的档案。

## 0. 每次开始问什么（规范性全在这一步）

档案就在技能包内：`<skill>/profile.json`（相对技能目录，`$NBKIT_PROFILE` 可指向别处覆盖）。
**拷贝或升级技能包时，记得连 profile.json 一起带走**——里面是署名、目录和 LMS 账号。

### 第一次（初始化档案）：只问这一次，之后写进档案，不再重复问

开头先说明**"这是初始化信息，只问这一次"**，再按固定顺序一次问全（已有同类路径作为候选项，
标"档案记录，推荐"）：

| # | 字段 | 题面 | 必填 |
| --- | --- | --- | --- |
| 1 | `student.id` | 署名编号（学号，交付文件名用） | 是 |
| 2 | `student.name` | 姓名（文件名与封面用） | 是 |
| 3 | `courses.<k>.label` | 课程名字（封面"课程名称"、档案条目显示名，**同时用作条目 key**），如"大数据实验" | 是 |
| 4 | `courses.<k>.lms.username` | LMS 登录账号（爬课件用，明文写进档案） | 是 |
| 5 | `courses.<k>.lms.password` | LMS 登录密码（明文写进档案） | 是 |
| 6 | `courses.<k>.output_dir` | 成果输出目录（ipynb / pdf / data） | 是 |
| 7 | `courses.<k>.python` | 执行 notebook 的 Python 解释器（确认当前进程就够时可省） | 是 |
| 8 | `courses.<k>.note` | 备注（可空；本条目级附注，如"变量名统一加姓名全拼"） | 否 |
| 9 | `tools.print_pdf.watermark.mode` | PDF 水印偏好：每次询问 `ask` / 一直添加 `always` / 一直不添加 `never`；水印文字一并问（可空，默认"学号 姓名"） | 是 |

问到的**当场落盘**，下次只复述确认、不再重复问：

```bash
python <skill>/scripts/nbkit.py init --student-id 20240001 --student-name "Zhang San" \
    --course "大数据实验" --lms-user ... --lms-pass ... \
    --output-dir ~/work/ml --python "$(which python3)" --note "..." --set-default
python <skill>/scripts/nbkit.py set courses."大数据实验".output_dir=~/work/ml   # 单字段改这个
```

### 其他次（每做一次实验）：问四项（水印=ask 时多一项），都不写档案

1. **实验名字** —— 这次实验叫什么（如"实验五：Spark DataFrame实验"）；**留空**就自动取
   爬下来课件页面的标题。
2. **本次作业的特殊要求**（可写"没有"）—— 老师的个性化要求，**每次单独问，不写进档案**。
   例："变量加上自己的名字全拼"（build 时把变量改名，如 `df` → `df_wangyuhao`）、
   "这节要加调参对比"。需要姓名全拼而档案没有 `student.name_pinyin` 时，问一次全拼并落盘，之后自动用。
3. **爬取地址**（可写"没有"）—— LMS assignment 页 URL，或批量范围（4 个整数）。**没有 = 不爬**，
   直接用输出目录 `courseware/` 里的课件。
4. **数据地址**（可写"没有"）—— 课件点名的数据集放哪（绝对路径，可多个）。每份作业的数据可能不同，
   **不写进档案**，每次都问。
5. **水印**（仅档案 `tools.print_pdf.watermark.mode=ask` 时问）—— 这次 PDF 加不加水印、用什么文字？
   结果用 `--watermark [文字]` / `--no-watermark` 传给 `pdf`；always/never 不问。

**不要问的**：日期（自动用今天，填封面"完成时间"；用户主动给了才覆盖）、课件 md 放哪
（默认 `<output_dir>/courseware/`，爬完直接落）、`deliver_pattern`/`kernel`/浏览器路径（有默认值或自动探测）。

三条红线：不拿同名/相邻目录当兜底；不自己造数据；`check` 报"目录不存在"时先跟用户核一句再用
（外接盘没插、路径过期、同名目录有两个，都属这类）。

## 1. 爬课件（给了爬取地址才做）

```bash
python <skill>/scripts/nbkit.py crawl http://10.30.0.135/courses/194/assignments/2179?module_item_id=8601 \
    --course ml-lab
python <skill>/scripts/nbkit.py crawl --batch 2181 2184 8603 8606 --course ml-lab
```

- md 默认落 `<output_dir>/courseware/`（自动新建），不用问放哪；`--out` 可显式覆盖。
- 账号密码与 LMS 地址从档案读；档案缺账号密码时按 `nbkit.py crawl` 打印的题面问，落盘再跑。
- 爬下来的 **md 文件名 = 页面标题 = 实验名**（`deliver` 与封面直接用，不要自己发挥）。
- 爬完先读 md 确认内容全（标题、步骤、代码块都在）；缺页/截断再考虑补爬或问用户。

## 2. 封面（第一个单元格）

```bash
python <skill>/scripts/nbkit.py cover "<实验名>" --course ml-lab --json   # 输出 cells.json 可用的单元格对象
python <skill>/scripts/nbkit.py cover "<实验名>" --out cover.html         # 或写到文件再读进来
```

把输出**作为 notebook 的第一个 md 单元格**（`{"type": "md", "source": "<封面 HTML>"}`）。封面来自
`<skill>/assets/表头.docx` 的复刻：动态填实验名称、学生姓名（档案）、课程名称（档案 `cover.course_name`
或 label）、完成时间（今天）；实验室/院系/专业/年级沿用模板里的值——**要改去改模板 docx，不要写死在脚本里**。
封面字段不带下划线。

## 3. 三要素齐了才动手

| 要素 | 从哪拿 | 说明 |
| --- | --- | --- |
| 课件 | 爬下来的 md / 本次课件目录 | 决定 notebook 的单元格序列，是唯一的"标准答案" |
| 数据 | 第 0 节问到的"数据地址" | 按课件代码里写的相对路径（如 `./data/xxx.csv`）去找；找到后**拷进 `<output_dir>/data/`**，让相对路径原样可用 |
| 课程归属 | `default_course` / 用户话里的课程名 | 用户只说"复刻课件流程"时先确认是哪门课 |

数据按给到的文件名找不到，**问一句实际路径**，不要造数据、不要拿别的数据集凑。
课件里的内网地址或他人机器路径本机不可达时，先问；同意后才就地取材派生，并在报告里注明换了数据源。

## 4. 读课件：把单元格序列抄准

- md 讲义直接读文本；课件 PDF 大多是**渲染出来的 notebook 导出**，`In [n]:` / `Out[n]:` 就是单元格边界，
  逐页看图（读文件工具指定页码区间，单次 ≤20 页）。
- 两类坑：**讲义型 PDF 常是纯图片、没有文字层**（`pypdf.extract_text()` 返回空串，只能看渲染图）；
  **代码行会被页宽截断**（如 `random_sta` 断在行尾），被截的部分靠上下文补全，补不出来就问，别猜一个值塞进报告。
- 课件里 `import` 了但正文没用到的库（如 `GridSearchCV`），**保持不用**。复刻流程不等于补全流程，
  多加的步骤会被当成没做过课件内容。

## 5. 建 notebook：封面 + markdown 章节 + 代码块交替

不要把所有代码堆进几个大单元格——notebook 是要转 PDF 交上去的，读起来得像一份报告。
把单元格写成 `cells.json`，用 `build` 生成，别手搓 ipynb JSON，也别用编辑器的单元格插入功能（会覆盖已有单元格）：

```json
{"cells": [
  {"type": "md",   "source": "<第 2 节生成的封面 HTML>"},
  {"type": "md",   "source": "## 一、导包"},
  {"type": "code", "source": "import pandas as pd"},
  {"type": "code", "source": "df = pd.read_csv('./data/churn.csv')\ndf"}
]}
```

```bash
python <skill>/scripts/nbkit.py build cells.json draft.ipynb --course ml-lab
python <skill>/scripts/nbkit.py fonts --cell          # 打印本机可用的中文字体设置代码，粘进导包那一格
```

排版约定（这几条直接决定 PDF 好不好看）：

- 章节用中文数字编号（`## 一、`、`### 3.1`），标题文字沿用课件的小标题。
- **代码行别太长**：单行超过约 80 字符就换行写（用括号续行），否则转 PDF 时被页宽折行、断得难看。
- **markdown 别写大段描述**：每个 md 单元格不超过两句、尽量一行大白话，只说这步做什么（用户 2026-11-11 明确要求，以后都这样）。
  注释只给关键代码加一句功能描述（如 `# 创建临时表`），别逐行翻译；**不写**"等价于…""手册为内网路径、本地用 data/""某 API 在某版本已移除"这类等价对比、手册差异、版本/路径适配说明——适配原因 md 和注释都不进报告（用户 2026-11-11 二次明确）。
- **课件里每段代码上方的中文注释原样保留**在代码里。
- 课件用 `print(...)` 出结果的地方保留 `print`；课件是裸表达式（`df.head()`）的地方**别加 print**，
  保持"最后一行表达式直接出结果"的写法。
- 画图前必设中文字体，否则 PDF 里图题全是方框：用 `nbkit.py fonts` 看本机有什么，
  `nbkit.py fonts --cell` 直接出可粘贴的三行 rcParams。别照抄别家机器的字体名。
- 结尾自己加一节 `## 结果分析`：3 条左右，讲清指标怎么看、和业务/相关性分析怎么对上。
- **备注与本次特殊要求**（第 0 节问到的）在这里落实：变量改名、加小节等。做完在汇报里提一句"备注已落实：…"。

## 6. 执行 + 对数 + 截断长输出（这一步不能跳）

```bash
python <skill>/scripts/nbkit.py run draft.ipynb --course ml-lab --timeout 900
python <skill>/scripts/nbkit.py audit draft.ipynb
python <skill>/scripts/nbkit.py trim draft.ipynb     # 过长的输出截断，避免 PDF 翻页爆炸
```

`run` 会为档案里那个解释器临时注册内核再执行——只换跑 nbconvert 的 python 并不会换 notebook 用的内核，
多环境机器上这会静默跑错环境。`audit` 打印每个代码单元格的结论性输出、图片数、报错，
并对"表达式单元格没有任何输出"直接判失败：**空输出的 notebook 不算交付**。
`trim` 只截输出不碰代码：超过 60 行的文本输出（`dir()`、整表 `print`）中间省略、留一行标记，
`show(50)` 这类课件点名的短输出原样保留。

拿 `audit` 的输出和课件的 `Out[n]` 逐项比：样本数、缺失值数、准确率、分类报告。
**总数对得上、个别指标差在小数点后两位**，通常是切分随机种子下的行差异，不是流程做错了——
核对总样本和正类样本数是否完全一致就能确认，别为此去反推凑数的 `random_state`。
结论段的数字一律按**实测值**写，抄课件数字会在答辩/评审时对不上。

**报错先查 `references/troubleshooting.md`**（本技能自带排错记忆，现象→根因→解法一条条记着）：
先命中已知问题，别整本重跑瞎试；解决了新问题，就把关键点按同样格式追加进那个文件，下次直接命中。

## 7. 重命名 + 出 PDF

```bash
python <skill>/scripts/nbkit.py deliver draft.ipynb "实验四-逻辑回归" --course ml-lab
python <skill>/scripts/nbkit.py pdf "20240001-Zhang San-实验四-逻辑回归.ipynb" --course ml-lab
python <skill>/scripts/nbkit.py clean cells.json draft.html          # 临时件收干净
```

- 实验名取课件文件名/爬虫页面标题，别自己发挥；`deliver` 用档案的 `deliver_pattern` 拼名
  （默认 `{id}-{name}-{exp}`），换署名规则只改档案。目标已存在时**不覆盖**，要替换显式加 `--force`。
- PDF 走无头浏览器而不是 LaTeX：notebook 里的中文过 LaTeX 容易丢字形；浏览器链路出的是 Skia/PDF，
  中文、封面和图都稳。Chrome 优先，档案没记录时自动探测 Chrome/Edge，探测结果按提示落盘。
- 水印按档案 `tools.print_pdf.watermark`（初始化问一次）：`always` 一直加、`never` 一直不加、
  `ask` 每次显式传 `--watermark [文字]` / `--no-watermark`（裸 `--watermark` 用默认"学号 姓名"）；
  ask 裸跑会提醒并不加。水印为浅灰斜排平铺文字，每页重复、不遮正文。
- 出完抽查 PDF 的**封面页、图表页、末页**，确认封面字段齐全、中文没变方框、图没被切一半；
  加水印时确认水印每页可见、不遮正文。
  `df.head()` 这类宽表在打印时带横向滚动条、右侧列被截，这个表现和课件原 PDF 一致，不用修。
- 交付目录最后只留：`.ipynb` + `.pdf` + `data/` + `courseware/`（临时件用 `clean` 收掉）。

## 8. 汇报模板

1. 一句结论 + 成果清单（`.ipynb` / `.pdf` / `data\`，给绝对路径，附页数和大小）。
2. 复刻到什么程度：单元格数、markdown/代码配比、执行 0 报错、图几张、封面已含。
3. 与课件的差异**只说一处**：数字为什么不同、或哪一步课件被页宽截断了。
4. 本次备注是否落实（可空就没这条）；水印按档案/本次选择添加情况（一句）。
5. 结尾给选项：要不要换目录、要不要改实验名称、要不要加调参那一节。
6. 本次问过路径的话补一行"档案已记住 `courses.<k>.xxx = …`"，让用户知道下次不会再问。

别写成事故报告，也别把同一个数据差异解释两遍。

## 附：移植与排错

- **一键分享包**：`python <skill>/scripts/nbkit.py pack` 在技能目录旁出 `jupyter-lab-report-share.zip`，
  自动排除 `profile.json`（真实凭据）、`output/`（个人成果）与缓存。发给别人前只跑这一条命令，别手打 zip。
  对方把 zip 交给自己的 AI 说"按 SKILL.md 部署这个技能"，AI 会按上面「部署」节装好并问本人初始化信息。
- **换机器**：`python <skill>/scripts/nbkit.py doctor` 一次看全依赖/中文字体/浏览器/档案缺项。
- **换 agent**：脚本是纯 CLI + 纯 Python API，不依赖任何 agent 专有工具；`SKILL.md` 用的是
  Claude Code / Qoder 的 skill 约定（frontmatter `name` + `description`），Codex / Cursor 直接把
  本目录放进它们的 skills 目录，或在规则文件里指向本 SKILL.md。
- **封面怎么改**：改 `assets/表头.docx`（含校徽/校名两张图与固定字段），`cover` 命令读它复刻；
  动 docx 后先跑一次 `cover` 看效果。docx 里的学生姓名/课程名称/完成时间会被档案与本次参数覆盖，
  实验室/院系/专业/年级以 docx 为准。
- **爬虫**：`scripts/crawl_lms.py` 支持单 URL 与 `--batch`；LMS 地址默认 `http://10.30.0.135`，
  换环境 `set courses.<k>.lms.base=...`。账号密码明文存在档案里，注意别把 profile.json 传给别人。
- **课件形态不是 notebook 导出**（终端截图 / 纯文字步骤）时见 `references/course-branch-example.md`；
  询问话术见 `references/ask-user-checklist.md`；打印与字体细节见 `references/pdf-and-fonts.md`。
- **依赖**：`pip install -r requirements.txt`（nbformat / nbconvert / jupyter-client / ipykernel；
  matplotlib 与 pypdf 可选，分别用于画图与报页数）。
