# -*- coding: utf-8 -*-
"""
과거 관측으로 판정식 역검증
- 입력: IEM에서 받은 RKPK METAR CSV (여러 개 가능)
- 관측을 단기예보와 같은 시간별 형식(TMP·REH·PTY·PCP·WSD·SKY)으로 바꿔 icing_rules.judge()에 넣음
사용: python backtest.py RKPK.csv [RKPK2.csv ...]
"""
import csv, sys
from datetime import datetime, timedelta, date
from collections import defaultdict
from icing_rules import judge

# 기록으로 확인된 결빙 대응일 (남부공항서비스 월간 업무 실적)
EVENTS = {
    "2022-12-21": "관리지역 제설제 살포",
    "2024-01-10": "결빙지역 제설제 살포",
    "2025-01-06": "관리지역 제설제 살포",
    "2025-02-07": "보도블록 제설제 살포",
    "2025-02-12": "이동·관리지역 제수·제빙",
    "2025-03-18": "제설 비상대기·제빙(기록일 3/17)",
}
# 실적 기록을 확보한 기간 (이 기간의 무기록일만 '살포 없음'으로 간주)
LABELED = [("2022-01-01", "2022-02-28"), ("2022-11-01", "2023-03-31"),
           ("2024-01-01", "2024-03-31"), ("2024-12-01", "2025-03-31"),
           ("2025-11-01", "2026-03-31")]
COVER = {"CLR": 0, "SKC": 0, "NSC": 0, "NCD": 0, "FEW": 2, "SCT": 4, "BKN": 7, "OVC": 8, "VV": 8}


def num(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def load(paths):
    obs = {}
    for p in paths:
        with open(p, encoding="utf-8-sig") as f:
            for row in csv.DictReader(f):
                t = datetime.strptime(row["valid"], "%Y-%m-%d %H:%M") + timedelta(hours=9)
                obs[t] = row
    hourly = defaultdict(list)
    for t, row in obs.items():
        hourly[t.replace(minute=0)].append((t, row))
    out = []
    for hr, rows in sorted(hourly.items()):
        rows.sort()
        main = rows[0][1]  # 정시 관측
        tf, rh = num(main["tmpf"]), num(main["relh"])
        if tf is None:
            continue
        wx = " ".join(r["wxcodes"] for _, r in rows if r["wxcodes"] not in ("M", ""))
        rain = any(k in wx for k in ("RA", "DZ"))
        snow = any(k in wx for k in ("SN", "PL", "GR", "GS"))
        pty = 2 if (rain and snow) else 3 if snow else 1 if rain else 0
        cov = max([COVER.get(main.get(f"skyc{i}", "M"), 0) for i in (1, 2, 3)] + [0])
        if "CAVOK" in main.get("metar", ""):
            cov = 0
        sky = 1 if cov <= 2 else 3 if cov <= 7 else 4
        kt = num(main["sknt"])
        if pty:  # 강수가 관측된 시간은 강수 관측 시점의 기온·습도를 대표값으로
            pr = [r for _, r in rows if r["wxcodes"] not in ("M", "") and num(r["tmpf"]) is not None]
            if pr:
                rep = min(pr, key=lambda r: num(r["tmpf"]))
                tf, rh = num(rep["tmpf"]), num(rep["relh"])
        out.append({"dt": hr, "T": round((tf - 32) * 5 / 9, 1), "RH": rh, "pty": pty,
                    "pcp": 0.0, "wsd": None if kt is None else kt * 0.5144,
                    "sky": sky, "src": "METAR"})
    return out


def labeled(d):
    s = d.isoformat()
    return any(a <= s <= b for a, b in LABELED)


if __name__ == "__main__":
    hours = load(sys.argv[1:])
    first, last = hours[0]["dt"].date(), hours[-1]["dt"].date()
    d = first + timedelta(days=1)
    rows, hit, miss, fa, n = [], 0, 0, 0, 0
    while d <= last:
        if d.month in (11, 12, 1, 2, 3):
            r = judge(hours, d)
            ev = EVENTS.get(d.isoformat(), "")
            lab = labeled(d)
            if lab:
                n += 1
                if ev and r["level"] >= 2: hit += 1
                elif ev: miss += 1
                elif r["level"] == 3: fa += 1
            if r["level"] >= 2 or ev:
                rows.append((d, r["level_name"], "/".join(r["types"]) or "-",
                             "; ".join(r["downgrades"]) or "-", ev or ("(기록 없음)" if lab else "(기록 미확보 기간)")))
        d += timedelta(days=1)
    print(f"{'날짜':<11} {'단계':<3} {'유형':<10} 기록 / 하향 사유")
    for d, lv, ty, dn, ev in rows:
        print(f"{d}  {lv:<3} {ty:<10} {ev}" + ("" if dn == "-" else f"  [하향: {dn}]"))
    print(f"\n기록 확보 기간 {n}일: 결빙 대응 {hit+miss}건 중 주의 이상 {hit}건, 놓침 {miss}건, 무기록일 '위험' {fa}건")
