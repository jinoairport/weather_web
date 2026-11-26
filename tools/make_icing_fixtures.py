# -*- coding: utf-8 -*-
"""
실제 METAR 과거 기록(backtest.py의 load())으로 12개 날짜의 판정 입력·기대값을
tests/icing_fixtures.json으로 저장한다 — js/icing.js 포팅 검증용.

사용: python tools/make_icing_fixtures.py
"""
import sys, os, json
from datetime import datetime, timedelta, date

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "icing-ref"))
from backtest import load          # noqa: E402
from icing_rules import judge      # noqa: E402

CSV_PATHS = [
    r"C:\data\icing\RKPK.csv",
    r"C:\data\icing\RKPK (1).csv",
]

TARGETS = [
    "2022-12-21", "2024-01-09", "2024-01-10", "2024-03-13",
    "2025-01-06", "2025-02-07", "2025-02-12", "2025-03-18",
    "2025-01-28", "2025-02-13", "2025-03-17", "2026-02-07",
    "2023-03-13", "2024-03-01", "2025-02-02", "2025-12-14", "2026-02-11",
]


def window(hours, target):
    """대상일 전날 12시 ~ 대상일 24시(배타)의 시간별 자료만 추려냄 —
       judge()가 실제로 참조하는 범위(d0-12h ~ d0+24h)와 정확히 같다."""
    d0 = datetime.combine(target, datetime.min.time())
    start, end = d0 - timedelta(hours=12), d0 + timedelta(hours=24)
    return [h for h in hours if start <= h["dt"] < end]


def main():
    hours = load(CSV_PATHS)
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

    out_dir = os.path.join(os.path.dirname(HERE), "tests")
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "icing_fixtures.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(fixtures, f, ensure_ascii=False, indent=1)
    print(f"\n저장 완료: {out_path}")


if __name__ == "__main__":
    main()
