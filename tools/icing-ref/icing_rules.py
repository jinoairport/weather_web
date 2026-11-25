# -*- coding: utf-8 -*-
"""
김해공항 노면 결빙 판정 엔진
- 입력: 시간별 기상값 목록 (예보 또는 관측을 같은 형식으로 변환한 것)
- 출력: 대상일 아침의 결빙 위험 단계와 판정 근거

판정식은 '22.1~'26.3 중 살포·제빙 기록이 있는 기간(573일, 결빙 대응 6건)을
RKPK METAR 관측으로 역검증해 정한 잠정 기준이다. 기준값은 CONFIG에서 조정한다.
"""
import math
from datetime import datetime, timedelta, date

# ---------------------------------------------------------------- 기준값
CONFIG = {
    # 결빙형(전날 오후·저녁 비 → 새벽 결빙)
    "A_rain_window_start": 12,     # 전날 몇 시부터의 비를 보는가
    "A_min_rain_hours": 2,         # 전날 12~24시 강수 시간 수 (흔적 1회 제외)
    "A_last_rain_hour": 18,        # 마지막 강수 시각이 이 시각 이후여야 노면이 젖은 채 밤을 맞음
    "A_freeze_temp": 0.0,          # 새벽(00~08시) 기온이 이 값 이하인 시간이 있어야 함
    "A_max_dep": 2.5,              # 그 시간대 기온-이슬점 차 최솟값 (포화에 가까울수록 젖은 노면 유지)
    # 강수형(영하 근처에서 비·눈)
    "DS_night_min_temp": 0.0,      # 전날 18시~당일 10시 최저기온 (노면이 식어 있었는지)
    "DS_precip_temp": 2.0,         # 이 기온 이하에서 내린 강수만 셈
    "DS_min_precip_hours": 2,      # 위 강수가 있었던 시간 수 (1시간짜리 날림 제외)
    "DS_max_dep": 3.5,             # 강수 중 기온-이슬점 차 최솟값 (건조하면 증발·승화)
    # 경보 하향 인자
    "early_sunrise": "07:00",      # 일출이 이보다 이르고
    "recover_temp_09": 3.0,        # 09시 기온이 이 값 이상이고 07~09시 맑으면 빠른 회복으로 봄
    "strong_wind_ms": 6.0,         # 결빙 시간대 평균풍속이 이 이상이면 노면 건조 빠름
    # 관심 단계(근접 조건)
    "watch_temp": 2.0,
    # 위치(김해공항)
    "lat": 35.1795, "lon": 128.9382,
}

LEVELS = {
    3: ("위험", "제설제 사전 살포 권고"),
    2: ("주의", "새벽 순찰로 결빙 여부 확인, 살포 대비"),
    1: ("관심", "결빙 조건에 근접, 예보 변화 확인"),
    0: ("정상", "결빙 조건 없음"),
}


# ---------------------------------------------------------------- 보조 계산
def dewpoint(t, rh):
    """Magnus 식(a=17.62, b=243.12)으로 이슬점 계산"""
    if t is None or rh is None or rh <= 0:
        return None
    a, b = 17.62, 243.12
    g = math.log(rh / 100.0) + a * t / (b + t)
    return b * g / (a - g)


def sunrise(d, lat=CONFIG["lat"], lon=CONFIG["lon"]):
    """NOAA 근사식에 의한 일출 시각(한국시간)"""
    n = d.timetuple().tm_yday
    g = 2 * math.pi / 365 * (n - 1)
    eq = 229.18 * (0.000075 + 0.001868 * math.cos(g) - 0.032077 * math.sin(g)
                   - 0.014615 * math.cos(2 * g) - 0.040849 * math.sin(2 * g))
    dec = (0.006918 - 0.399912 * math.cos(g) + 0.070257 * math.sin(g)
           - 0.006758 * math.cos(2 * g) + 0.000907 * math.sin(2 * g)
           - 0.002697 * math.cos(3 * g) + 0.00148 * math.sin(3 * g))
    ha = math.degrees(math.acos(math.cos(math.radians(90.833)) /
                                (math.cos(math.radians(lat)) * math.cos(dec))
                                - math.tan(math.radians(lat)) * math.tan(dec)))
    m = 720 - 4 * (lon + ha) - eq + 540
    return datetime.combine(d, datetime.min.time()) + timedelta(minutes=m)


def is_precip(h):
    return (h.get("pty") or 0) > 0 or (h.get("pcp") or 0) > 0


PTY_NAME = {0: "", 1: "비", 2: "비/눈", 3: "눈", 4: "소나기"}
SKY_NAME = {1: "맑음", 3: "구름많음", 4: "흐림"}


# ---------------------------------------------------------------- 판정
def judge(hours, target):
    """
    hours : [{"dt": datetime, "T": 기온, "RH": 습도, "pty": 강수형태코드,
              "pcp": 1시간강수량(mm), "wsd": 풍속(m/s), "sky": 하늘상태코드}, ...]
    target: 결빙을 판정할 아침의 날짜(date)
    """
    c = CONFIG
    d0 = datetime.combine(target, datetime.min.time())
    H = timedelta(hours=1)
    by = {h["dt"]: dict(h) for h in hours if h.get("T") is not None}
    for h in by.values():
        h["Td"] = dewpoint(h["T"], h.get("RH"))
        h["dep"] = (h["T"] - h["Td"]) if h["Td"] is not None else None

    def rng(a, b):
        return [by[t] for t in sorted(by) if a <= t < b]

    win = rng(d0 - 12 * H, d0 + 12 * H)
    eve = rng(d0 - (24 - c["A_rain_window_start"]) * H, d0 + 6 * H)
    morning = rng(d0, d0 + 9 * H)          # 00~08시
    night = rng(d0 - 6 * H, d0 + 10 * H)    # 전날 18시~당일 09시
    day = rng(d0, d0 + 24 * H)
    missing = 24 - len(win)

    checks = []

    # ---- 결빙형
    eve_rain = [h for h in eve if is_precip(h) and h["dt"] < d0]
    rain_after = [h for h in eve if is_precip(h)]
    last = rain_after[-1]["dt"] if rain_after else None
    last_hour_ok = last is not None and (last >= d0 - (24 - c["A_last_rain_hour"]) * H)
    freeze = [h for h in morning if h["T"] <= c["A_freeze_temp"] and (last is None or h["dt"] > last)]
    deps = [h["dep"] for h in freeze if h["dep"] is not None]
    dep_min = min(deps) if deps else None
    A = (len(eve_rain) >= c["A_min_rain_hours"] and last_hour_ok and freeze
         and dep_min is not None and dep_min <= c["A_max_dep"])
    checks.append({
        "type": "결빙형", "met": bool(A),
        "items": [
            ("전날 오후·저녁 비", len(eve_rain) >= c["A_min_rain_hours"],
             f"{len(eve_rain)}시간 (기준 {c['A_min_rain_hours']}시간 이상)"),
            ("비가 늦게 그침", last_hour_ok,
             f"마지막 강수 {last.strftime('%m/%d %H시') if last else '없음'} (기준 {c['A_last_rain_hour']}시 이후)"),
            ("새벽 영하", bool(freeze),
             f"00~08시 최저 {min(h['T'] for h in morning):.0f}℃" if morning else "자료 없음"),
            ("결빙 시점 습함", dep_min is not None and dep_min <= c["A_max_dep"],
             f"기온-이슬점 차 {dep_min:.1f}℃ (기준 {c['A_max_dep']}℃ 이하)" if dep_min is not None else "해당 시간 없음"),
        ]})

    # ---- 강수형
    tmin_night = min((h["T"] for h in night), default=None)
    cold_pr = [h for h in day if is_precip(h) and h["T"] <= c["DS_precip_temp"]]
    pr_deps = [h["dep"] for h in cold_pr if h["dep"] is not None]
    pr_dep = min(pr_deps) if pr_deps else None
    DS = (tmin_night is not None and tmin_night <= c["DS_night_min_temp"]
          and len(cold_pr) >= c["DS_min_precip_hours"]
          and pr_dep is not None and pr_dep <= c["DS_max_dep"])
    kinds = sorted({PTY_NAME.get(h.get("pty") or 0, "") for h in cold_pr} - {""})
    checks.append({
        "type": "강수형", "met": bool(DS),
        "items": [
            ("밤사이 노면 냉각", tmin_night is not None and tmin_night <= c["DS_night_min_temp"],
             f"전날 18시~09시 최저 {tmin_night:.0f}℃ (기준 {c['DS_night_min_temp']:.0f}℃ 이하)" if tmin_night is not None else "자료 없음"),
            ("영하 근처 강수 지속", len(cold_pr) >= c["DS_min_precip_hours"],
             f"{c['DS_precip_temp']:.0f}℃ 이하 강수 {len(cold_pr)}시간{' (' + ', '.join(kinds) + ')' if kinds else ''} (기준 {c['DS_min_precip_hours']}시간 이상)"),
            ("강수 중 습함", pr_dep is not None and pr_dep <= c["DS_max_dep"],
             f"기온-이슬점 차 {pr_dep:.1f}℃ (기준 {c['DS_max_dep']}℃ 이하)" if pr_dep is not None else "해당 강수 없음"),
        ]})

    # ---- 단계 결정
    level = 3 if (A or DS) else 0
    downs = []
    sr = sunrise(target)
    if level == 3:
        t09 = by.get(d0 + 9 * H)
        skies = [by[d0 + k * H].get("sky") for k in (7, 8, 9) if d0 + k * H in by]
        early = sr.strftime("%H:%M") <= c["early_sunrise"]
        clear = skies and all(s == 1 for s in skies)
        warm = t09 is not None and t09["T"] >= c["recover_temp_09"]
        if early and clear and warm and not DS:
            level = 2
            downs.append(f"일출 {sr:%H:%M}로 이르고 07~09시 맑음, 09시 {t09['T']:.0f}℃ → 노면 조기 회복 예상")
        winds = [h["wsd"] for h in freeze if h.get("wsd") is not None]
        if A and not DS and winds and sum(winds) / len(winds) >= c["strong_wind_ms"]:
            level = min(level, 2)
            downs.append(f"결빙 시간대 평균풍속 {sum(winds)/len(winds):.1f}m/s → 노면 건조 빠름")
    else:
        near = (tmin_night is not None and tmin_night <= c["watch_temp"]
                and any(is_precip(h) for h in eve + day[:10]))
        if near:
            level = 1

    first_freeze = freeze[0]["dt"] if (A and freeze) else (cold_pr[0]["dt"] if DS else None)
    name, action = LEVELS[level]
    return {
        "target": target.isoformat(),
        "level": level, "level_name": name, "action": action,
        "types": [ck["type"] for ck in checks if ck["met"]],
        "checks": checks, "downgrades": downs,
        "first_risk_time": first_freeze.strftime("%m/%d %H시") if first_freeze else None,
        "sunrise": sr.strftime("%H:%M"),
        "missing_hours": max(missing, 0),
        "hours": [{
            "dt": h["dt"].strftime("%Y-%m-%d %H:%M"), "T": h["T"], "RH": h.get("RH"),
            "Td": None if h["Td"] is None else round(h["Td"], 1),
            "pty": h.get("pty") or 0, "pty_name": PTY_NAME.get(h.get("pty") or 0, ""),
            "pcp": h.get("pcp") or 0, "wsd": h.get("wsd"),
            "sky": h.get("sky"), "sky_name": SKY_NAME.get(h.get("sky"), ""),
            "src": h.get("src", "")} for h in win],
    }
