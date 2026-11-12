# 排错速查（只给 agent 看，最小信息量；解决新问题就追加一行）

格式：**报错/现象** ⇒ 根因 ⇒ 解法

- **ipynb 里 print 中文→\ufffd，spark show() 正常** ⇒ 内核 stdout=cp936 被按 utf-8 解码 ⇒ ensure_kernel 的 kernelspec env `PYTHONUTF8=1`/`PYTHONIOENCODING=utf-8` 已内置别删；外部 kernel 自行加同 env
- **createDataFrame(rdd) 抛 "Python worker exited unexpectedly (crashed)"/"Connection reset by peer"；count 过、first/take 崩** ⇒ Windows 上 schema 推断调 rdd.first()，take 语义提前关 socket、大分区还在写 ⇒ 显式传 StructType schema（与推断结果一致）。口诀：count 能过、first/take 崩 = 它
- **run 末尾 ConnectionResetError 但 rc=0** ⇒ kernel 关停时 Spark daemon 被强杀的噪音 ⇒ audit 0 error 就忽略
- **plt.show() 报 FigureCanvasAgg is non-interactive** ⇒ 无窗口 Agg 后端 show 无操作 ⇒ `use('Agg')`+`savefig`+`display(Image(...))`；display 才是 audit 认的 display_data
- **audit"疑似空跑"** ⇒ 结尾 import/赋值不算空，`.show()/.plot()/print/裸表达式` 必须有输出 ⇒ 补 `print(...)` 兜底或去掉 .show()，别改业务代码
- **控制台中文乱码** ⇒ 先 `repr()` 看是否含 `\ufffd` 再判定真坏还是显示问题 ⇒ 真坏才重跑
- **cover --json 没落盘** ⇒ 设计只 print 不写 ⇒ subprocess 捕获 stdout 取 JSON，或直接 `--out file.html`
- **Read PDF 报 pdftoppm is not installed** ⇒ 无 poppler ⇒ `pypdf` extract_text + `page.images` 核对
- **数据导致 worker 崩/行数不对** ⇒ 先纯 Python 体检：`\x00`、utf-8 解码、每行逗号数、最长行、首行表头 ⇒ 表头 filter 掉并在报告注明
- **docx/脚本 EPERM** ⇒ 复制带只读属性 ⇒ `attrib -R` 或 `chmod u+w`
- **PDF 代码行折行** ⇒ 模板 pre-wrap 超页宽 ⇒ 建 cell 时单行 ≤80 字符（括号续行），别靠打印补救
- **createDataFrame(rdd, 显式schema) 后列值整体错位（publish 列变成价格、rating 列变成出版社名）** ⇒ 传显式 schema 时 Row 按**位置**映射而非字段名 ⇒ schema 字段顺序必须与 Row(...) 关键字顺序一致（手册 Row 顺序 id,name,rating,price,publish,url，不是字母序）；不传 schema 的自动推断才按名字对齐
- **spark35 环境 pip install 报 SSLError/SSLZeroReturnError（aliyun 与 pypi.org 都失败）** ⇒ Py3.8 环境 TLS 握手被断 ⇒ 换 HTTP 源：`-i http://mirrors.aliyun.com/pypi/simple/ --trusted-host mirrors.aliyun.com`
- **dir() 输出在 PDF 占 3 页** ⇒ IPython 把长 list pretty 成多行 execute_result，旧 trim 只按行截 stream ⇒ 2026-11-11 已修 trim_outputs：execute_result/display_data 也按 >60 行截断
- **string 列 `rating>9` 在 Spark 3.5 只命中 11 条、2.4 课件命中上千条** ⇒ 3.5 把 string>int 隐式转 int（截断小数，9.x→9 不命中；非 ASCII 空白还使 cast 变 null），2.4 转 double ⇒ SQL 里显式 `cast(rating as double) > 9` 保持手册数值语义；order by 不 cast 则仍是字典序，与课件一致
- **内核/进程画图或 matmul 静默崩（faulthandler 0xc06d007f，栈停在 numpy 调用行）** ⇒ conda 版 numpy 依赖 env 的 libblas.dll，渠道混搭致导出函数缺失（delay-load procedure not found）；纯元素级运算正常、`@`/画图崩是它 ⇒ `pip install --force-reinstall --no-deps numpy==<同版本>` 换自带 OpenBLAS 的 pip wheel（2026-11-11 data-mining 环境实测）
- **nbconvert 执行报 ./data/xxx.csv FileNotFoundError** ⇒ ExecutePreprocessor 的 cwd=notebook 所在目录 ⇒ 先把 draft.ipynb 移进课程 output_dir 再 run，别在技能根目录跑
- **连续画图格后一张图继承前一张的刻度标签（hist 的 x 轴变成类型名）** ⇒ pandas .plot 复用当前 axes ⇒ 每个画图格 display 后加 `plt.close()`（2026-11-11 协同过滤报告实测）
