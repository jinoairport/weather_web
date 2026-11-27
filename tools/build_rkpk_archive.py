# -*- coding: utf-8 -*-
"""
RKPK METAR CSV(IEM ASOS 내보내기)를 합쳐(타임스탬프 중복 제거) tools/data/rkpk_metar.json.gz로 저장한다.
이 PC는 재부팅 때 C:\\data\\icing\\*.csv가 사라지므로, 검증용 관측자료를 저장소에 둔다.

backtest.py의 load()가 실제로 쓰는 컬럼만 남긴다: valid, tmpf, relh, wxcodes, skyc1~3, sknt, p01i, metar.
같은 valid(분 단위 타임스탬프)가 여러 파일에 중복되면 나중 파일이 덮어쓴다(backtest.load()와 동일한 규칙).

사용: python tools/build_rkpk_archive.py [CSV경로 ...]
      (인자를 생략하면 C:\\data\\icing\\RKPK.csv, RKPK (1).csv를 기본으로 읽는다)
"""
import csv
import gzip
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_PATH = os.path.join(HERE, "data", "rkpk_metar.json.gz")
KEEP_FIELDS = ["valid", "tmpf", "relh", "wxcodes", "skyc1", "skyc2", "skyc3", "sknt", "p01i", "metar"]

DEFAULT_CSV_PATHS = [
    r"C:\data\icing\RKPK.csv",
    r"C:\data\icing\RKPK (1).csv",
]


def main():
    paths = sys.argv[1:] or DEFAULT_CSV_PATHS

    total_rows = 0
    by_valid = {}
    for p in paths:
        with open(p, encoding="utf-8-sig") as f:
            for row in csv.DictReader(f):
                total_rows += 1
                by_valid[row["valid"]] = {k: row.get(k, "M") for k in KEEP_FIELDS}

    distinct = len(by_valid)
    dup = total_rows - distinct
    print(f"입력 파일 {len(paths)}개, 원본 합계 {total_rows}행, 중복 {dup}행, 중복 제외 {distinct}행")

    rows = [by_valid[k] for k in sorted(by_valid)]

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with gzip.open(OUT_PATH, "wt", encoding="utf-8") as f:
        json.dump(rows, f, ensure_ascii=False)

    if len(rows) != distinct:
        print(f"!! 오류: 저장된 행 수({len(rows)})가 중복 제외 행 수({distinct})와 다릅니다.")
        sys.exit(1)

    print(f"저장 완료: {OUT_PATH} ({len(rows)}행, "
          f"{rows[0]['valid']} ~ {rows[-1]['valid']})")


if __name__ == "__main__":
    main()
