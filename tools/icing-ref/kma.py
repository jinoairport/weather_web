# -*- coding: utf-8 -*-
"""
기상청 단기예보·초단기실황 조회 (공공데이터포털 VilageFcstInfoService_2.0)
- getVilageFcst : 단기예보 (02·05·08·11·14·17·20·23시 발표, 1시간 간격)
- getUltraSrtNcst: 초단기실황 (매시 정시 자료) → 예보 발표 이전 시간(전날 오후 등)을 채움
"""
import math, json, os
from datetime import datetime, timedelta
import requests

BASE = "https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0"
CFG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")


def load_cfg():
    with open(CFG_PATH, encoding="utf-8") as f:
        return json.load(f)


def latlon_to_grid(lat, lon):
    """기상청 격자 변환 (Lambert Conformal Conic, 기상청 공개 변환식)"""
    RE, GRID, SLAT1, SLAT2, OLON, OLAT, XO, YO = 6371.00877, 5.0, 30.0, 60.0, 126.0, 38.0, 43, 136
    D = math.pi / 180.0
    re = RE / GRID
    s1, s2, olon, olat = SLAT1 * D, SLAT2 * D, OLON * D, OLAT * D
    sn = math.log(math.cos(s1) / math.cos(s2)) / math.log(math.tan(math.pi * 0.25 + s2 * 0.5) / math.tan(math.pi * 0.25 + s1 * 0.5))
    sf = math.tan(math.pi * 0.25 + s1 * 0.5) ** sn * math.cos(s1) / sn
    ro = re * sf / math.tan(math.pi * 0.25 + olat * 0.5) ** sn
    ra = re * sf / math.tan(math.pi * 0.25 + lat * D * 0.5) ** sn
    theta = lon * D - olon
    theta = (theta + math.pi) % (2 * math.pi) - math.pi
    theta *= sn
    return int(ra * math.sin(theta) + XO + 0.5), int(ro - ra * math.cos(theta) + YO + 0.5)


def _get(op, params, cfg):
    p = {"serviceKey": cfg["service_key"], "pageNo": 1, "numOfRows": 1000, "dataType": "JSON"}
    p.update(params)
    r = requests.get(f"{BASE}/{op}", params=p, timeout=15, verify=cfg.get("verify_ssl", True))
    r.raise_for_status()
    try:
        js = r.json()
    except ValueError:
        raise RuntimeError("기상청 응답이 JSON이 아닙니다. 인증키(서비스키)를 확인하세요: " + r.text[:200])
    hdr = js["response"]["header"]
    if hdr["resultCode"] != "00":
        raise RuntimeError(f"기상청 API 오류 {hdr['resultCode']}: {hdr['resultMsg']}")
    return js["response"]["body"]["items"]["item"]


def latest_base(now):
    """발표 후 10분이 지난 가장 최근 단기예보 발표시각"""
    for back in range(0, 30):
        t = now - timedelta(hours=back)
        if t.hour in (2, 5, 8, 11, 14, 17, 20, 23):
            base = t.replace(minute=0, second=0, microsecond=0)
            if now >= base + timedelta(minutes=10):
                return base
    raise RuntimeError("발표시각 계산 실패")


def _pcp(v):
    if v in (None, "", "강수없음", "적설없음"):
        return 0.0
    if "미만" in v:
        return 0.5
    try:
        return float(v.replace("mm", "").split("~")[0])
    except ValueError:
        return 1.0


def fetch_forecast(now, cfg):
    nx, ny = latlon_to_grid(cfg["lat"], cfg["lon"])
    base = latest_base(now)
    items = _get("getVilageFcst", {"base_date": base.strftime("%Y%m%d"), "base_time": base.strftime("%H%M"),
                                    "nx": nx, "ny": ny}, cfg)
    rows = {}
    for it in items:
        dt = datetime.strptime(it["fcstDate"] + it["fcstTime"], "%Y%m%d%H%M")
        rows.setdefault(dt, {"dt": dt, "src": f"예보 {base:%m/%d %H}시"})[it["category"]] = it["fcstValue"]
    out = []
    for dt, r in sorted(rows.items()):
        if "TMP" not in r:
            continue
        out.append({"dt": dt, "T": float(r["TMP"]), "RH": float(r.get("REH", "nan")),
                    "pty": int(r.get("PTY", 0)), "pcp": _pcp(r.get("PCP")),
                    "wsd": float(r["WSD"]) if r.get("WSD") not in (None, "") else None,
                    "sky": int(r["SKY"]) if r.get("SKY") else None, "src": r["src"]})
    return out, base, (nx, ny)


def fetch_obs(start, end, cfg, cache):
    """start~end(미포함) 정시별 초단기실황. cache: {datetime: row}"""
    nx, ny = latlon_to_grid(cfg["lat"], cfg["lon"])
    out = []
    t = start
    while t < end:
        if t not in cache:
            try:
                items = _get("getUltraSrtNcst", {"base_date": t.strftime("%Y%m%d"), "base_time": t.strftime("%H00"),
                                                  "nx": nx, "ny": ny}, cfg)
                v = {it["category"]: it["obsrValue"] for it in items}
                cache[t] = {"dt": t, "T": float(v["T1H"]), "RH": float(v["REH"]), "pty": int(float(v["PTY"])),
                            "pcp": float(v.get("RN1", 0) or 0), "wsd": float(v["WSD"]), "sky": None, "src": "실황"}
            except Exception:
                cache[t] = None
        if cache[t]:
            out.append(cache[t])
        t += timedelta(hours=1)
    return out
