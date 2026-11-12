#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""nbkit —— 把课程实验课件复刻成本人 notebook 并出中文 PDF 的固定动作。

设计约束：本文件不含任何个人信息与机器路径。"谁交付、课件在哪、成果放哪、用哪个解释器、
用什么打印 PDF" 全部来自环境档案 profile.json，查找顺序见 profile_path()。
档案缺字段时函数抛 ProfileError 并附标准题面——照题面问用户，不要猜路径。

两种用法，任选：

  # A) 命令行（推荐，任何 agent / shell 都能驱动，不需要 import）
  python nbkit.py doctor
  python nbkit.py init --student-id 20240001 --student-name Zhang San \\
      --course ml-lab --label 大数据实验 --lms-user ... --lms-pass ... \\
      --output-dir ~/work/ml --python "$(which python3)"
  python nbkit.py check ml-lab
  python nbkit.py crawl http://10.30.0.135/courses/194/assignments/2179 --course ml-lab --out ~/courseware
  python nbkit.py cover "实验四-逻辑回归" --course ml-lab --json     # 封面，作为首个 md 单元格
  python nbkit.py build cells.json draft.ipynb --course ml-lab
  python nbkit.py run draft.ipynb --course ml-lab
  python nbkit.py audit draft.ipynb
  python nbkit.py deliver draft.ipynb "实验四-逻辑回归" --course ml-lab
  python nbkit.py pdf "20240001-Zhang San-实验四-逻辑回归.ipynb" --course ml-lab

  # B) Python API（在构建脚本里）
  import nbkit
  nbkit.preflight("ml-lab")
  cells = [nbkit.MD("## 一、导包"), nbkit.CODE("import pandas as pd")]
  out = nbkit.deliver(nbkit.build(cells, "draft.ipynb", course="ml-lab"), "实验四", course="ml-lab")
  nbkit.to_pdf(out, course="ml-lab")

cells.json 格式：[{"type": "md"|"code", "source": "..."}]，或 {"cells": [...]} 同结构。
"""
from __future__ import annotations

import argparse
import base64
import datetime
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile

# Windows 控制台默认 GBK，会破坏 --json 这类管道输出；统一按 UTF-8 输出，交给调用方解码
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

SKILL_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPTS_DIR = os.path.join(SKILL_DIR, "scripts")
ASSETS_DIR = os.path.join(SKILL_DIR, "assets")
PROFILE_FILE = os.path.join(SKILL_DIR, "profile.json")   # 档案就在技能包内，相对技能目录
EXAMPLE_PROFILE = os.path.join(SKILL_DIR, "profile.example.json")
DEFAULT_PATTERN = "{id}-{name}-{exp}"
DEFAULT_LMS_BASE = "http://10.30.0.135"

# 标准提问清单：顺序即询问顺序，一次问全，不要挤牙膏式追问。
# 只列"必须人给"的字段；有默认值或能自动探测的（文件名模板、kernelspec、浏览器）不进清单。
# 第一次（初始化）只问一次并写进档案：学号 → 姓名 → 课程名字 → LMS 账号 → LMS 密码
#   → 输出目录 → Python 解释器 → 备注（可空）→ 水印偏好（ask/always/never）。
# 每次实验开始时另问 4 项（不写档案，见 SKILL.md 第 0 节）：实验名字（可空，自动取
#   课件页标题）、本次特殊要求（可空）、爬取地址（可空）、数据地址（可空）；
#   水印 mode=ask 时再另问一句：这次加不加水印、用什么文字。
GLOBAL_ASK = [
    ("student.id", "署名第一段（学号，交付文件名用）"),
    ("student.name", "署名第二段（姓名，也用于封面）"),
    ("tools.print_pdf.watermark.mode",
     "PDF 水印偏好：每次询问 ask / 一直添加 always / 一直不添加 never（水印文字可一并给，留空默认\"学号 姓名\"）"),
]
# 条目 key 与课程名字同一值（init 时 --course 同时定 key 与 label），label 不再单问；
# resolve() 对缺 label 的旧档案回退用 key，不拦路。
COURSE_ASK = [
    ("lms.username", "LMS 登录账号（爬课件用，明文写入档案）"),
    ("lms.password", "LMS 登录密码（明文写入档案）"),
    ("output_dir", "成果输出目录（绝对路径，ipynb / pdf / data 都落这里）"),
    ("python", "执行 notebook 的 Python 解释器（绝对路径）"),
]
# 真正跑不动才拦；LMS 账号密码只在要爬取时才拦（见 crawl()）
HARD_MISSING = ("student.id", "student.name", "output_dir")


class ProfileError(RuntimeError):
    """档案缺字段。异常文本就是给用户的提问清单。"""


# --------------------------------------------------------------------------- 档案

def profile_path() -> str:
    """档案位置：$NBKIT_PROFILE 覆盖 > <技能目录>/profile.json。
    档案随技能包走（相对技能目录），拷贝/升级技能包时记得连 profile.json 一起带走。"""
    env = os.environ.get("NBKIT_PROFILE")
    if env:
        return os.path.abspath(os.path.expanduser(env))
    return PROFILE_FILE


def load_profile(path: str | None = None) -> dict:
    p = path or profile_path()
    if not os.path.exists(p):
        return {}
    with io.open(p, encoding="utf-8") as f:
        return json.load(f)


def _merge(dst: dict, src: dict) -> dict:
    for k, v in src.items():
        if isinstance(v, dict) and isinstance(dst.get(k), dict):
            _merge(dst[k], v)
        else:
            dst[k] = v
    return dst


def save_profile(updates: dict, path: str | None = None) -> str:
    """把问到的值深合并写回档案。同一个字段下次只复述确认，不再重复问。"""
    p = path or profile_path()
    prof = load_profile(p)
    _merge(prof, updates)
    prof["updated_at"] = __import__("datetime").date.today().isoformat()
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with io.open(p, "w", encoding="utf-8") as f:
        json.dump(prof, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"profile updated -> {p}")
    return p


def _dig(prof: dict, dotted: str):
    cur = prof
    for key in dotted.split("."):
        if not isinstance(cur, dict) or key not in cur:
            return None
        cur = cur[key]
    return cur


def course_key(prof: dict | None = None, course: str | None = None) -> tuple[str, dict]:
    prof = prof if prof is not None else load_profile()
    courses = prof.get("courses", {}) or {}
    key = course or prof.get("default_course") or (list(courses)[0] if len(courses) == 1 else None)
    if not key:
        raise ProfileError("档案里没有 default_course，也没传 course：先问用户这是哪门课/哪个项目。")
    data = courses.get(key)
    if data is None:
        have = ", ".join(courses) or "（还没有任何条目）"
        raise ProfileError(
            f"档案里没有 '{key}'，已有：{have}。\n"
            f"问用户这条目的信息后落盘：\n"
            f"  python nbkit.py init --course {key} --label 课程名字 --lms-user ... --lms-pass ... "
            f"--output-dir ... --python ...\n"
            f"  或 nbkit.save_profile({{'courses': {{'{key}': {{...}}}}}})"
        )
    return key, data


def resolve(course: str | None = None, prof: dict | None = None) -> dict:
    """把档案摊平成一次交付要用的参数；HARD_MISSING 缺了就抛，附标准题面。"""
    prof = prof if prof is not None else load_profile()
    key, c = course_key(prof, course)
    lms = c.get("lms") or {}
    vals = {
        "course": key,
        "course_label": c.get("label", key),
        "student_id": _dig(prof, "student.id"),
        "student_name": _dig(prof, "student.name"),
        "student_pinyin": _dig(prof, "student.name_pinyin"),
        "pattern": _dig(prof, "deliver_pattern") or DEFAULT_PATTERN,
        "output_dir": c.get("output_dir"),
        "python": c.get("python") or sys.executable,
        "kernel": c.get("kernel", "python3"),
        "browser": c.get("browser") or _dig(prof, "tools.print_pdf.path"),
        "note": c.get("note"),
        "cover_course_name": _dig(c, "cover.course_name") or c.get("label") or key,
        "lms": {
            "base": lms.get("base") or DEFAULT_LMS_BASE,
            "username": lms.get("username"),
            "password": lms.get("password"),
        },
    }
    keys = {"student.id": "student_id", "student.name": "student_name", "output_dir": "output_dir"}
    missing = [f for f in HARD_MISSING if not vals.get(keys[f])]
    if missing:
        raise ProfileError(ask_text(course, prof, missing))
    return vals


def missing_fields(course: str | None = None, prof: dict | None = None) -> list[tuple[str, str]]:
    prof = prof if prof is not None else load_profile()
    out = [(d, label) for d, label in GLOBAL_ASK if not _dig(prof, d)]
    key = course or prof.get("default_course")
    courses = prof.get("courses", {}) or {}
    if not key and len(courses) == 1:
        key = list(courses)[0]
    if not key:
        if not courses:
            return [("default_course", "课程名字（封面\"课程名称\"、档案条目显示名，同时用作档案条目 key），如\"大数据实验\"")] + out
        return [("default_course", "本次做哪门课（档案已有：" + "、".join(courses) + "，选一个）")] + out
    c = courses.get(key) or {}   # 条目还没登记时，逐条问，不要只回问条目名
    for field, label in COURSE_ASK:
        if not _dig(c, field):
            out.append((f"courses.{key}.{field}", label))
    return out


def ask_text(course: str | None = None, prof: dict | None = None, only: list[str] | None = None) -> str:
    """现成的提问文案：直接拿去向用户提问，不要自己编字段名，更不要猜路径。"""
    miss = [(d, t) for d, t in missing_fields(course, prof) if only is None or d in only]
    if not miss:
        return "档案完整，无需提问。"
    lines = ["—— 初始化信息（只问这一次，之后写进档案，以后不再重复问）——",
             f"档案 {profile_path()} 缺失以下字段，逐项向用户确认（已有同类路径作为候选项，不要替他决定）："]
    for i, (dotted, label) in enumerate(miss, 1):
        lines.append(f"  {i}. {label}  [字段 {dotted}]")
    lines.append("问到后落盘：python nbkit.py set 字段=值；未确认的目录不要拿同名/相邻目录兜底。")
    return "\n".join(lines)


def preflight(course: str | None = None, prof: dict | None = None) -> str:
    """执行前摊开本次要用的每一项，并检查目录是否真的存在。这一步不能跳——路径写错往往在成果落盘后才发现。"""
    prof = prof if prof is not None else load_profile()
    miss = missing_fields(course, prof)
    if miss:
        raise ProfileError(ask_text(course, prof))
    v = resolve(course, prof)
    lms = v["lms"]
    wm = watermark_setting(prof)
    cw_dir = os.path.join(v["output_dir"], "courseware")
    report = [
        f"档案     {profile_path()}",
        f"署名     {v['student_id']}-{v['student_name']}  (文件名模板 {v['pattern']})",
        f"条目     {v['course']} / {v['course_label']}",
        f"输出目录 {v['output_dir']}  [{'存在' if os.path.isdir(v['output_dir']) else '待创建'}]",
        f"课件目录 {cw_dir}（默认，爬下来直接落这里）",
        f"解释器   {v['python']}  [{'存在' if os.path.exists(v['python']) else '不存在'}]",
        f"LMS      {lms['base']}  "
        f"[{'账号已登记' if lms['username'] and lms['password'] else '账号/密码未登记，要爬取前先问'}]",
        f"封面课程 {v['cover_course_name']}",
        f"PDF 引擎 {v['browser'] or '（档案未记录，打印时自动探测 Chrome/Edge）'}",
        f"水印     {wm['mode']}" + (f" 文字={wm['text']}" if wm["text"] else "（文字默认学号 姓名）"),
    ]
    print("\n".join(report))
    return "\n".join(report)


# --------------------------------------------------------------------------- 环境与体检

def find_browser() -> str | None:
    """PATH 上的 chrome/msedge/chromium，再看各平台标准安装位。"""
    for exe in ("chrome", "msedge", "chromium", "chromium-browser", "google-chrome"):
        hit = shutil.which(exe)
        if hit:
            return hit
    candidates = [
        r"C:/Program Files/Google/Chrome/Application/chrome.exe",
        r"C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
        r"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
        r"C:/Program Files/Microsoft/Edge/Application/msedge.exe",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/microsoft-edge",
        "/usr/bin/chromium",
    ]
    return next((c for c in candidates if os.path.exists(c)), None)


def cjk_fonts() -> list[str]:
    """列出本机 matplotlib 能用的中文字体。没有中文字体时 PDF 里的图会全是方框。"""
    try:
        from matplotlib import font_manager
    except Exception:
        return []
    wanted = ("SimHei", "Microsoft YaHei", "微软雅黑", "Noto Sans CJK", "Source Han Sans",
              "WenQuanYi", "PingFang SC", "Heiti SC", "Songti SC", "SimSun", "FangSong", "KaiTi")
    found = []
    for f in font_manager.fontManager.ttflist:
        name = f.name
        if any(w.lower() in name.lower() for w in wanted) and name not in found:
            found.append(name)
    return found


def font_cell(family: str | None = None) -> str:
    """返回一段可直接放进 notebook 的代码：设置中文字体。不传 family 就自动挑。"""
    fam = family or (cjk_fonts() or ["SimHei"])[0]
    return (f"import matplotlib.pyplot as plt\n"
            f"plt.rcParams['font.sans-serif'] = ['{fam}']\n"
            f"plt.rcParams['axes.unicode_minus'] = False")


# --------------------------------------------------------------------------- 封面

COVER_TEMPLATE = "表头.docx"   # assets/ 下的封面模板，固定字段（院系/专业/年级…）以它为准


def _cover_parts() -> dict:
    """从封面模板 docx 拆出：按文档顺序的图片 data-url 列表、固定字段值。"""
    path = os.path.join(ASSETS_DIR, COVER_TEMPLATE)
    if not os.path.exists(path):
        raise ProfileError(f"assets/ 里没有封面模板 {COVER_TEMPLATE}。问用户模板 docx 在哪，放进去再跑。")
    with zipfile.ZipFile(path) as z:
        xml = z.read("word/document.xml").decode("utf-8")
        rels = z.read("word/_rels/document.xml.rels").decode("utf-8")
        relmap = dict(re.findall(r'Id="(rId\d+)"[^>]*Target="([^"]+)"', rels))
        images = []
        for m in re.finditer(r"<w:drawing>.*?</w:drawing>", xml, re.DOTALL):
            emb = re.search(r'r:embed="(rId\d+)"', m.group(0))
            if not emb or emb.group(1) not in relmap:
                continue
            target = relmap[emb.group(1)]
            if "media" not in target:
                continue
            data = z.read("word/" + target.lstrip("/"))
            mime = "image/png" if target.lower().endswith(".png") else "image/jpeg"
            images.append("data:%s;base64,%s" % (mime, base64.b64encode(data).decode()))
        paras = re.findall(r"<w:p[ >].*?</w:p>|<w:p/>", xml, re.DOTALL)

        def para_text(p: str) -> str:
            return "".join(re.findall(r"<w:t[^>]*>([^<]*)</w:t>", p))

        fixed = {}
        for label in ("实验室", "院系", "专业", "年级", "学生姓名", "课程名称", "完成时间"):
            for p in paras:
                t = para_text(p)
                if label.replace(" ", "") in t.replace(" ", ""):
                    fixed[label] = t.split("：", 1)[-1].strip() if "：" in t else ""
                    break
    return {"images": images, "fixed": fixed}


def render_cover(exp_name: str, course: str | None = None, date: str | None = None,
                 out_path: str | None = None) -> str:
    """把 assets/表头.docx 复刻成一张 A4 封面 HTML（图片 base64 内嵌，可整段放进首个 md 单元格）。

    动态字段：实验名称（exp_name）、学生姓名（档案 student.name，没有就沿用模板里的）、
    课程名称（档案 cover.course_name 或 label）、完成时间（date，默认今天）。
    固定字段（实验室/院系/专业/年级）直接沿用模板里的值——要改去改模板 docx。
    """
    parts = _cover_parts()
    fixed = parts.get("fixed", {})
    v = resolve(course)
    date = date or datetime.date.today().isoformat()
    if "年" not in date:
        d = datetime.date.fromisoformat(str(date)[:10])
        date = f"{d.year}年{d.month}月{d.day}日"
    name = v["student_name"] or fixed.get("学生姓名", "")
    course_name = v["cover_course_name"] or fixed.get("课程名称", "")
    rows = [
        ("学生姓名", name),
        ("课程名称", course_name),
        ("实 验 室", fixed.get("实验室", "")),
        ("院    系", fixed.get("院系", "")),
        ("专    业", fixed.get("专业", "")),
        ("年    级", fixed.get("年级", "")),
        ("完成时间", date),
    ]
    imgs = parts.get("images", [])
    seal, banner = (imgs[0], imgs[1]) if len(imgs) >= 2 else ("", "")
    field_rows = "".join(
        f'<div class="frow"><span class="flabel">{label}：</span>'
        f'<span class="fval">{val or "&nbsp;"}</span></div>'
        for label, val in rows
    )
    html = (
        '<div class="cover">\n'
        '<div class="cover-head">'
        f'<img class="seal" src="{seal}"/><img class="banner" src="{banner}"/></div>\n'
        '<div class="cover-title">实 验 报 告</div>\n'
        f'<div class="exp-line"><span class="flabel">实验名称：</span>'
        f'<span class="fval">{exp_name or "&nbsp;"}</span></div>\n'
        f"{field_rows}\n"
        "</div>\n"
        "<style>\n"
        '.cover { font-family: "SimSun","Microsoft YaHei",sans-serif; color: #000; '
        "page-break-after: always; break-after: page; }\n"
        ".cover-head { text-align: center; margin: 8mm 0 12mm; }\n"
        ".cover-head img { display: inline-block; vertical-align: middle; margin: 0 2mm; }\n"
        ".cover-head .seal { width: 0.6in; height: 0.7in; }\n"
        ".cover-head .banner { width: 5.0in; height: 0.9in; }\n"
        ".cover-title { text-align: center; font-size: 26pt; font-weight: bold; "
        "letter-spacing: 0.5em; margin: 16mm 0 12mm; }\n"
        ".exp-line { display: flex; align-items: baseline; font-size: 16pt; margin: 4mm 0 8mm; }\n"
        ".frow { display: flex; align-items: baseline; font-size: 14pt; margin: 6mm 0; }\n"
        ".flabel { flex: 0 0 30mm; white-space: nowrap; }\n"
        ".fval { flex: 1; max-width: 96mm; text-align: center; "
        "border-bottom: 1px solid #000; padding: 0 2mm 1.5mm; }\n"
        "</style>\n"
    )
    if out_path:
        with io.open(out_path, "w", encoding="utf-8") as f:
            f.write(html)
        print(f"cover -> {out_path}")
    return html


def ensure_kernel(python: str, base_name: str = "python3") -> tuple[str, str]:
    """为目标解释器造一个临时 kernelspec，返回 (kernel_name, JUPYTER_PATH)。

    为什么需要：nbconvert --execute 是按 kernelspec 名找内核的，只换跑 nbconvert 的 python
    并不会换掉 notebook 真正用的解释器——多环境机器上这会静默跑在另一个环境里。
    JUPYTER_PATH 必须是 kernels 目录的父目录，少一层就报 NoSuchKernel。
    """
    chk = subprocess.run([python, "-c", "import ipykernel"], capture_output=True, text=True)
    if chk.returncode != 0:
        raise RuntimeError(
            f"{python} 里没有 ipykernel，无法用它执行 notebook。\n"
            f"先问用户是否允许安装：{python} -m pip install ipykernel\n"
            f"或显式指定已有内核：execute(..., kernel='python3')"
        )
    import hashlib

    abspath = os.path.abspath(python)
    tag = re.sub(r"\W+", "", os.path.basename(abspath)) + hashlib.md5(abspath.encode()).hexdigest()[:8]
    name = f"nbkit-{tag}"
    jupyter_path = os.path.join(tempfile.gettempdir(), "nbkit-kernels")
    spec = os.path.join(jupyter_path, "kernels", name)
    os.makedirs(spec, exist_ok=True)
    with io.open(os.path.join(spec, "kernel.json"), "w", encoding="utf-8") as f:
        json.dump({
            "argv": [abspath, "-m", "ipykernel_launcher", "-f", "{connection_file}"],
            "display_name": f"nbkit ({os.path.basename(abspath)})",
            "language": "python",
            # Windows 内核 stdout 默认 GBK，中文 print 会被存成乱码；强制 UTF-8
            "env": {"PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"},
        }, f, indent=2)
    return name, jupyter_path


def doctor() -> str:
    """一次性报出环境是否够跑：依赖、中文字体、浏览器、档案状态。"""
    lines = [f"python     {sys.executable}  ({sys.version.split()[0]})", f"platform   {sys.platform}"]
    for mod in ("nbformat", "nbconvert", "jupyter_client", "matplotlib"):
        try:
            __import__(mod)
            lines.append(f"依赖       OK  {mod}")
        except Exception as e:
            lines.append(f"依赖       缺  {mod}  ({type(e).__name__}: {e})")
    fonts = cjk_fonts()
    lines.append(f"中文字体   {', '.join(fonts) if fonts else '没找到 —— 图里的中文会变方框，先装一个或指定 family'}")
    br = find_browser()
    lines.append(f"PDF 引擎   {br or '没找到 Chrome/Edge —— 出 PDF 前问用户装哪个'}")
    p = profile_path()
    lines.append(f"档案       {p}  [{'已存在' if os.path.exists(p) else '不存在，首次 check 会逐项询问'}]")
    if os.path.exists(p):
        try:
            prof = load_profile(p)
            miss = missing_fields(prof=prof)
            lines.append(f"档案字段   {'完整' if not miss else '待补：' + ', '.join(d for d, _ in miss)}")
        except Exception as e:
            lines.append(f"档案       解析失败：{e}")
    print("\n".join(lines))
    return "\n".join(lines)


# --------------------------------------------------------------------------- 建 / 跑 / 查

def MD(text: str):
    return ("md", text.strip())


def CODE(text: str):
    return ("code", text.strip())


def build(cells, out_path: str, kernel: str | None = None, display_name: str | None = None,
          course: str | None = None) -> str:
    """cells: [(kind, source)] 或 cells.json 读出来的 list[dict]。内核名默认取档案该条目配置。"""
    import nbformat as nbf

    if kernel is None:
        prof = load_profile()
        if course or prof.get("default_course") or len(prof.get("courses", {}) or {}) == 1:
            key = course_key(prof, course)[0]
            kernel = _dig(prof, f"courses.{key}.kernel") or "python3"
            display_name = display_name or _dig(prof, f"courses.{key}.display_name") or kernel
        else:
            kernel, display_name = "python3", "Python 3"
    nb = nbf.v4.new_notebook()
    nb.metadata.update({
        "kernelspec": {"display_name": display_name or kernel, "language": "python", "name": kernel},
        "language_info": {"name": "python"},
    })
    norm = [(c["type"], c["source"]) if isinstance(c, dict) else c for c in cells]
    nb.cells = [
        nbf.v4.new_markdown_cell(s) if k in ("md", "markdown") else nbf.v4.new_code_cell(s)
        for k, s in norm
    ]
    os.makedirs(os.path.dirname(os.path.abspath(out_path)) or ".", exist_ok=True)
    nbf.write(nb, out_path)
    md = sum(1 for k, _ in norm if k in ("md", "markdown"))
    print(f"built {out_path}: {len(norm)} cells ({md} md / {len(norm) - md} code)")
    return out_path


def execute(path: str, timeout: int = 600, python: str | None = None, course: str | None = None,
            kernel: str | None = None) -> str:
    """就地执行，把输出写回 ipynb。没跑过的 notebook 不算交付。

    解释器优先级：显式 python > 档案该条目的 python > 当前进程。
    除非显式传 kernel，否则为该解释器临时注册内核，保证"跑的就是档案里那个环境"。
    """
    py = python or (resolve(course)["python"] if course else sys.executable)
    args = [py, "-m", "nbconvert", "--to", "notebook", "--execute", "--inplace",
            path, f"--ExecutePreprocessor.timeout={timeout}"]
    env = dict(os.environ)
    if kernel:
        args.append(f"--ExecutePreprocessor.kernel_name={kernel}")
    else:
        kn, jp = ensure_kernel(py)
        args.append(f"--ExecutePreprocessor.kernel_name={kn}")
        env["JUPYTER_PATH"] = jp + os.pathsep + env.get("JUPYTER_PATH", "")
    print(f"execute {path}  python={py}  kernel={kernel or 'nbkit 临时内核'}")

    r = subprocess.run(args, capture_output=True, text=True, encoding="utf-8", errors="replace",
                       timeout=timeout + 120, env=env)
    tail = [ln for ln in (r.stdout + r.stderr).splitlines() if "NbConvertApp" in ln or "Error" in ln]
    print("\n".join(tail[-4:]) or f"nbconvert rc={r.returncode}")
    if r.returncode != 0:
        raise RuntimeError(f"执行失败：{path}\n{(r.stderr or '')[-1500:]}")
    return path


def audit(path: str, wide: int = 200, strict: bool = True) -> dict:
    """打印每个代码单元格的结论性输出供人和课件对数；有 error 直接抛，疑似空跑给警告。

    对数看什么：样本数、缺失值数、指标值、分类报告——逐项和课件的 Out[n] 比。
    """
    import nbformat as nbf

    nb = nbf.read(path, as_version=4)
    imgs, errs, empty, md = 0, [], [], 0
    for i, c in enumerate(nb.cells):
        if c.cell_type != "code":
            md += 1
            continue
        src = (c.source or "").strip()
        outs = c.get("outputs", [])
        for o in outs:
            t = o.get("output_type")
            if t == "stream":
                print(f"[{i}] OUT:", o["text"].strip()[:wide].replace("\n", " | "))
            elif t == "execute_result":
                print(f"[{i}] RES:", str(o["data"].get("text/plain", "")).strip()[:wide].replace("\n", " | "))
            elif t == "display_data" and "image/png" in o.get("data", {}):
                imgs += 1
                print(f"[{i}] <图 {imgs}>")
            elif t == "error":
                errs.append(f"[{i}] {o['ename']}: {o['evalue']}")
        if not outs and _expects_output(src):
            empty.append(i)
    print(f"cells: {len(nb.cells)} ({md} md / {len(nb.cells) - md} code)  图: {imgs}  error: {len(errs)}")
    if empty:
        print(f"疑似空跑（表达式单元格没有任何输出，多半是没真执行）：单元格 {empty}")
    if errs:
        raise RuntimeError("notebook 里有报错单元格：\n" + "\n".join(errs))
    if empty and strict:
        raise RuntimeError("有单元格没产出输出，先确认 execute 是否真的跑过（空输出的 notebook 不能交）")
    print("audit ok: 0 error")
    return {"errors": errs, "images": imgs, "empty_output_cells": empty, "cells": len(nb.cells)}


def trim_outputs(path: str, max_lines: int = 60, max_chars: int = 2000) -> dict:
    """截断过长的单元格输出（dir()、整表 print 这类），避免 PDF 翻页爆炸。

    只动输出文本，不碰代码；中间省略处留一行标记。audit 之后、deliver/pdf 之前跑。
    """
    import nbformat as nbf

    nb = nbf.read(path, as_version=4)
    cut = 0
    for i, c in enumerate(nb.cells):
        if c.cell_type != "code":
            continue
        for o in c.get("outputs", []):
            t = o.get("output_type")
            if t == "stream":
                text = o.get("text", "") or ""
                lines = text.splitlines()
                if len(lines) > max_lines:
                    o["text"] = "\n".join(lines[:max_lines]) + (
                        f"\n…（输出过长，省略 {len(lines) - max_lines} 行）\n")
                    cut += 1
            elif t in ("execute_result", "display_data"):
                data = o.get("data", {})
                tp = data.get("text/plain", "")
                if isinstance(tp, list):
                    tp = "".join(tp)
                if isinstance(tp, str):
                    lines = tp.splitlines()
                    if len(lines) > max_lines:
                        tp = "\n".join(lines[:max_lines]) + (
                            f"\n…（输出过长，省略 {len(lines) - max_lines} 行）")
                        cut += 1
                    if len(tp) > max_chars:
                        tp = tp[:max_chars] + (
                            f"\n…（输出过长，省略 {len(tp) - max_chars} 字符）")
                        cut += 1
                    data["text/plain"] = tp
    nbf.write(nb, path)
    print(f"trim {path}: 截断 {cut} 处（> {max_lines} 行 / > {max_chars} 字符）")
    return {"cut": cut}


def _expects_output(src: str) -> bool:
    """最后一行是裸表达式 / head / plot / describe 这类，执行后应该有输出。"""
    if not src:
        return False
    last = [ln for ln in src.splitlines() if ln.strip() and not ln.strip().startswith("#")][-1]
    if re.match(r"^\s*(import |from |%|!|@)", last):
        return False
    if re.search(r"=\s*[^=]", last) and not last.lstrip().startswith(("df[", "plt.")):
        return False
    if re.search(r"\.(head|tail|info|describe|shape|value_counts|plot|show|display|hist|bar|corr)\b", last):
        return True
    if re.match(r"^\s*(print|display)\s*\(", last):
        return True
    return bool(re.match(r"^[A-Za-z_][\w.\[\]'\"]*$", last.strip()))


def deliver(path: str, exp_name: str, course: str | None = None, dest_dir: str | None = None,
            student_id: str | None = None, student_name: str | None = None, pattern: str | None = None,
            force: bool = False) -> str:
    """按档案 deliver_pattern 重命名并落到该条目的 output_dir。

    实验名取课件文件名，不要自己发挥。显式参数只用于本次覆盖，长期值请写回档案。
    """
    v = resolve(course)
    sid = student_id or v["student_id"]
    name = student_name or v["student_name"]
    dest = os.path.expanduser(dest_dir or v["output_dir"])
    stem = _safe((pattern or v["pattern"]).format(id=sid, name=name, exp=exp_name))
    os.makedirs(dest, exist_ok=True)
    new = os.path.join(dest, stem + ".ipynb")
    if os.path.abspath(new) == os.path.abspath(path):
        return new
    if os.path.exists(new) and not force:
        raise RuntimeError(f"目标已存在，不覆盖：{new}\n确认要替换就加 --force，或换实验名。")
    os.replace(path, new)
    print(f"renamed -> {new}")
    return new


def _safe(name: str) -> str:
    return re.sub(r'[<>:"/\\|?*]', "-", name).strip()


PRINT_CSS = """
<style>
@page { size: A4; margin: 14mm 12mm; }
html, body { background: #fff; }
.jp-Notebook { padding: 0; max-width: 100%; }
h1 { font-size: 22px; margin: 6px 0 12px; }
h2 { font-size: 18px; margin: 22px 0 8px; border-bottom: 2px solid #e0e0e0; padding-bottom: 4px; }
h3 { font-size: 15px; margin: 16px 0 6px; }
p, li { font-size: 13px; line-height: 1.75; }
.jp-RenderedHTMLCommon p { margin: 6px 0; }
.jp-InputArea-editor, .jp-OutputArea pre, .jp-RenderedText { font-size: 11.5px !important; line-height: 1.5; }
pre { white-space: pre-wrap !important; word-break: break-all; }
.jp-Cell { page-break-inside: avoid; break-inside: avoid; margin-bottom: 10px; }
h2, h3 { page-break-after: avoid; }
img { max-width: 100%; }
.jp-RenderedHTMLCommon table, .jp-RenderedHTMLCommon tbody tr td { font-size: 11.5px; }
</style>
"""


def watermark_setting(prof: dict | None = None) -> dict:
    """水印配置 tools.print_pdf.watermark {mode, text}；缺字段 mode=ask（初始化问一次落盘）。"""
    prof = prof if prof is not None else load_profile()
    wm = _dig(prof, "tools.print_pdf.watermark") or {}
    mode = str(wm.get("mode") or "ask").lower()
    if mode not in ("ask", "always", "never"):
        mode = "ask"
    return {"mode": mode, "text": wm.get("text") or ""}


def _wm_default_text(prof: dict) -> str:
    sid, name = _dig(prof, "student.id"), _dig(prof, "student.name")
    return " ".join(x for x in (sid, name) if x) or "水印"


def watermark_html(text: str, opacity: float = 0.1) -> str:
    """打印水印层：position:fixed 满屏 div + 内联 SVG 平铺斜排文字。

    Chrome 打印时 fixed 元素每页重复 → 封面到末页全带水印；内联 SVG 属正文内容
    （和图一样），不受"是否打印背景"开关影响。自定义文字做 XML 转义。
    """
    import html as _html
    tile_w = max(240, len(text) * 18 + 60)
    return (
        '<style>.nbkit-wm { position: fixed; top: 0; left: 0; width: 100%; height: 100%; '
        f'z-index: 9999; pointer-events: none; opacity: {opacity}; }}</style>\n'
        '<div class="nbkit-wm" aria-hidden="true">\n'
        '<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">\n'
        f'<defs><pattern id="nbkit-wm-p" width="{tile_w}" height="200" patternUnits="userSpaceOnUse" '
        'patternTransform="rotate(-30)">\n'
        '<text x="10" y="100" font-size="18" fill="#000" font-family="SimSun, Microsoft YaHei, sans-serif">'
        f'{_html.escape(text)}</text>\n'
        '</pattern></defs>\n'
        '<rect width="100%" height="100%" fill="url(#nbkit-wm-p)"/>\n'
        '</svg>\n</div>\n'
    )


def to_pdf(ipynb_path: str, course: str | None = None, browser: str | None = None,
           keep_html: bool = False, watermark: str | None = None, no_watermark: bool = False) -> str:
    """ipynb -> lab 模板 HTML（注入打印 CSS 与可选水印）-> 无头浏览器打印 A4。

    不走 LaTeX：notebook 里的中文标题/注释过 LaTeX 容易丢字形，浏览器链路出的是 Skia/PDF，中文和图都稳。
    浏览器优先级：显式 browser > 档案 > 自动探测（Chrome/Edge 任一）。
    水印优先级：no_watermark > watermark 文字 > 档案 mode（always 加 / never 不加 /
    ask 需显式旗标，否则提醒并不加）。文字留空默认"学号 姓名"。
    """
    from nbconvert import HTMLExporter

    prof = load_profile()
    br = browser or (resolve(course)["browser"] if course else None) or _dig(prof, "tools.print_pdf.path") or find_browser()
    if not br or not os.path.exists(br):
        raise ProfileError(f"没找到可用的无头浏览器（试了：{br or '档案未记录且自动探测失败'}）。\n"
                           "问用户本机 Chrome/Edge 装在哪，再 python nbkit.py set tools.print_pdf.path=...")
    if not _dig(prof, "tools.print_pdf.path"):
        print(f"提示：档案未记录浏览器，本次用 {br}；落盘 python nbkit.py set tools.print_pdf.path={br}")

    wm = watermark_setting(prof)
    if no_watermark:
        wm_text = None
    elif watermark is not None:
        wm_text = watermark.strip() or _wm_default_text(prof)
    elif wm["mode"] == "always":
        wm_text = wm["text"] or _wm_default_text(prof)
    elif wm["mode"] == "never":
        wm_text = None
    else:
        wm_text = None
        print("提示：档案水印 mode=ask 且未显式给 --watermark/--no-watermark，本次不加；"
              "需要就问用户后带 --watermark [文字] 重跑。")

    # 必须绝对路径：无头模式的 --print-to-pdf 按浏览器自己的 cwd 解析相对路径，Windows 上会报 0x5 拒绝访问
    base = os.path.abspath(ipynb_path).rsplit(".", 1)[0]
    html, pdf = base + ".html", base + ".pdf"
    body, _ = HTMLExporter(template_name="lab").from_filename(ipynb_path)
    assert "</head>" in body, "HTML 模板结构变了，检查 nbconvert 版本"
    body = body.replace("</head>", PRINT_CSS + "</head>", 1)
    if wm_text:
        assert "</body>" in body, "HTML 模板结构变了，检查 nbconvert 版本"
        body = body.replace("</body>", watermark_html(wm_text) + "</body>", 1)
        print(f"水印：{wm_text}")
    io.open(html, "w", encoding="utf-8").write(body)

    r = subprocess.run(
        [br, "--headless=new", "--disable-gpu", "--no-sandbox", "--no-pdf-header-footer",
         "--virtual-time-budget=20000", "--run-all-compositor-stages-before-draw",
         f"--print-to-pdf={pdf}", "file:///" + os.path.abspath(html).replace("\\", "/")],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=300,
    )
    if r.returncode != 0 or not os.path.exists(pdf):
        raise RuntimeError(f"{br} 打印失败 rc={r.returncode}\n{(r.stderr or '')[-500:]}")
    if not keep_html:
        os.remove(html)
    pages = _page_count(pdf)
    print(f"{pdf}: {os.path.getsize(pdf) // 1024} KB" + (f", {pages} 页" if pages else ""))
    return pdf


def _page_count(pdf: str):
    for mod in ("pypdf", "PyPDF2"):
        try:
            m = __import__(mod)
            return len(m.PdfReader(pdf).pages)
        except Exception:
            continue
    return None


def cleanup(*paths: str) -> None:
    """临时件收干净：构建脚本、中间 HTML 删掉，交付目录只留 .ipynb + .pdf + data/。"""
    for p in paths:
        if p and os.path.exists(p):
            os.remove(p)
            print("removed", p)


# --------------------------------------------------------------------------- 爬取 LMS

def crawl(args: list[str], course: str | None = None, out_dir: str | None = None) -> list[str]:
    """调用 scripts/crawl_lms.py 爬 LMS 课件页，md 落到 out_dir。

    账号密码与 base 来自档案 lms（明文）；缺了就抛标准题面，问完落盘再跑。
    返回本次新爬下来的 md 文件列表——文件名就是页面标题，标题就是实验名。
    """
    script = os.path.join(SCRIPTS_DIR, "crawl_lms.py")
    v = resolve(course)
    lms = v["lms"]
    missing = [label for ok, label in (
        (lms["username"], "LMS 登录账号"), (lms["password"], "LMS 登录密码")) if not ok]
    if missing:
        key = v["course"]
        raise ProfileError(
            "要爬取 LMS 但档案缺字段，逐项问用户：\n  "
            + "\n  ".join(
                f"{i}. {label}  [字段 courses.{key}.lms.{'username' if '账号' in label else 'password'}]"
                for i, label in enumerate(missing, 1))
            + f"\n问到后落盘：python nbkit.py set courses.{key}.lms.username=...  "
              f"courses.{key}.lms.password=...")
    out = out_dir or os.path.join(v["output_dir"], "courseware")
    out = os.path.abspath(os.path.expanduser(out))
    os.makedirs(out, exist_ok=True)
    env = dict(os.environ)
    env["LMS_USERNAME"] = lms["username"] or ""
    env["LMS_PASSWORD"] = lms["password"] or ""
    env["LMS_BASE"] = lms["base"] or DEFAULT_LMS_BASE
    before = set(os.listdir(out))
    print(f"crawl: {lms['base']}  ->  {out}")
    r = subprocess.run([sys.executable, script, *args], cwd=out, env=env,
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.stdout:
        print(r.stdout[-3000:])
    if r.returncode != 0:
        raise RuntimeError(f"爬取失败 rc={r.returncode}\n{(r.stderr or '')[-1500:]}")
    new = sorted(f for f in os.listdir(out) if f.endswith(".md") and f not in before)
    for f in new:
        print(f"crawled -> {os.path.join(out, f)}")
    return [os.path.join(out, f) for f in new]


# --------------------------------------------------------------------------- 打包分享

PACK_SKIP_DIRS = {"__pycache__", ".git", "output"}  # output/ 是个人交付成果，不进分享包
PACK_SKIP_FILES = {"profile.json", "data.txt"}  # 档案含凭据；根目录散落测试数据也不进包


def pack(out: str | None = None) -> str:
    """把技能目录打成纯净分享 zip：排除 profile.json（真实凭据）/ output/（个人成果）/ __pycache__ / *.pyc / *.zip。"""
    import zipfile
    root = SKILL_DIR
    name = os.path.basename(root) or "jupyter-lab-report"
    out = os.path.abspath(out or os.path.join(os.path.dirname(root), name + "-share.zip"))
    if out.startswith(os.path.abspath(root) + os.sep):
        raise ValueError("zip 别放进技能目录内，会把自己打进去；放外面或 --out 指定")
    n = 0
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d not in PACK_SKIP_DIRS]
            for fn in filenames:
                if fn in PACK_SKIP_FILES or fn.endswith((".pyc", ".zip")):
                    continue
                full = os.path.join(dirpath, fn)
                z.write(full, os.path.join(name, os.path.relpath(full, root)))
                n += 1
    print(f"pack -> {out}（{n} 个文件；已排除 profile.json / output/ / 缓存）")
    return out


# --------------------------------------------------------------------------- 命令行

def _kv_to_dict(pairs: list[str]) -> dict:
    updates: dict = {}
    for kv in pairs:
        dotted, _, val = kv.partition("=")
        cur = updates
        keys = dotted.split(".")
        for k in keys[:-1]:
            cur = cur.setdefault(k, {})
        cur[keys[-1]] = val
    return updates


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="nbkit", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("path", help="打印档案路径")
    sub.add_parser("profile", help="打印档案内容")
    sub.add_parser("doctor", help="体检：依赖/中文字体/浏览器/档案")

    p = sub.add_parser("init", help="一次性写入署名与某个课程/项目条目")
    p.add_argument("--student-id")
    p.add_argument("--student-name")
    p.add_argument("--pattern", help="文件名模板，默认 {id}-{name}-{exp}")
    p.add_argument("--course", help="课程名字（同时用作档案条目 key）")
    p.add_argument("--label", help="课程名字（封面课程名称、条目显示名；缺省等同 --course）")
    p.add_argument("--lms-base", help="LMS 地址，默认 http://10.30.0.135")
    p.add_argument("--lms-user", help="LMS 登录账号（明文写入档案）")
    p.add_argument("--lms-pass", help="LMS 登录密码（明文写入档案）")
    p.add_argument("--output-dir")
    p.add_argument("--python", dest="py")
    p.add_argument("--browser")
    p.add_argument("--note", help="备注（可空，本次/本条目附注）")
    p.add_argument("--watermark-mode", choices=["ask", "always", "never"],
                   help="PDF 水印：每次询问 ask / 一直添加 always / 一直不添加 never（初始化问一次落盘）")
    p.add_argument("--watermark-text", help="自定义水印文字，留空默认\"学号 姓名\"")
    p.add_argument("--set-default", action="store_true", help="把该条目设为 default_course")

    p = sub.add_parser("set", help="set 字段=值，深合并落盘")
    p.add_argument("pairs", nargs="+")

    p = sub.add_parser("ask", help="打印缺失字段的标准题面")
    p.add_argument("course", nargs="?")

    p = sub.add_parser("check", help="preflight：摊开并校验本次要用的路径")
    p.add_argument("course", nargs="?")

    p = sub.add_parser("build", help="cells.json -> ipynb")
    p.add_argument("cells_json")
    p.add_argument("out")
    p.add_argument("--course")
    p.add_argument("--kernel")

    p = sub.add_parser("run", help="就地执行 notebook")
    p.add_argument("notebook")
    p.add_argument("--course")
    p.add_argument("--python", dest="py")
    p.add_argument("--kernel")
    p.add_argument("--timeout", type=int, default=600)

    p = sub.add_parser("audit", help="打印单元格输出摘要，报错/空跑即失败")
    p.add_argument("notebook")
    p.add_argument("--wide", type=int, default=200)
    p.add_argument("--lenient", action="store_true", help="空输出只警告不报错")

    p = sub.add_parser("trim", help="截断过长输出，避免 PDF 分页爆炸（audit 之后跑）")
    p.add_argument("notebook")

    p = sub.add_parser("deliver", help="按档案模板重命名并搬进输出目录")
    p.add_argument("notebook")
    p.add_argument("exp_name")
    p.add_argument("--course")
    p.add_argument("--dest")
    p.add_argument("--force", action="store_true")

    p = sub.add_parser("pdf", help="ipynb -> A4 PDF")
    p.add_argument("notebook")
    p.add_argument("--course")
    p.add_argument("--browser")
    p.add_argument("--keep-html", action="store_true")
    p.add_argument("--watermark", nargs="?", const="", default=None,
                   help="本次加水印，覆盖档案（可跟自定义文字；裸旗标用默认\"学号 姓名\"）")
    p.add_argument("--no-watermark", action="store_true", help="本次不加水印，覆盖档案")

    p = sub.add_parser("fonts", help="列出可用中文字体")
    p.add_argument("--cell", action="store_true", help="直接输出可粘贴的设置代码")
    p.add_argument("--family")

    p = sub.add_parser("clean", help="删除临时件")
    p.add_argument("paths", nargs="+")

    p = sub.add_parser("cover", help="assets/表头.docx -> A4 封面 HTML（作为 notebook 首个 md 单元格）")
    p.add_argument("exp_name", help="实验名称（封面要填）")
    p.add_argument("--course")
    p.add_argument("--date", help="完成时间，默认今天（YYYY-MM-DD 或 含'年'的原样用）")
    p.add_argument("--out", help="写到文件；不给就打印到 stdout")
    p.add_argument("--json", action="store_true", help="输出 cells.json 可直接用的单元格对象")

    p = sub.add_parser("crawl", help="爬 LMS 课件页成 md（账号密码与 base 来自档案）")
    p.add_argument("target", help="单个 assignment URL，或 '--batch' 走批量")
    p.add_argument("nums", nargs="*", help="--batch 时的 4 个整数：start_assign end_assign start_module end_module")
    p.add_argument("--course")
    p.add_argument("--out", help="md 落哪个目录（默认 输出目录/courseware）")

    p = sub.add_parser("pack", help="打成纯净分享 zip（排除 profile.json / 缓存），发给别人用")
    p.add_argument("--out", help="zip 输出路径，默认技能目录旁 jupyter-lab-report-share.zip")

    a = ap.parse_args(argv)
    try:
        if a.cmd == "path":
            print(profile_path())
        elif a.cmd == "profile":
            print(f"# {profile_path()}")
            print(json.dumps(load_profile(), ensure_ascii=False, indent=2))
        elif a.cmd == "doctor":
            doctor()
        elif a.cmd == "ask":
            print(ask_text(a.course))
        elif a.cmd == "check":
            preflight(a.course)
        elif a.cmd == "set":
            save_profile(_kv_to_dict(a.pairs))
        elif a.cmd == "init":
            updates: dict = {}
            if a.student_id:
                updates.setdefault("student", {})["id"] = a.student_id
            if a.student_name:
                updates.setdefault("student", {})["name"] = a.student_name
            if a.pattern:
                updates["deliver_pattern"] = a.pattern
            if a.browser:
                updates.setdefault("tools", {}).setdefault("print_pdf", {})["path"] = a.browser
            if a.watermark_mode or a.watermark_text is not None:
                wm: dict = {}
                if a.watermark_mode:
                    wm["mode"] = a.watermark_mode
                if a.watermark_text is not None:
                    wm["text"] = a.watermark_text
                updates.setdefault("tools", {}).setdefault("print_pdf", {})["watermark"] = wm
            if a.course:
                entry: dict = {}
                # key 与课程名字同一值：--course 就是课程名字；--label 仅在两者确实不同时用
                entry["label"] = a.label or a.course
                if a.lms_base or a.lms_user or a.lms_pass:
                    entry["lms"] = {k: v for k, v in (
                        ("base", a.lms_base), ("username", a.lms_user), ("password", a.lms_pass)) if v}
                if a.output_dir:
                    entry["output_dir"] = os.path.abspath(os.path.expanduser(a.output_dir))
                if a.py:
                    entry["python"] = os.path.abspath(os.path.expanduser(a.py))
                if a.note:
                    entry["note"] = a.note
                updates["courses"] = {a.course: entry}
                if a.set_default:
                    updates["default_course"] = a.course
            if not updates:
                print("没给任何参数，什么都没写。看 nbkit.py init -h")
            save_profile(updates)
        elif a.cmd == "build":
            with io.open(a.cells_json, encoding="utf-8") as f:
                data = json.load(f)
            build(data["cells"] if isinstance(data, dict) else data, a.out, course=a.course, kernel=a.kernel)
        elif a.cmd == "run":
            execute(a.notebook, timeout=a.timeout, python=a.py, course=a.course, kernel=a.kernel)
        elif a.cmd == "audit":
            audit(a.notebook, wide=a.wide, strict=not a.lenient)
        elif a.cmd == "trim":
            trim_outputs(a.notebook)
        elif a.cmd == "deliver":
            deliver(a.notebook, a.exp_name, course=a.course, dest_dir=a.dest, force=a.force)
        elif a.cmd == "pdf":
            to_pdf(a.notebook, course=a.course, browser=a.browser, keep_html=a.keep_html,
                   watermark=a.watermark, no_watermark=a.no_watermark)
        elif a.cmd == "fonts":
            if a.cell:
                print(font_cell(a.family))
            else:
                print("\n".join(cjk_fonts()) or "没找到中文字体")
        elif a.cmd == "clean":
            cleanup(*a.paths)
        elif a.cmd == "cover":
            html = render_cover(a.exp_name, course=a.course, date=a.date)
            if a.json:
                print(json.dumps({"type": "md", "source": html}, ensure_ascii=False))
            elif a.out:
                with io.open(a.out, "w", encoding="utf-8") as f:
                    f.write(html)
                print(f"cover -> {a.out}")
            else:
                print(html)
        elif a.cmd == "crawl":
            if a.target == "--batch":
                if len(a.nums) != 4 or not all(n.isdigit() for n in a.nums):
                    print("批量模式要 4 个整数：--batch start_assign end_assign start_module end_module")
                    return 2
                args = ["--batch"] + a.nums
            else:
                args = [a.target] + a.nums
            crawl(args, course=a.course, out_dir=a.out)
        elif a.cmd == "pack":
            pack(a.out)
    except ProfileError as e:
        print(e, file=sys.stderr)
        return 1
    except (RuntimeError, AssertionError) as e:
        print(f"失败：{e}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
