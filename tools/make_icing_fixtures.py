# -*- coding: utf-8 -*-
"""
실제 METAR 과거 기록(backtest.py의 load())으로 12개 날짜의 판정 입력·기대값을
tests/icing_fixtures.json으로 저장한다 — js/icing.js 포팅 검증용.

사용: python tools/make_icing_fixtures.py            (기본: tools/data/rkpk_metar.json.gz)
      python tools/make_icing_fixtures.py a.csv b.csv (CSV를 직접 지정해도 됨)
"""
import sys, os, json
from datetime import datetime, timedelta, date

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "icing-ref"))
from backtest import load      # noqa: E402
from icing_rules import judge  # noqa: E402

CSV_PATHS = [os.path.join(HERE, "data", "rkpk_metar.json.gz")]

TARGETS = [
    "2022-12-21", "2024-01-09", "2024-01-10", "2024-03-13",
    "2025-01-06", "2025-02-07", "2025-02-12", "2025-03-18",
    "2025-01-28", "2025-02-13", "2025-03-17", "2026-02-07",
    "2023-03-13", "2024-03-01", "2025-02-02", "2025-12-14", "2026-02-11",
    "2025-12-16", "2020-12-28",  # 서리, 노면영하(기온 1℃ 완화) 대표일
]

# 물고임 잔류·저녁 결빙은 과거 실측에서 대표일을 찾지 못했다(물고임은 RKPK METAR가
# 강수량(p01i)을 아예 보고하지 않아 검증 불가 — 아래 참고). 규칙 자체의 파이썬·JS
# 일치만 확인하기 위해 손으로 만든 가상 시간별 자료를 쓴다(대상일을 2030년대로 표시해
# 실제 관측일과 혼동되지 않게 한다).
def hr(dt, T, RH, pty=0, pcp=0.0, wsd=2.0, sky=3):
    return {"dt": dt, "T": T, "RH": RH, "pty": pty, "pcp": pcp, "wsd": wsd, "sky": sky, "src": "SYN"}


def synthetic_fixtures():
    out = {}

    # 물고임 잔류: 대상일 36시간 전(그제 오후) 많은 비 12mm, 다른 조건은 전부 배제
    d = "2030-01-15"
    hours = (
        [hr(datetime(2030, 1, 13, h), 5, 90, pty=1, pcp=2.0, wsd=3, sky=4) for h in (13, 14, 15, 16, 17, 18)]
        + [hr(datetime(2030, 1, 15, h), -1, 70, pty=0, pcp=0, wsd=3, sky=3) for h in range(0, 9)]
    )
    out[d] = (d, hours)

    # 저녁 결빙: 대상일 전날 18~20시 비, 20~24시 영하(00~08시 자료는 비워 다른 규칙과 분리)
    d = "2030-02-20"
    hours = (
        [hr(datetime(2030, 2, 19, h), 3, 85, pty=1, pcp=1.0, wsd=2, sky=4) for h in (18, 19)]
        + [hr(datetime(2030, 2, 19, h), -1, 90, pty=0, pcp=0, wsd=1.5, sky=4) for h in (20, 21, 22, 23)]
    )
    out[d] = (d, hours)

    return out


def window(hours, target):
    """대상일 전전전날 0시 ~ 대상일 24시(배타)의 시간별 자료만 추려냄 —
       judge()가 실제로 참조하는 가장 넓은 범위(재결빙 d0-48h ~ 결빙형/강수형 d0+24h)와 정확히 같다."""
    d0 = datetime.combine(target, datetime.min.time())
    start, end = d0 - timedelta(hours=48), d0 + timedelta(hours=24)
    return [h for h in hours if start <= h["dt"] < end]


def main():
    hours = load(sys.argv[1:] or CSV_PATHS)
    hours.sort(key=lambda h: h["dt"])
    print(f"관측 시간별 자료 {len(hours)}건 로드 "
          f"({hours[0]['dt']} ~ {hours[-1]['dt']})")

    fixtures = {}
    for ds in TARGETS:
        target = date.fromisoformat(ds)
        win = window(hours, target)

        # 전체 이력(hours) 대 windowed 서브셋을 각각 넣어 judge() 결과가 같은지 먼저 자체 검증
        res_full = judge(hours, target)
        res_win = judge(win, target)
        mismatch = (res_full["level"], tuple(res_full["types"]), tuple(res_full["downgrades"])) != \
                   (res_win["level"], tuple(res_win["types"]), tuple(res_win["downgrades"]))
        if mismatch:
            print(f"  !! 경고: {ds} 전체이력 결과와 windowed 결과가 다릅니다 — "
                  f"full={res_full['level_name']} win={res_win['level_name']}")

        fixtures[ds] = {
            "target": ds,
            "hours": [dict(h, dt=h["dt"].isoformat()) for h in win],
            "expected": {
                "level": res_win["level"],
                "level_name": res_win["level_name"],
                "types": res_win["types"],
                "downgrades": res_win["downgrades"],
                "missing_hours": res_win["missing_hours"],
                "sunrise": res_win["sunrise"],
            },
        }
        print(f"  {ds}: 시간자료 {len(win)}건 -> {res_win['level_name']} "
              f"유형={res_win['types']} 하향={res_win['downgrades']}")

    for ds, (_, syn_hours) in synthetic_fixtures().items():
        target = date.fromisoformat(ds)
        res = judge(syn_hours, target)
        fixtures[ds] = {
            "target": ds,
            "hours": [dict(h, dt=h["dt"].isoformat()) for h in syn_hours],
            "expected": {
                "level": res["level"], "level_name": res["level_name"],
                "types": res["types"], "downgrades": res["downgrades"],
                "missing_hours": res["missing_hours"], "sunrise": res["sunrise"],
            },
        }
        print(f"  {ds}(가상): 시간자료 {len(syn_hours)}건 -> {res['level_name']} "
              f"유형={res['types']} 하향={res['downgrades']}")

    out_dir = os.path.join(os.path.dirname(HERE), "tests")
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "icing_fixtures.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(fixtures, f, ensure_ascii=False, indent=1)
    print(f"\n저장 완료: {out_path}")


if __name__ == "__main__":
    main()
