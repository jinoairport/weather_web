# 이 폴더의 용도

GitHub 공식 문서(docs.github.com, "Events that trigger workflows" → `schedule` 항목):

> In a public repository, scheduled workflows are automatically disabled when no
> repository activity has occurred in 60 days.

이 저장소는 공개 저장소이고, `icing-notify.yml`(결빙 알림)은 겨울철에도 끊김 없이
매일 돌아야 한다. 하지만 사람이 코드를 안 건드리는 기간이 60일을 넘으면 저장소
자체의 "활동"이 없다고 판단되어 예약 워크플로가 자동으로 꺼질 수 있다(공식 문서에
"저장소 활동"의 정의가 정확히 적혀 있지는 않지만, 커밋/푸시는 확실히 활동으로
인정된다).

그래서 `keepalive.yml`이 매월 1회(60일보다 훨씬 짧은 주기) `last-run.txt`의
타임스탬프를 갱신하고 커밋·푸시한다 — 이 저장소에 "60일 이상 활동이 없는" 상태가
절대 생기지 않게 해서, `icing-notify.yml`을 포함한 모든 예약 워크플로가 계속
켜져 있도록 하는 용도다.

혹시 그래도 예약 워크플로가 비활성화된 걸 발견하면:
- GitHub 저장소 → Actions → 왼쪽에서 해당 워크플로 선택 → "Enable workflow" 클릭, 또는
- 워크플로 파일의 cron 줄을 한 글자라도 바꿔서 커밋하면(쓰기 권한자가) 자동으로 재활성화된다
  (GitHub 공식 문서에 명시된 동작).
