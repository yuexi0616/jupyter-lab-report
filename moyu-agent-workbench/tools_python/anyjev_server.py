#!/usr/bin/env python3
"""
AnyJev 本地决策服务（P0 · 设计文档 §8.3）。

把 nokia-applied-research/AnyJev 的类型化决策（choice/score/noul）包成
本地 HTTP 端点，供 Node 主控的 lib/decider.js 调用。

启动：
    python -m venv .venv && .venv/Scripts/activate   (Windows)
    pip install -r requirements.lock
    python anyjev_server.py --port 11436

端点：
    GET  /health  -> {ok, backend, model, level}
    POST /decide  -> {decision:{intent,danger,should_reply_now,best_action,confidence}, level}
        请求体: {state: str, questions: [...]}

策略全在调用方（Node）：低置信度转人工；本服务只返回概率与证据等级，
不替业务做放行判断。模型首次运行会下载（体积较大），需联网一次。
"""
import argparse
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL = "Qwen/Qwen3-8B"  # 与 config/decider.json 保持一致；8B 为能力余量，非引用作者 1.7B 的分数

_decider = None
_level = "unavailable"


def load_decider():
    """懒加载 AnyJev；未安装依赖时给出清晰错误，不伪装成功。"""
    global _decider, _level
    if _decider is not None:
        return _decider
    try:
        from anyjev import Decider, Question
        from anyjev.backends.hf import HFBackend
    except ImportError as e:
        raise RuntimeError(
            "AnyJev 未安装。请先运行: pip install -r requirements.lock（原始错误: %s）" % e
        )
    _decider = Decider(HFBackend(MODEL))

    # 两个有界问题：风险 yes/no（noul）+ 意图路由（choice）
    _questions = [
        Question.noul("Is this message high-risk (money, password, verification code, or scam)?", name="risk"),
        Question.choice(
            "Which intent fits?", ["安排见面", "情绪安抚", "日常闲聊", "交易/索要"], name="intent"
        ),
    ]
    _decider._questions = _questions  # 随实例携带，见 do_POST
    _level = "L0"  # 零标注去偏档位；L2 需校准外挂，另行启用
    return _decider


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/health"):
            self._send(200, {"ok": _decider is not None, "backend": "anyjev", "model": MODEL, "level": _level})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if not self.path.startswith("/decide"):
            self._send(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length > 1_000_000:
                self._send(413, {"error": "body too large"})
                return
            payload = json.loads(self.rfile.read(length) or b"{}")
            state = str(payload.get("state", ""))

            decider = load_decider()
            result = decider.decide({"message": state}, decider._questions)

            p_risk = float(result["risk"].p_true)          # 高危概率
            intent_res = result["intent"].distribution     # dict[str, float]
            intent = max(intent_res, key=intent_res.get) if intent_res else "未识别"

            # danger 映射到 1-9；best_action 由概率给出，最终放行仍由 Node 侧决定
            danger = max(1, min(9, 1 + round(p_risk * 8)))
            best = "ask_human" if p_risk >= 0.5 else "draft"
            decision = {
                "intent": intent,
                "danger": danger,
                "should_reply_now": p_risk < 0.5,
                "best_action": best,
                "confidence": round(1 - abs(p_risk - 0.5) * 2, 3),
            }
            self._send(200, {"decision": decision, "level": _level, "risk_p": p_risk})
        except RuntimeError as e:
            self._send(503, {"error": str(e)})
        except Exception as e:  # 不伪装成功：任何异常都显式失败，交给上层转人工
            self._send(500, {"error": "%s: %s" % (type(e).__name__, e)})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=11436)
    ap.add_argument("--host", default="127.0.0.1")
    args = ap.parse_args()
    print("AnyJev 决策服务 http://%s:%d （模型 %s，首次运行会下载）" % (args.host, args.port, MODEL))
    ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
