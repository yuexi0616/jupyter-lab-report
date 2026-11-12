# 询问规范：题面、顺序、以及什么不该问

`python scripts/nbkit.py ask <course>` 会按当前档案打印下面的清单（只打印真正缺的项）。
把它的输出直接转成提问，不要自己另编字段名。

## 第一次：初始化信息（只问这一次，写进档案）

提问前先说明"**这是初始化信息，只问这一次**"。顺序固定：

| # | 字段 | 中文题面 | English |
| --- | --- | --- | --- |
| 1 | `student.id` | 署名编号用什么（学号/工号）？ | What ID goes in the deliverable filename? |
| 2 | `student.name` | 署名姓名用什么？ | What name goes in the filename? |
| 3 | `courses.<k>.label` | 课程名字（封面"课程名称"、档案条目显示名，**同时用作条目 key**），如"大数据实验"？ | Which course/project is this for? |
| 4 | `courses.<k>.lms.username` | LMS 登录账号（爬课件用，明文写进档案）？ | LMS username? |
| 5 | `courses.<k>.lms.password` | LMS 登录密码？ | LMS password? |
| 6 | `courses.<k>.output_dir` | 成果（ipynb / pdf / data）交付到哪个目录？ | Where should deliverables be written? |
| 7 | `courses.<k>.python` | 用哪个 Python 解释器跑这个 notebook？ | Which interpreter must run this notebook? |
| 8 | `courses.<k>.note` | 备注（可空；本条目级附注，如"变量名统一加姓名全拼"）？ | Any standing note? |

提问方式按所在 agent 走：Claude Code 用 AskUserQuestion（把档案里已有的同类路径作为候选项，
标成"档案记录，推荐"）；命令行 / Codex / Cursor 就直接在回复里列这八条，让用户一次答完。

## 落盘，别只记在对话里

```bash
python scripts/nbkit.py init --course "大数据实验" --lms-user ... --lms-pass ... \
    --output-dir ... --python ... --note "..." --set-default
python scripts/nbkit.py set courses."大数据实验".output_dir=~/work/ml
```

下次同一门课只复述一行"档案：输出目录 = …，解释器 = …，LMS 账号 = …，对吗？"，对了就继续，不要重新逐条索要。

## 每次实验开始：问四项（都不写档案）

1. **实验名字** —— 这次实验叫什么？留空就自动取爬下来课件页面的标题。
2. **本次作业的特殊要求**（可写"没有"）—— 老师的个性化要求，每次单独问。
3. **爬取地址**（可写"没有"）—— LMS assignment URL；没有就不爬，用 `courseware/` 里已有的。
4. **数据地址**（可写"没有"）—— 课件点名的数据集在哪（绝对路径，可多个）；每份作业数据可能不同，
   不落盘。

## 不该问的

- `deliver_pattern`、`kernel`、`display_name`、`tools.print_pdf.path`：都有默认值或能自动探测，
  探测到了按提示落盘即可。
- 日期（封面"完成时间"自动用今天）、课件 md 放哪（默认 `<output_dir>/courseware/`）。
- 课件里已经写明的东西（实验名、字段含义、步骤顺序）：那是"标准答案"，读课件，不是问用户。
- 数据缺失之外的替代方案：数据集找不到要问，但"要不要顺手加一节调参"这种不要问——课件没有就不做。

## 三条红线

1. **不拿同名/相邻目录兜底。** 找不到就是找不到，问；不要退到"看起来像"的目录，那会静默交付错版本。
2. **不造数据。** 用户明确同意后才用现有数据集派生，并在 notebook 里注明换了数据源。
3. **档案里目录不存在时先核一句。** 外接盘没插、目录改过名、同盘有两个名字几乎一样的目录，
   都属于"路径过期"，用 `os.listdir` 看 repr 而不是改字猜。
