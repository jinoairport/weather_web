#!/usr/bin/env node
/* ===================================================
   노면 결빙 판정 → 카카오톡 "나에게 보내기" 알림 (GitHub Actions 전용)

   판정 로직은 js/icing.js(그리고 그 안에서 쓰는 js/api.js·js/data.js)를
   전혀 고치지 않고 그대로 실행한다. vm.runInThisContext로 사이트와 동일한
   전역(kmaFetch, fetchWeatherData, CONFIG, localStorage 등)을 구성한 뒤
   require('../js/icing.js')로 불러온다 — 사이트(icing.html)는 이 파일의
   존재를 모르므로 동작이 전혀 바뀌지 않는다.

   이 저장소는 공개 저장소라 Actions 로그도 누구나 볼 수 있다 — 로그에는
   실행 슬롯, 판정 단계, 발송 성공/실패 정도만 남기고, 토큰·API 응답 본문·
   좌표·메시지 본문 등 상세값은 어떤 레벨로도 출력하지 않는다.

   사용(모두 GitHub Actions 워크플로에서 환경변수로 전달):
     KMA_SERVICE_KEY, KAKAO_REST_KEY, KAKAO_CLIENT_SECRET, KAKAO_REFRESH_TOKEN,
     GH_PAT, GITHUB_REPOSITORY(자동), ICING_SLOT(eve|night, 워크플로가 계산),
     ICING_IS_MANUAL(true|false), ICING_STATE_PATH(.icing-state/state.json)
   =================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const STATE_PATH = process.env.ICING_STATE_PATH || path.join(ROOT, '.icing-state', 'state.json');
const LOG_DIR = path.join(ROOT, 'data', 'icing-log');
const LINK = 'https://jinoairport.github.io/weather_web/icing.html';
const DAYS_KO = ['일', '월', '화', '수', '목', '금', '토'];

function fail(msg) {
  console.error('실패:', msg);
  process.exit(1);
}

/* ===================== 1. 사이트와 동일한 전역 구성 + icing.js 로드 =====================
   vm.runInThisContext는 진짜 전역 객체에 top-level 선언을 반영하므로,
   require('js/icing.js') 안에서 참조하는 kmaFetch/fetchWeatherData/CONFIG/
   localStorage가 정상적으로 보인다 (eval과 달리 require 간에도 공유됨). */
function loadIcingModule(apiKey) {
  global.CONFIG = { API_KEY: apiKey, NX: 96, NY: 76, ready: Promise.resolve() };
  const store = {};
  global.localStorage = {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
  };
  global.window = { addEventListener() {} };
  global.document = { getElementById: () => null, querySelectorAll: () => [] };

  const dataSrc = fs.readFileSync(path.join(ROOT, 'js', 'data.js'), 'utf8');
  const apiSrc = fs.readFileSync(path.join(ROOT, 'js', 'api.js'), 'utf8');
  vm.runInThisContext(dataSrc, { filename: 'js/data.js' });
  vm.runInThisContext(apiSrc, { filename: 'js/api.js' });

  // eslint-disable-next-line global-require, import/no-dynamic-require
  return require(path.join(ROOT, 'js', 'icing.js'));
}

/* ===================== 2. 발송 전 필수 게이트: tests/icing.test.js =====================
   공개 로그이므로 날짜별 비교표는 찍지 않고 통과/실패만 남긴다 */
function runIcingTests() {
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'tests', 'icing.test.js')], {
      cwd: ROOT, stdio: ['ignore', 'ignore', 'ignore'],
    });
    console.log('사전 검증(tests/icing.test.js): 통과');
  } catch (e) {
    console.log('사전 검증(tests/icing.test.js): 실패');
    fail('tests/icing.test.js 실패 — 발송하지 않고 종료합니다.');
  }
}

/* ===================== 3. 대상일(항상 "내일 새벽") ===================== */
function computeTomorrowTarget(icing) {
  const nowMs = icing.icingKstNowMs();
  const p = icing.icingKstDateParts(nowMs);
  const todayMs = icing.icingKstMs(p.y, p.mo, p.d, 0, 0);
  const tp = icing.icingKstDateParts(todayMs + 86400000);
  return { y: tp.y, mo: tp.mo, d: tp.d };
}

function fmtHeaderDate(targetIso) {
  const [y, m, d] = targetIso.split('-').map(Number);
  const dow = DAYS_KO[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${m}/${d}(${dow})`;
}

/* "MM/DD HH시" -> "HH시" (2자리 그대로, 예: "04시") */
function hourOnlyKo(mdH) {
  if (!mdH) return null;
  const m = mdH.match(/(\d{2})시$/);
  return m ? `${m[1]}시` : null;
}

/* icing.js의 pty_name('비','눈','비/눈','소나기') 조합을 자연스러운 문구로 — 중복 없이 합침
   (예: ['비','비/눈'] -> "비·진눈깨비", "비·비·진눈깨비"처럼 겹치지 않게) */
function precipPhrase(kinds) {
  if (!kinds || !kinds.length) return '강수';
  const parts = new Set();
  kinds.forEach(k => {
    if (k === '비/눈') { parts.add('비'); parts.add('진눈깨비'); }
    else if (k === '비' || k === '눈' || k === '소나기') parts.add(k);
    else if (k) parts.add(k);
  });
  return Array.from(parts).join('·');
}

/* ===================== 4. 200자 제한 처리 ===================== */
/* lines: [{text, trimmable}] — trimmable:true인 줄만 줄여서 전체를 200자 이내로 맞춘다 */
function composeWithLimit(lines, limit) {
  limit = limit || 200;
  let arr = lines.slice();
  const full = () => arr.map(l => l.text).join('\n');
  if (full().length <= limit) return full();

  const trimIdx = arr.findIndex(l => l.trimmable);
  if (trimIdx === -1) return full().slice(0, limit); // 안전망(이론상 도달 안 함)

  while (full().length > limit) {
    const cur = arr[trimIdx].text;
    const over = full().length - limit;
    const cut = Math.max(0, cur.length - over - 1); // "…" 1자 포함해서 자름
    if (cut <= 10) { // 더 줄이면 의미 없어지는 하한
      arr[trimIdx] = Object.assign({}, arr[trimIdx], { text: cur.slice(0, 10) + '…' });
      break;
    }
    arr[trimIdx] = Object.assign({}, arr[trimIdx], { text: cur.slice(0, cut) + '…' });
  }
  return full();
}

/* ===================== 5. 메시지 조합 (16:30/수동, 1통·2통) =====================
   1통 = 예상·조치, 2통 = 판정 근거(쉬운 말 + 수치). 둘 다 200자 이내,
   "나에게 보내기"로 연달아 보낸다. 자회사 단톡방에 그대로 공유되므로
   전문 용어(이슬점·습구온도·복사냉각·"결빙형/강수형" 등 내부 용어)는 쓰지 않는다. */

/* 결빙형/강수형 중 어떤 문구를 쓸지 — 둘 다 해당하면 결빙 시작이 빠른 쪽 */
function pickPrimaryType(res) {
  const hasA = res.types.includes('결빙형');
  const hasDS = res.types.includes('강수형');
  if (hasA && hasDS) {
    return (res.freeze_start_ms != null && res.precip_start_ms != null)
      ? (res.freeze_start_ms <= res.precip_start_ms ? 'A' : 'DS') : 'A';
  }
  if (hasA) return 'A';
  if (hasDS) return 'DS';
  return null;
}

/* "MM/DD HH시" 두 개를 "04~07시"(같으면 "04시") 형태로 — 시각 두 자리 유지 */
function hourRangeKo(startMdH, endMdH) {
  const sm = startMdH && startMdH.match(/(\d{2})시$/);
  const em = endMdH && endMdH.match(/(\d{2})시$/);
  if (!sm && !em) return '';
  if (!sm) return `${em[1]}시`;
  if (!em || sm[1] === em[1]) return `${sm[1]}시`;
  return `${sm[1]}~${em[1]}시`;
}

function tempRangeKo(min, max) {
  if (min == null && max == null) return '';
  if (min == null) return `${max}℃`;
  if (max == null) return `${min}℃`;
  return min === max ? `${min}℃` : `${min}~${max}℃`;
}

function build1Message(res) {
  const header = fmtHeaderDate(res.target);
  if (res.level === 3) {
    const primary = pickPrimaryType(res);
    const expect = primary === 'DS'
      ? `${hourOnlyKo(res.precip_start_time) || '새벽'}경 ${precipPhrase(res.precip_kinds)}가 시작되면 바로 노면 결빙 예상`
      : `${hourOnlyKo(res.freeze_start_time) || '새벽'}경부터 노면 결빙(블랙아이스), 일출(${res.sunrise}) 후 해소 예상`;
    return composeWithLimit([
      { text: `[김해공항 노면결빙 예보] ${header} 새벽 「위험」` },
      { text: `■예상: ${expect}`, trimmable: true },
      { text: '■조치: 제설제 살포인원 05시 조기출근 → 결빙 취약구간(그늘·물고임·보도) 제설제 사전 살포, 06시 승객 보행 전 완료 후 결과 단톡방 공유' },
      { text: '※21시 재판정 결과 추가 통보 예정' },
    ]);
  }
  // level === 2 (주의) — 사유와 관계없이 공통 문구
  return composeWithLimit([
    { text: `[김해공항 노면결빙 예보] ${header} 새벽 「주의」` },
    { text: `■예상: 05~07시 취약구간 얇은 결빙 가능(일출 ${res.sunrise}, 06시 승객 보행 전 확인 필요)`, trimmable: true },
    { text: '■조치: 추가 인원 조기출근 없음. 야간 점검자가 05시경 취약구간(그늘·물고임·보도) 순찰 → 결빙 시 국부 살포·단톡방 보고, 범위가 넓으면 살포인원 호출' },
    { text: '※21시 재판정 결과 추가 통보 예정' },
  ]);
}

/* 09시 기온 — early_recovery 하향 사유 문구("09시 5℃")에서 그대로 추출(판정 로직에 새 필드 추가 없이 재사용) */
function extractRecoverTemp09(res) {
  const d = (res.downgrades || []).find(x => x.includes('조기 회복'));
  const m = d && d.match(/09시 (-?\d+)℃/);
  return m ? m[1] : null;
}

function build2Message(res) {
  const headerLine = `[판정 근거] 기상청 예보(${res.base})`;

  if (res.level === 3) {
    const primary = pickPrimaryType(res);
    if (primary === 'DS') {
      return composeWithLimit([
        { text: headerLine },
        { text: `·기온: 밤사이 최저 ${res.night_min_temp}℃(${hourOnlyKo(res.night_min_time) || ''}) → 노면이 식은 상태` },
        { text: `·비·눈: ${hourRangeKo(res.precip_start_time, res.precip_end_time)} ${precipPhrase(res.precip_kinds)}, `
          + `기온 ${tempRangeKo(res.precip_min_temp, res.precip_max_temp)} ·습도: ${res.precip_avg_rh}% → 비·눈이 마르지 않고 노면에 닿음`, trimmable: true },
        { text: '→ 식은 노면에 닿는 즉시 얼 가능성 높음' },
      ]);
    }
    return composeWithLimit([
      { text: headerLine },
      { text: `·비: 어제 ${hourRangeKo(res.rain_start_time, res.last_rain_time)}(${res.eve_rain_hours}시간) → 노면이 젖은 채 밤을 맞음` },
      { text: `·기온: 새벽 최저 ${res.morning_min_temp}℃(${hourOnlyKo(res.morning_min_time) || ''}), `
        + `${hourRangeKo(res.freeze_start_time, res.freeze_end_time)} 영하 ·습도: ${res.morning_min_rh}% → 노면이 마르지 않음`, trimmable: true },
      { text: `·날씨: ${res.morning_min_sky || '-'}·바람 ${res.freeze_avg_wind}m/s → 노면이 더 빨리 식음` },
      { text: '→ 젖은 노면이 그대로 얼 가능성 높음' },
    ]);
  }

  // level === 2 (주의) — 사유별로 다른 근거
  if (res.downgrade_types.includes('early_recovery')) {
    return composeWithLimit([
      { text: headerLine },
      { text: `·비 그친 뒤 노면이 젖은 채 새벽 ${res.morning_min_temp}℃까지 하강`, trimmable: true },
      { text: `·다만: 일출 ${res.sunrise}로 이르고 아침 맑음, 09시 ${extractRecoverTemp09(res) || ''}℃ → 얼더라도 오래가지 않을 것으로 판단` },
    ]);
  }
  if (res.downgrade_types.includes('strong_wind')) {
    return composeWithLimit([
      { text: headerLine },
      { text: `·비 그친 뒤 노면이 젖은 채 새벽 ${res.morning_min_temp}℃까지 하강`, trimmable: true },
      { text: `·다만: 바람 ${res.freeze_avg_wind}m/s로 강해 노면이 빨리 마름 → 결빙 범위 작을 것으로 판단` },
    ]);
  }
  if (res.types.includes('증발냉각')) {
    return composeWithLimit([
      { text: headerLine },
      { text: `·비: 어제 ${hourRangeKo(res.rain_start_time, res.last_rain_time)} → 노면 젖은 상태` },
      { text: `·기온: 새벽 ${res.c3_temp}℃로 영상이나 습도 ${res.c3_rh}%로 다소 건조, 바람 ${res.c3_wind}m/s`, trimmable: true },
      { text: '·젖은 노면의 물이 마르면서 노면 온도를 떨어뜨림' },
      { text: '→ 기온이 영상이어도 그늘·물고임 구간은 얇게 얼 수 있음' },
    ]);
  }
  // 그 외(알 수 없는 사유) — 안전한 일반 문구로 폴백
  return composeWithLimit([
    { text: headerLine },
    { text: `·비 그친 뒤 노면이 젖은 채 새벽 ${res.morning_min_temp}℃까지 하강`, trimmable: true },
    { text: '·다만: 예보상 결빙 가능성이 낮아지는 요인이 있어 주의 단계로 판단' },
  ]);
}

/* 관심/정상 상태에서의 수동(테스트) 발송 — 예시에 없는 보강 케이스, 간단한 현황만 알림 */
function buildCalmMessage(res) {
  const header = fmtHeaderDate(res.target);
  return composeWithLimit([
    { text: `[김해공항 노면결빙 예보] ${header} 새벽 「${res.level_name}」 (수동 테스트 발송)` },
    { text: `■현황: ${res.action}`, trimmable: true },
  ]);
}

function levelBracket(levelName) { return `「${levelName}」`; }

/* ===================== 6. 16:30 ↔ 21:00 비교 → 실제 변경 사유 한 문장 =====================
   둘 다 있는 값만 비교하고, 우선순위가 높은 변화 하나만 골라 보고한다
   (하향 사유 등장/소멸 > 비 종료 시각 > 결빙 시작 시각 > 강수 시작 시각 >
    새벽/밤사이 최저기온 > 판정 유형 변경 > 변화 없음) */
function describeChange(prior, res) {
  const priorDG = new Set(prior.downgrade_types || []);
  const nowDG = new Set(res.downgrade_types || []);
  const addedDG = Array.from(nowDG).filter(x => !priorDG.has(x));
  const removedDG = Array.from(priorDG).filter(x => !nowDG.has(x));

  if (addedDG.includes('early_recovery')) return '이른 일출·맑음으로 조기 회복 예상';
  if (addedDG.includes('strong_wind')) return `강풍(평균 ${res.freeze_avg_wind}m/s) 예보로 노면 건조 빠름`;
  if (removedDG.includes('early_recovery')) return '맑음 예보가 흐림으로 바뀌어 조기 회복 기대 어려움';
  if (removedDG.includes('strong_wind')) return '풍속 전망이 약해져 결빙 지속 가능성 높아짐';

  if (prior.last_rain_time !== res.last_rain_time) {
    const p = prior.last_rain_time ? hourOnlyKo(prior.last_rain_time) : '없음';
    const n = res.last_rain_time ? hourOnlyKo(res.last_rain_time) : '없음';
    const dir = (prior.last_rain_ms != null && res.last_rain_ms != null)
      ? (res.last_rain_ms < prior.last_rain_ms ? '앞당겨짐' : '늦춰짐') : '변경';
    return `비 종료 예상이 ${p}→${n}로 ${dir}`;
  }

  if (prior.freeze_start_time !== res.freeze_start_time) {
    const p = prior.freeze_start_time ? hourOnlyKo(prior.freeze_start_time) : '없음';
    const n = res.freeze_start_time ? hourOnlyKo(res.freeze_start_time) : '없음';
    const dir = (prior.freeze_start_ms != null && res.freeze_start_ms != null)
      ? (res.freeze_start_ms < prior.freeze_start_ms ? '앞당겨짐' : '늦춰짐') : '변경';
    return `결빙 시작 예상이 ${p}→${n}로 ${dir}`;
  }

  if (prior.precip_start_time !== res.precip_start_time) {
    const p = prior.precip_start_time ? hourOnlyKo(prior.precip_start_time) : '없음';
    const n = res.precip_start_time ? hourOnlyKo(res.precip_start_time) : '없음';
    const dir = (prior.precip_start_ms != null && res.precip_start_ms != null)
      ? (res.precip_start_ms < prior.precip_start_ms ? '앞당겨짐' : '늦춰짐') : '변경';
    return `강수 시작 예상이 ${p}→${n}로 ${dir}`;
  }

  if (prior.morning_min_temp !== res.morning_min_temp && res.morning_min_temp != null) {
    const dir = (prior.morning_min_temp != null && res.morning_min_temp > prior.morning_min_temp) ? '상승' : '하강';
    return `새벽 최저기온 예보 ${prior.morning_min_temp}℃→${res.morning_min_temp}℃로 ${dir}`;
  }

  if (prior.night_min_temp !== res.night_min_temp && res.night_min_temp != null) {
    const dir = (prior.night_min_temp != null && res.night_min_temp > prior.night_min_temp) ? '상승' : '하강';
    return `밤사이 최저기온 예보 ${prior.night_min_temp}℃→${res.night_min_temp}℃로 ${dir}`;
  }

  const priorTypes = (prior.types || []).slice().sort().join(',');
  const nowTypes = (res.types || []).slice().sort().join(',');
  if (priorTypes !== nowTypes) {
    return `결빙 유형이 ${(prior.types || []).join('/') || '없음'}→${(res.types || []).join('/') || '없음'}로 변경`;
  }

  return '예보 갱신 — 이전 판정과 조건 동일';
}

function build2100Message(res, prior) {
  const header = fmtHeaderDate(res.target);
  const priorLevel = prior ? prior.level : 0;
  const priorName = prior ? prior.level_name : '정상';
  const dir = res.level > priorLevel ? '상향' : (res.level < priorLevel ? '하향' : '유지');

  let action;
  if (res.level === 3) {
    action = priorLevel === 3 ? '05시 조기출근 유지' : '제설제 살포인원 05시 조기출근으로 변경';
  } else if (priorLevel === 3) {
    action = '05시 조기출근 취소, 야간 점검자 05시경 순찰로 변경';
  } else if (res.level <= 1) {
    action = '결빙 가능성 낮아져 조기출근·순찰 해제';
  } else {
    action = '조기출근 없음, 출근 즉시 순찰 유지';
  }

  const cause = describeChange(prior || {}, res);
  const title = `${header} 새벽 ${levelBracket(priorName)}→${levelBracket(res.level_name)} ${dir}`;

  return composeWithLimit([
    { text: '[김해공항 노면결빙 예보] 21시 재판정' },
    { text: title },
    { text: `■사유: ${cause}`, trimmable: true },
    { text: `■조치: ${action}` },
  ]);
}

/* ===================== 7. 21시 비교용 상태 저장/로드 =====================
   describeChange가 비교하는 값들을 전부 남겨둬야 21시에 "무엇이 바뀌었는지"를 쓸 수 있다 */
function loadPriorState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch (e) {
    return null;
  }
}

function saveState(res) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify({
    target: res.target, level: res.level, level_name: res.level_name,
    types: res.types, downgrades: res.downgrades, downgrade_types: res.downgrade_types,
    last_rain_time: res.last_rain_time, last_rain_ms: res.last_rain_ms,
    freeze_start_time: res.freeze_start_time, freeze_start_ms: res.freeze_start_ms,
    precip_start_time: res.precip_start_time, precip_start_ms: res.precip_start_ms,
    morning_min_temp: res.morning_min_temp, night_min_temp: res.night_min_temp,
    freeze_avg_wind: res.freeze_avg_wind,
  }, null, 1), 'utf8');
}

/* ===================== 7-1. 판정 결과 자동 기록(data/icing-log/{동절기}.json) =====================
   master에만 쌓는다(이 파일 작성 뒤 워크플로가 master에 커밋·push — main에는 올리지 않음).
   토큰·키는 절대 넣지 않는다. */
function winterSeasonLabel(targetIso) {
  const [y, m] = targetIso.split('-').map(Number);
  const startYear = m >= 10 ? y : y - 1; // 대상일이 10~12월이면 그 해가 동절기 시작 연도, 1~9월이면 전년도
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

function cautionReasonTag(res) {
  if (res.level !== 2) return null;
  if (res.downgrade_types.includes('early_recovery')) return 'early_recovery';
  if (res.downgrade_types.includes('strong_wind')) return 'strong_wind';
  if (res.types.includes('증발냉각')) return 'evap_cooling';
  return 'unknown';
}

function appendIcingLog(res, slot, isManual, sent, nowDisplay) {
  const file = path.join(LOG_DIR, `${winterSeasonLabel(res.target)}.json`);
  fs.mkdirSync(LOG_DIR, { recursive: true });
  let log = [];
  try { log = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { log = []; }
  log.push({
    executed_at: nowDisplay,
    slot, is_manual: isManual,
    target: res.target,
    level: res.level, level_name: res.level_name,
    caution_reason: cautionReasonTag(res),
    forecast_base: res.base,
    morning_min_temp: res.morning_min_temp,
    night_min_temp: res.night_min_temp,
    last_rain_time: res.last_rain_time,
    freeze_start_time: res.freeze_start_time,
    precip_start_time: res.precip_start_time,
    sent,
  });
  fs.writeFileSync(file, JSON.stringify(log, null, 1), 'utf8');
}

/* ===================== 8. 카카오 토큰 갱신 + 시크릿 반영 =====================
   공개 로그 — 토큰 값은 마스킹해도 절대 출력하지 않는다. 성공/실패와
   로테이션 발생 여부만 남긴다. */
async function refreshKakaoToken(restKey, clientSecret, refreshToken) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: restKey,
    refresh_token: refreshToken,
    client_secret: clientSecret,
  });
  const resp = await fetch('https://kauth.kakao.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
    body,
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    fail(`카카오 토큰 갱신 실패 (${json.error_code || resp.status})`);
  }
  console.log('access_token 갱신: 완료');
  if (json.refresh_token) {
    updateGithubSecret('KAKAO_REFRESH_TOKEN', json.refresh_token);
  }
  return json.access_token;
}

function updateGithubSecret(name, value) {
  const ghPat = process.env.GH_PAT;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!ghPat || !repo) {
    console.log(`${name} 로테이션: 반영 안 됨(GH_PAT 미설정)`);
    return;
  }
  try {
    execFileSync('gh', ['secret', 'set', name, '--repo', repo, '--body-file', '-'], {
      input: value,
      env: Object.assign({}, process.env, { GH_TOKEN: ghPat }),
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    console.log(`${name} 로테이션: 반영 완료`);
  } catch (e) {
    console.log(`${name} 로테이션: 반영 실패(이번 실행 자체는 계속 진행됨)`);
  }
}

/* ===================== 9. 카카오 "나에게 보내기" 전송 ===================== */
async function sendKakaoMemo(accessToken, text, buttonTitle) {
  const template = {
    object_type: 'text',
    text,
    link: { web_url: LINK, mobile_web_url: LINK },
    button_title: buttonTitle || '결빙예측 페이지',
  };
  const resp = await fetch('https://kapi.kakao.com/v2/api/talk/memo/default/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
    },
    body: new URLSearchParams({ template_object: JSON.stringify(template) }),
  });
  const json = await resp.json().catch(() => ({}));
  if (!(resp.ok && json.result_code === 0)) {
    fail(`카카오 메시지 전송 실패 (${json.error_code || resp.status})`);
  }
  console.log('카카오 메시지 전송: 성공');
}

/* ===================== 메인 ===================== */
async function main() {
  const kmaKey = process.env.KMA_SERVICE_KEY;
  const kakaoRestKey = process.env.KAKAO_REST_KEY;
  const kakaoClientSecret = process.env.KAKAO_CLIENT_SECRET;
  const kakaoRefreshToken = process.env.KAKAO_REFRESH_TOKEN;
  const slot = process.env.ICING_SLOT; // 'eve' | 'night'
  const isManual = process.env.ICING_IS_MANUAL === 'true';

  if (!kmaKey) fail('KMA_SERVICE_KEY 시크릿이 없습니다.');
  if (!kakaoRestKey || !kakaoClientSecret || !kakaoRefreshToken) {
    fail('KAKAO_REST_KEY / KAKAO_CLIENT_SECRET / KAKAO_REFRESH_TOKEN 시크릿을 확인하세요.');
  }
  if (slot !== 'eve' && slot !== 'night') fail(`ICING_SLOT 값이 올바르지 않습니다: ${slot}`);

  console.log(`실행 슬롯: ${slot}${isManual ? ' (수동 실행)' : ''}`);

  runIcingTests();

  const icing = loadIcingModule(kmaKey);
  const target = computeTomorrowTarget(icing);

  let res;
  try {
    res = await icing.icingRunJudge(target);
  } catch (e) {
    // 기상청 자료 조회 실패 — 지정된 실패 안내 문구만 보내고, 실행도 실패 처리한다
    console.log('판정 단계: (기상청 자료 조회 실패)');
    const accessToken = await refreshKakaoToken(kakaoRestKey, kakaoClientSecret, kakaoRefreshToken);
    await sendKakaoMemo(accessToken, '[김해공항 노면결빙 예보] 기상청 자료 조회 실패로 자동 판정 불가. 결빙예측 페이지에서 직접 확인 바랍니다.');
    fail('기상청 자료 조회 실패');
    return;
  }

  console.log(`판정 단계: ${res.level_name}`);

  let shouldSend = false;
  let messages = null; // [[text, buttonTitle], ...] — 순서대로 연달아 발송

  if (isManual) {
    shouldSend = true;
    messages = res.level >= 2
      ? [[build1Message(res), '결빙예측 페이지'], [build2Message(res), '시간별 그래프 보기']]
      : [[buildCalmMessage(res), '결빙예측 페이지']];
  } else if (slot === 'eve') {
    shouldSend = res.level >= 2;
    if (shouldSend) {
      messages = [[build1Message(res), '결빙예측 페이지'], [build2Message(res), '시간별 그래프 보기']];
    }
  } else {
    // night — 21시 재판정은 1통만
    const prior = loadPriorState();
    const priorRisk = prior ? prior.level >= 2 : false;
    const nowRisk = res.level >= 2;
    if (priorRisk || nowRisk) {
      shouldSend = true;
      messages = [[build2100Message(res, prior), '결빙예측 페이지']];
    }
  }

  // 16:30 슬롯은 발송 여부와 무관하게 상태를 남겨 21시가 비교할 수 있게 한다
  if (slot === 'eve') saveState(res);

  const nowDisplay = icing.icingFmtDateTime(icing.icingKstNowMs());

  if (!shouldSend) {
    console.log('발송: 조건 미충족 — 보내지 않음');
    appendIcingLog(res, slot, isManual, false, nowDisplay);
    return;
  }

  const accessToken = await refreshKakaoToken(kakaoRestKey, kakaoClientSecret, kakaoRefreshToken);
  for (const [text, buttonTitle] of messages) {
    // eslint-disable-next-line no-await-in-loop
    await sendKakaoMemo(accessToken, text, buttonTitle);
  }
  appendIcingLog(res, slot, isManual, true, nowDisplay);
}

if (require.main === module) {
  main().catch(e => fail(e && e.message ? e.message : String(e)));
}

module.exports = {
  composeWithLimit, pickPrimaryType, hourRangeKo, tempRangeKo,
  build1Message, build2Message, buildCalmMessage, build2100Message, describeChange,
  fmtHeaderDate, hourOnlyKo, precipPhrase, loadIcingModule,
  computeTomorrowTarget, winterSeasonLabel, cautionReasonTag, appendIcingLog,
};
