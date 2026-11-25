# -*- coding: utf-8 -*-
"""
김해공항 노면 결빙 예측 - 로컬 웹서버
실행: python app.py  → 브라우저가 http://localhost:5050 으로 열림
"""
import csv, os, threading, webbrowser
from datetime import datetime, timedelta, date
from flask import Flask, jsonify, request, send_from_directory
import kma
from icing_rules import judge, CONFIG

HERE = os.path.dirname(os.path.abspath(__file__))
app = Flask(__name__, static_folder=os.path.join(HERE, "static"))
OBS_CACHE, FC_CACHE = {}, {}


def default_target(now):
    """정오 이후에는 내일 아침, 그 전에는 오늘 아침을 판정"""
    return (now + timedelta(days=1)).date() if now.hour >= 12 else now.date()


def collect(target, now, cfg):
    fc, base, grid = None, None, None
    key = kma.latest_base(now)
    if key not in FC_CACHE:
        FC_CACHE.clear()
        FC_CACHE[key] = kma.fetch_forecast(now, cfg)
    fc, base, grid = FC_CACHE[key]
    d0 = datetime.combine(target, datetime.min.time())
    start = d0 - timedelta(hours=12)
    first_fc = fc[0]["dt"] if fc else now
    obs_end = min(first_fc, now.replace(minute=0, second=0, microsecond=0) - timedelta(hours=1))
    obs = kma.fetch_obs(start, obs_end, cfg, OBS_CACHE) if obs_end > start else []
    merged = {h["dt"]: h for h in fc}
    for h in obs:          # 이미 지난 시간은 실황으로 덮어씀
        merged[h["dt"]] = h
    return sorted(merged.values(), key=lambda h: h["dt"]), base, grid


def log(res, base):
    path = os.path.join(HERE, "판정기록.csv")
    new = not os.path.exists(path)
    with open(path, "a", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        if new:
            w.writerow(["판정시각", "예보발표", "대상일", "단계", "유형", "하향사유"])
        w.writerow([datetime.now().strftime("%Y-%m-%d %H:%M"), base.strftime("%Y-%m-%d %H:%M"), res["target"],
                    res["level_name"], "/".join(res["types"]), "; ".join(res["downgrades"])])


@app.route("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.route("/api/judge")
def api_judge():
    cfg = kma.load_cfg()
    now = datetime.now()
    try:
        t = request.args.get("target")
        target = date.fromisoformat(t) if t else default_target(now)
        if not (now.date() <= target <= now.date() + timedelta(days=2)):
            return jsonify(error="판정 대상일은 오늘부터 모레 아침까지만 고를 수 있습니다."), 400
        hours, base, grid = collect(target, now, cfg)
        res = judge(hours, target)
        res.update(base=base.strftime("%m/%d %H시 발표"), grid=f"{grid[0]},{grid[1]}",
                   now=now.strftime("%Y-%m-%d %H:%M"),
                   default_target=default_target(now).isoformat(),
                   criteria={k: v for k, v in CONFIG.items() if k not in ("lat", "lon")})
        if request.args.get("log", "1") == "1":
            log(res, base)
        return jsonify(res)
    except Exception as e:
        return jsonify(error=str(e)), 500


if __name__ == "__main__":
    cfg = kma.load_cfg()
    if "여기에" in cfg["service_key"]:
        print("config.json 의 service_key 에 공공데이터포털 인증키를 먼저 넣어주세요.")
    port = cfg.get("port", 5050)
    threading.Timer(1.2, lambda: webbrowser.open(f"http://localhost:{port}")).start()
    print(f"결빙 예측 서버 실행 중: http://localhost:{port}  (종료: Ctrl+C)")
    app.run(host="127.0.0.1", port=port, debug=False)
