# jupyter-lab-report

用于处理繁琐的实验报告的一个工作流 — 把课程实验课件（PDF / 截图 / md 讲义 + 数据集，或从 LMS 爬取）复刻成
**自己真跑过的 `.ipynb`**，并导出**中文不乱码、带学校封面表头的 A4 PDF**，交付文件名按档案里的规则自动署名。

脚本是纯 CLI + 纯 Python，不依赖任何特定 agent；`nbkit.py pack` 一键打成纯净分享包（自动排除档案、个人成果与缓存）。

Turn course lab handouts (PDF / screenshots / markdown, or crawled LMS pages, plus datasets) into
**your own executed Jupyter notebook** and a **Chinese-safe A4 PDF with the school cover page**,
with a fixed naming convention for submission.

The workflow is machine-independent. Everything that *is* machine-specific — who is submitting,
where the courseware lives, where deliverables go, which Python interpreter runs the notebook,
which browser prints the PDF, the LMS account — lives in a `profile.json`. When a field is missing
the tooling refuses to guess: it prints a standard question list so the agent asks you, then records
the answer.

## Why this exists

Reproducing a lab handout is mostly bookkeeping, and the failure modes are boring but expensive:

- **The notebook was never really run.** `nbconvert --execute` output is the only proof; empty
  output cells get flagged as failures by `audit`.
- **Silent wrong-environment execution.** `nbconvert --execute` resolves a *kernelspec name*, not an
  interpreter. Swapping the Python that launches nbconvert does not swap the kernel. `run` registers
  a temporary kernelspec for the interpreter in your profile, so the notebook really runs there.
- **Chinese text turns into boxes in the PDF.** LaTeX routes drop CJK glyphs; this prints through
  headless Chrome/Edge (Skia PDF) with a print stylesheet instead.
- **The cover page is a template, not a one-off.** `assets/表头.docx` is the cover master: dynamic
  fields (实验名称 / 学生姓名 / 课程名称 / 完成时间) are filled per run, fixed fields
  (实验室 / 院系 / 专业 / 年级) are read straight from the template.
- **Long outputs blow up the PDF.** `trim` truncates text outputs over 60 lines / 2000 chars with an
  omission marker, so pagination stays sane while `show(50)`-style handout outputs survive intact.
- **Hard-coded paths rot.** Nothing in `SKILL.md` or `nbkit.py` contains an absolute path or a
  personal identifier.

## Install

```bash
git clone <your-fork-url> && cd jupyter-lab-report
pip install -r requirements.txt
python scripts/nbkit.py doctor
```

`doctor` reports: interpreter, `nbformat` / `nbconvert` / `jupyter_client` / `matplotlib`,
available CJK fonts, a usable headless browser, and profile status.

Then drop the folder into your agent's skills directory (see [Agent integration](#agent-integration))
and fill the profile once. First run asks eight items (初始化信息，只问这一次，写进档案):
学号 → 姓名 → 课程名字（同时用作条目 key）→ LMS 账号 → LMS 密码 → 输出目录 → Python 解释器 → 备注（可空）:

```bash
python scripts/nbkit.py init \
  --student-id 20240001 --student-name "Zhang San" \
  --course "大数据实验" --lms-user ... --lms-pass ... \
  --output-dir ~/work/ml \
  --python "$(which python3)" --note "..." --set-default
```

**Share with classmates (AI-assisted install):** run `python scripts/nbkit.py pack` and send the
zip. The recipient hands it to their agent — "按 SKILL.md 部署这个技能" — and the agent follows the
部署 section of `SKILL.md`: verify completeness, place the folder in the skills directory, install
dependencies, run `doctor`, then ask the recipient the eight initialization questions. Everyone
fills their own profile; never send anyone your `profile.json`.

## Quickstart

```bash
python scripts/nbkit.py check "大数据实验"                    # 摊开本次要用的路径
python scripts/nbkit.py crawl <LMS-url> --course "大数据实验" # 可选：爬课件成 md（落 输出目录/courseware/）
python scripts/nbkit.py cover "实验四-逻辑回归" --course "大数据实验" --json   # 封面 = 第一个 md 格
python scripts/nbkit.py build cells.json draft.ipynb --course "大数据实验"
python scripts/nbkit.py run   draft.ipynb --course "大数据实验" --timeout 900
python scripts/nbkit.py audit draft.ipynb                    # 逐格输出；报错/空跑即失败
python scripts/nbkit.py trim  draft.ipynb                    # 过长输出截断，防 PDF 翻页爆炸
python scripts/nbkit.py deliver draft.ipynb "实验四-逻辑回归" --course "大数据实验"
python scripts/nbkit.py pdf  "20240001-Zhang San-实验四-逻辑回归.ipynb" --course "大数据实验"
python scripts/nbkit.py clean cells.json
python scripts/nbkit.py pack                                 # 打成纯净分享 zip（排除档案/成果/缓存）
```

`cells.json` is a flat cell list, which keeps the model out of ipynb JSON entirely:

```json
{"cells": [
  {"type": "md",   "source": "<cover HTML from nbkit.py cover>"},
  {"type": "md",   "source": "## 1. Imports"},
  {"type": "code", "source": "import pandas as pd"}
]}
```

## What gets asked, and when

**第一次（初始化，只问这一次）：** 学号、姓名、课程名字（同时用作条目 key）、LMS 账号、LMS 密码、
输出目录、Python 解释器、备注（可空）→ 全部写进档案。

**每次实验（四问，都不写档案）：** 实验名字（留空自动取课件页标题）、本次作业的特殊要求（可写"没有"，
如"变量名加姓名全拼"）、爬取地址（可写"没有"）、数据地址（可写"没有"）。日期自动用今天填封面
"完成时间"、课件 md 自动落 `输出目录/courseware/`——这些都不问。

## The profile

The profile lives inside the skill package at `<skill>/profile.json` (path relative to the skill
directory; `$NBKIT_PROFILE` can point elsewhere as an override). It travels with the skill — when
you copy or upgrade the skill folder, take `profile.json` along (it holds your signature, paths
and the LMS account). **Never hand it to anyone**: to share the skill, run `nbkit.py pack`, which
excludes the profile and caches automatically. Every command prints the resolved path.

| Field | Meaning | Asked if missing |
| --- | --- | --- |
| `student.id`, `student.name` | signature used in deliverable filenames and the cover | yes (first run) |
| `student.name_pinyin` | full-name pinyin, for note requests like variable renaming | on demand |
| `deliver_pattern` | filename template, default `{id}-{name}-{exp}` | no (default) |
| `default_course` | which entry to use when not specified | yes (first run) |
| `courses.<k>` | entry key — same value as the course name, asked once | yes (first run) |
| `courses.<k>.label` | course display name (cover 课程名称 fallback) | no (defaults to the key) |
| `courses.<k>.note` | course-level note (optional) | no |
| `courses.<k>.output_dir` | where ipynb / pdf / `data/` are written; `courseware/` is created under it | yes (first run) |
| `courses.<k>.python` | interpreter that must run the notebook | yes (first run) |
| `courses.<k>.lms.base / username / password` | LMS crawler target and login (plaintext, local only) | yes (first run) |
| `courses.<k>.cover.course_name` | cover 课程名称 (falls back to `label`) | no |
| `courses.<k>.kernel`, `display_name` | kernelspec written into the notebook | no (default) |
| `tools.print_pdf.path` | Chrome/Edge binary for headless printing | no (auto-detected) |

Copy `profile.example.json` to `profile.json` (in the skill folder) and edit, or use `init` / `set`
(`set` deep-merges, so single fields are one-liners). `deliver` refuses to overwrite an existing
deliverable unless you pass `--force`.

## Agent integration

`SKILL.md` follows the widely used skill convention (frontmatter `name` + `description`, body of
instructions). The CLI is plain `python scripts/nbkit.py ...`, and the Python API is plain imports —
no agent-specific tool is required, so the same folder works for:

| Agent | Where to put it |
| --- | --- |
| Claude Code | `~/.claude/skills/jupyter-lab-report/` |
| Codex CLI | `~/.codex/skills/jupyter-lab-report/` |
| Qoder | `~/.agents/skills/jupyter-lab-report/` |
| Cursor / anything else | keep the folder anywhere and point a rules file at `SKILL.md` |

Naming: the directory name is the skill's identity — keep it equal to the frontmatter `name`
(default `jupyter-lab-report`) so every agent discovers it reliably; to rename, change both
together. Nothing in the scripts hard-codes the name, so any matched pair works.

Prompting in another language works: the `description` carries both Chinese and English trigger
phrases. The instruction body is Chinese because the workflow (courseware reproduction, student-ID
filename signatures, oral defence) is a Chinese-classroom one; contributions that translate it are
welcome.

## Layout

```
SKILL.md                    the workflow (Chinese)
README.md                   this file
profile.example.json        template; copy to profile.json (same folder)
assets/表头.docx             cover master (school logo + fixed fields)
scripts/nbkit.py            CLI + Python API, no personal data, no absolute paths
scripts/crawl_lms.py        LMS crawler (single URL or --batch, login via env)
references/
  ask-user-checklist.md     exact questions, in order, plus what not to ask
  troubleshooting.md        known errors: symptom → cause → fix (check first, append new ones)
  pdf-and-fonts.md          why browser printing, CJK fonts, page-break CSS
  course-branch-example.md  how to document a course that differs from the norm
evals/evals.json            behaviour checks, including the ask-first contract
```

## Contributing

Two rules keep it portable: (1) no absolute path or personal identifier in any tracked file except
`profile.example.json` placeholders; (2) new environment knowledge goes into the profile or
`references/`, never into `SKILL.md`'s flow.

Licensed under the Apache License, Version 2.0 — see [LICENSE](LICENSE).
