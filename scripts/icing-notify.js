#!/usr/bin/env node
/* ===================================================
   노면 결빙 판정 → 카카오톡 "나에게 보내기" 알림 (GitHub Actions 전용)

   판정 로직은 js/icing.js(그리고 그 안에서 쓰는 js/api.js·js/data.js)를
   전혀 고치지 않고 그대로 실행한다. vm.runInThisContext로 사이트와 동일한
   전역(kmaFetch, fetchWeatherData, CONFIG, localStorage 등)을 구성한 뒤
   require('../js/icing.js')로 불러온다 — 사이트(icing.html)는 이 파일의
   존재를 모르므로 동작이 전혀 바뀌지 않는다.

   이 저장소는 공개 저장소라 Actions 로그도 누구나 볼 수 있다 — 로그에는
   판정 단계, 발송 성공/실패 정도만 남기고, 토큰·API 응답 본문·
   좌표·메시지 본문 등 상세값은 어떤 레벨로도 출력하지 않는다.

   더 이상 16:30/21:00 고정 슬롯이 없다 — cron-job.org가 매시간(16:30~04:30, 13회)
   workflow_dispatch를 부르고(GitHub schedule은 보조), 대상일별 알림 이력은
   data/icing-log/{동절기}.json에서, 매시간 실행 간 기상청 실황 재조회를 줄이는
   캐시는 data/obs-cache/rkpk.json에서 이어 쓴다.

   사용(모두 GitHub Actions 워크플로에서 환경변수로 전달):
     KMA_SERVICE_KEY, KAKAO_REST_KEY, KAKAO_CLIENT_SECRET, KAKAO_REFRESH_TOKEN,
     GH_PAT, GITHUB_REPOSITORY(자동), ICING_IS_MANUAL(true|false)
   =================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
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
  const mod = require(path.join(ROOT, 'js', 'icing.js'));
  mod.__store = store; // 매시간 실행 간 실황 캐시를 저장소 파일로 이어주기 위한 접근점(store 자체 — 매 프로세스 새로 생성됨)
  return mod;
}

/* ===================== 1-1. 실황 캐시 영속화(data/obs-cache) =====================
   icingCollectHours는 과거 시간별 실황을 localStorage(icing_obs_cache)에 캐시하지만,
   GitHub Actions는 실행마다 새 프로세스라 그 캐시가 매번 비어 있다. 매시간 실행으로
   바뀌면서 재결빙(48시간)·물고임 잔류(36시간) 판정에 필요한 과거 구간이 넓어졌으므로,
   이 캐시를 파일로 저장소에 남겨 다음 실행이 이어 쓰게 한다 — 기상청 API 호출을
   "이미 아는 과거 시각 재조회"가 아니라 "그 사이 새로 지난 시각"만큼만 하게 만든다. */
const OBS_CACHE_PATH = path.join(ROOT, 'data', 'obs-cache', 'rkpk.json');
const OBS_CACHE_KEEP_MS = 90 * 3600000; // 넉넉히 90시간치만 보관(재결빙 48h+버퍼)

function loadObsCacheFile() {
  try {
    return JSON.parse(fs.readFileSync(OBS_CACHE_PATH, 'utf8'));
  } catch (e) {
    return {};
  }
}

function pruneObsCache(cache, nowMs) {
  const cutoff = nowMs - OBS_CACHE_KEEP_MS;
  const out = {};
  Object.keys(cache).forEach(k => {
    if (Number(k) >= cutoff) out[k] = cache[k];
  });
  return out;
}

function saveObsCacheFile(cache) {
  fs.mkdirSync(path.dirname(OBS_CACHE_PATH), { recursive: true });
  fs.writeFileSync(OBS_CACHE_PATH, JSON.stringify(cache), 'utf8');
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
/* 대상일(판정 대상 새벽): 실행 시점 KST가 12시 이후면 "내일 새벽", 12시 이전이면 "오늘 새벽" —
   더 이상 16:30/21:00 슬롯 개념을 쓰지 않고(매시간 상시 감시), 실행 시각의 낮/밤 여부로만 정한다.
   사이트(icing.html)가 수동 조회 때 쓰는 icingDefaultTarget()과 완전히 같은 규칙이라 그대로 재사용한다. */
function computeTarget(icing, nowMs) {
  return icing.icingDefaultTarget(nowMs);
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

/* "MM/DD HH시" 두 개를 "11/24 20~23시"(같은 날) 또는 "11/24 23시~11/25 02시"(날짜 걸침)로 — 재결빙(48시간 창) 전용 */
function snowRangeKo(startMdH, endMdH) {
  if (!startMdH) return '';
  if (!endMdH || startMdH === endMdH) return startMdH;
  const sd = startMdH.split(' ')[0];
  const ed = endMdH.split(' ')[0];
  if (sd === ed) return `${sd} ${hourRangeKo(startMdH, endMdH)}`;
  return `${startMdH}~${endMdH}`;
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
      { text: '※이후 단계가 바뀌면 재판정 통보' },
    ]);
  }
  // level === 2 (주의) — 저녁 결빙은 00~08시 판정보다 이르므로 제목·예상을 따로 쓴다
  if (res.types.includes('저녁결빙')) {
    return composeWithLimit([
      { text: `[김해공항 노면결빙 예보] ${header} 오늘 저녁 「주의」` },
      { text: `■예상: ${hourOnlyKo(res.evening_freeze_start_time) || '저녁'}경부터 노면 결빙 가능`, trimmable: true },
      { text: '■조치: 추가 인원 조기출근 없음. 야간 점검자가 취약구간(그늘·물고임·보도) 순찰 → 결빙 시 국부 살포·단톡방 보고, 범위가 넓으면 살포인원 호출' },
      { text: '※이후 단계가 바뀌면 재판정 통보' },
    ]);
  }
  // 그 외(증발냉각/서리/재결빙/물고임/노면영하) — 사유와 관계없이 공통 문구
  return composeWithLimit([
    { text: `[김해공항 노면결빙 예보] ${header} 새벽 「주의」` },
    { text: `■예상: 05~07시 취약구간 얇은 결빙 가능(일출 ${res.sunrise}, 06시 승객 보행 전 확인 필요)`, trimmable: true },
    { text: '■조치: 추가 인원 조기출근 없음. 야간 점검자가 05시경 취약구간(그늘·물고임·보도) 순찰 → 결빙 시 국부 살포·단톡방 보고, 범위가 넓으면 살포인원 호출' },
    { text: '※이후 단계가 바뀌면 재판정 통보' },
  ]);
}

/* 09시 기온 — early_recovery 하향 사유 문구("09시 5℃")에서 그대로 추출(판정 로직에 새 필드 추가 없이 재사용) */
function extractRecoverTemp09(res) {
  const d = (res.downgrades || []).find(x => x.includes('조기 회복'));
  const m = d && d.match(/09시 (-?\d+)℃/);
  return m ? m[1] : null;
}

/* data.baseTimeDisplay(예: "11/26 17:00 발표", stale 시 "⚠" 접두)를
   "{m}/{d} {HH}시 발표" 한 형태로 통일 — 괄호 중첩 없이 headerLine 안에 그대로 들어간다 */
function formatBaseKo(baseDisplay) {
  const raw = String(baseDisplay || '');
  const m = raw.match(/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):\d{2}/);
  if (!m) return raw || '-';
  const hh = String(Number(m[3])).padStart(2, '0');
  return `${Number(m[1])}/${Number(m[2])} ${hh}시 발표`;
}

function build2Message(res) {
  const headerLine = `[판정 근거] 기상청 예보(${formatBaseKo(res.base)})`;

  if (res.level === 3) {
    const primary = pickPrimaryType(res);
    if (primary === 'DS') {
      return composeWithLimit([
        { text: headerLine },
        { text: `·기온: 밤사이 최저 ${res.night_min_temp}℃(${hourOnlyKo(res.night_min_time) || ''}) → 노면이 영하로 차가워진 상태` },
        { text: `·비·눈: ${hourRangeKo(res.precip_start_time, res.precip_end_time)} ${precipPhrase(res.precip_kinds)}, `
          + `기온 ${tempRangeKo(res.precip_min_temp, res.precip_max_temp)} → 비·눈이 마르지 않고 노면에 닿음`, trimmable: true },
        { text: `·습도: ${res.precip_avg_rh}%` },
        { text: '→ 차가워진 노면에 닿는 즉시 얼 가능성 높음' },
      ]);
    }
    return composeWithLimit([
      { text: headerLine },
      { text: `·비: 어제 ${hourRangeKo(res.rain_start_time, res.last_rain_time)}(${res.eve_rain_hours}시간) → 노면이 젖은 채 밤을 맞음` },
      { text: `·기온: 새벽 최저 ${res.morning_min_temp}℃(${hourOnlyKo(res.morning_min_time) || ''}), `
        + `${hourRangeKo(res.freeze_start_time, res.freeze_end_time)} 영하 → 노면이 마르지 않음`, trimmable: true },
      { text: `·습도: ${res.morning_min_rh}%` },
      { text: `·날씨: ${res.morning_min_sky || '-'}·바람 ${res.freeze_avg_wind}m/s` },
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
      { text: `·기온: 새벽 ${res.c3_temp}℃로 영상, 바람 ${res.c3_wind}m/s`, trimmable: true },
      { text: `·습도: ${res.c3_rh}%로 다소 건조` },
      { text: '·젖은 노면의 물이 마르면서 노면 온도를 떨어뜨림' },
      { text: '→ 기온이 영상이어도 그늘·물고임 구간은 얇게 얼 수 있음' },
    ]);
  }
  if (res.types.includes('재결빙')) {
    return composeWithLimit([
      { text: headerLine },
      { text: `·눈: ${snowRangeKo(res.snow_start_time, res.snow_end_time)} 눈·진눈깨비`, trimmable: true },
      { text: `·기온: 새벽 최저 ${res.morning_min_temp}℃` },
      { text: '→ 녹은 눈이 다시 얼 수 있음, 눈 치운 자리·배수 불량 구간 주의' },
    ]);
  }
  if (res.types.includes('물고임')) {
    return composeWithLimit([
      { text: headerLine },
      { text: `·비: 최근 36시간 ${res.puddle_total_mm}mm`, trimmable: true },
      { text: `·기온: 새벽 최저 ${res.morning_min_temp}℃` },
      { text: '→ 물고임 구간에 남은 물이 얼 수 있음' },
    ]);
  }
  if (res.types.includes('노면영하')) {
    return composeWithLimit([
      { text: headerLine },
      { text: `·비: 어제 ${hourRangeKo(res.rain_start_time, res.last_rain_time)}`, trimmable: true },
      { text: `·기온: 새벽 ${res.ws_min_temp}℃(영상이나 0℃ 근접)` },
      { text: '→ 그늘·교량 구간은 노면이 먼저 얼 수 있음' },
    ]);
  }
  if (res.types.includes('서리')) {
    return composeWithLimit([
      { text: headerLine },
      { text: `·날씨: 맑음·바람 ${res.frost_wind}m/s`, trimmable: true },
      { text: `·기온: 새벽 ${res.frost_temp}℃, 습도 ${res.frost_rh}%` },
      { text: '→ 공기 중 수분이 노면에 얼어붙는 서리 가능, 보도·데크 미끄럼 주의' },
    ]);
  }
  if (res.types.includes('저녁결빙')) {
    return composeWithLimit([
      { text: headerLine },
      { text: `·비: 어제 ${hourRangeKo(res.rain_start_time, res.last_rain_time)} → 노면이 젖은 채 저녁을 맞음`, trimmable: true },
      { text: `·기온: 저녁 ${hourOnlyKo(res.evening_freeze_start_time) || ''}부터 영하` },
      { text: '→ 이른 결빙 가능, 저녁 운항·보행 시간대 주의' },
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
   "없음→04시"처럼 있고/없음을 시각과 그대로 비교하면 뜻이 통하지 않으므로,
   레벨이 바뀐 경우는 원인(기온·강수 변화)과 결과(결빙 시작 등)를 한 문장으로 엮어 설명하고,
   둘 다 실제 값이 있는 시각 비교만 "X→Y로 변경" 형태를 쓴다.
   우선순위: 하향 사유 등장/소멸 > 레벨 변화(기온/강수 원인) > 세부 시각 변경 > 유형 변경 > 변화 없음 */
function describeChange(prior, res) {
  const priorDG = new Set(prior.downgrade_types || []);
  const nowDG = new Set(res.downgrade_types || []);
  const addedDG = Array.from(nowDG).filter(x => !priorDG.has(x));
  const removedDG = Array.from(priorDG).filter(x => !nowDG.has(x));

  if (addedDG.includes('early_recovery')) return '이른 일출·맑음으로 조기 회복 예상';
  if (addedDG.includes('strong_wind')) return `강풍(평균 ${res.freeze_avg_wind}m/s) 예보로 노면 건조 빠름`;
  if (removedDG.includes('early_recovery')) return '맑음 예보가 흐림으로 바뀌어 조기 회복 기대 어려움';
  if (removedDG.includes('strong_wind')) return '풍속 전망이 약해져 결빙 지속 가능성 높아짐';

  const priorLevel = prior.level || 0;
  if (res.level !== priorLevel) {
    const up = res.level > priorLevel;
    const priorT = prior.morning_min_temp;
    const nowT = res.morning_min_temp;
    if (priorT != null && nowT != null && priorT !== nowT) {
      const dir2 = nowT < priorT ? '낮아져' : '높아져';
      if (res.freeze_start_time) {
        return `최신 예보에서 새벽 기온이 ${priorT}℃→${nowT}℃로 ${dir2} ${hourOnlyKo(res.freeze_start_time)}경부터 결빙 예상`;
      }
      return `최신 예보에서 새벽 기온이 ${priorT}℃→${nowT}℃로 ${dir2} 결빙 가능성이 ${up ? '높아짐' : '낮아짐'}`;
    }
    const priorN = prior.night_min_temp;
    const nowN = res.night_min_temp;
    if (priorN != null && nowN != null && priorN !== nowN) {
      const dir2 = nowN < priorN ? '낮아져' : '높아져';
      return `최신 예보에서 밤사이 기온이 ${priorN}℃→${nowN}℃로 ${dir2} 결빙 가능성이 ${up ? '높아짐' : '낮아짐'}`;
    }
    if (prior.last_rain_time && res.last_rain_time && prior.last_rain_time !== res.last_rain_time) {
      const p = hourOnlyKo(prior.last_rain_time);
      const n = hourOnlyKo(res.last_rain_time);
      const dir = (prior.last_rain_ms != null && res.last_rain_ms != null)
        ? (res.last_rain_ms < prior.last_rain_ms ? '빨라져' : '늦어져') : '바뀌어';
      return `비가 그치는 시점이 ${p}→${n}로 ${dir} 노면이 ${up ? '더 오래 젖어있을' : '더 빨리 마를'} 것으로 판단`;
    }
    return `최신 예보에서 결빙 가능성이 ${up ? '높아짐' : '낮아짐'}`;
  }

  // 레벨은 같은데 세부 시각이 바뀐 경우 — 둘 다 실제 값이 있을 때만 비교한다
  if (prior.last_rain_time && res.last_rain_time && prior.last_rain_time !== res.last_rain_time) {
    const p = hourOnlyKo(prior.last_rain_time);
    const n = hourOnlyKo(res.last_rain_time);
    const dir = (prior.last_rain_ms != null && res.last_rain_ms != null)
      ? (res.last_rain_ms < prior.last_rain_ms ? '앞당겨짐' : '늦춰짐') : '변경';
    return `비 종료 예상이 ${p}→${n}로 ${dir}`;
  }

  if (prior.freeze_start_time && res.freeze_start_time && prior.freeze_start_time !== res.freeze_start_time) {
    const p = hourOnlyKo(prior.freeze_start_time);
    const n = hourOnlyKo(res.freeze_start_time);
    const dir = (prior.freeze_start_ms != null && res.freeze_start_ms != null)
      ? (res.freeze_start_ms < prior.freeze_start_ms ? '앞당겨짐' : '늦춰짐') : '변경';
    return `결빙 시작 예상이 ${p}→${n}로 ${dir}`;
  }

  if (prior.precip_start_time && res.precip_start_time && prior.precip_start_time !== res.precip_start_time) {
    const p = hourOnlyKo(prior.precip_start_time);
    const n = hourOnlyKo(res.precip_start_time);
    const dir = (prior.precip_start_ms != null && res.precip_start_ms != null)
      ? (res.precip_start_ms < prior.precip_start_ms ? '앞당겨짐' : '늦춰짐') : '변경';
    return `강수 시작 예상이 ${p}→${n}로 ${dir}`;
  }

  const priorTypes = (prior.types || []).slice().sort().join(',');
  const nowTypes = (res.types || []).slice().sort().join(',');
  if (priorTypes !== nowTypes) {
    return `결빙 유형이 ${(prior.types || []).join('/') || '없음'}→${(res.types || []).join('/') || '없음'}로 변경`;
  }

  return '예보 갱신 — 이전 판정과 조건 동일';
}

/* 위험으로 상향되는 시각이 22시 이후(심야)면 05시 조기출근 대기 대신 즉시 대응으로 바꾼다 */
function buildReassessAction(res, priorLevel, kstHour) {
  if (res.level === 3) {
    if (priorLevel === 3) return '05시 조기출근 유지';
    const late = kstHour >= 22 || kstHour < 5;
    return late
      ? '야간 점검자 즉시 취약구간 확인·국부 살포, 범위가 넓으면 토목부 판단으로 제설제 살포인원 비상호출'
      : '제설제 살포인원 05시 조기출근으로 변경';
  }
  if (priorLevel === 3) return '05시 조기출근 취소, 야간 점검자 05시경 순찰로 변경';
  if (res.level <= 1) return '결빙 가능성 낮아져 조기출근·순찰 해제';
  return '야간 점검자 05시경 순찰 유지';
}

/* 상향(레벨이 오를 때)·정리(21:30, 하향·유지·해제) 공용 1통 — 제목을 "{HH:MM} 재판정"으로 실행 시각을 그대로 적는다.
   단계가 그대로(유지)면 화살표 없이 "「단계」 유지"로, 사유도 고정 문구로 쓴다(실제로 바뀐 게 없으므로). */
function buildReassessMessage(res, prior, nowHHMM, kstHour) {
  const header = fmtHeaderDate(res.target);
  const priorLevel = prior ? prior.level : 0;
  const priorName = prior ? prior.level_name : '정상';
  const dir = res.level > priorLevel ? '상향' : (res.level < priorLevel ? '하향' : '유지');
  const action = buildReassessAction(res, priorLevel, kstHour);
  const title = dir === '유지'
    ? `${header} 새벽 ${levelBracket(res.level_name)} 유지`
    : `${header} 새벽 ${levelBracket(priorName)}→${levelBracket(res.level_name)} ${dir}`;
  const cause = dir === '유지' ? '최신 예보에서도 결빙 조건 그대로' : describeChange(prior || {}, res);

  return composeWithLimit([
    { text: `[김해공항 노면결빙 예보] ${nowHHMM} 재판정` },
    { text: title },
    { text: `■사유: ${cause}`, trimmable: true },
    { text: `■조치: ${action}` },
  ]);
}

/* ===================== 7. 대상일별 알림 이력(data/icing-log) — 21:30 하향 비교의 "이전 상태"도 여기서 가져온다 =====================
   master에만 쌓는다(이 파일 작성 뒤 워크플로가 master에 커밋·push — main에는 올리지 않음).
   토큰·키는 절대 넣지 않는다. */
function winterSeasonLabel(targetIso) {
  const [y, m] = targetIso.split('-').map(Number);
  const startYear = m >= 10 ? y : y - 1; // 대상일이 10~12월이면 그 해가 동절기 시작 연도, 1~9월이면 전년도
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

function loadSeasonLog(targetIso) {
  const file = path.join(LOG_DIR, `${winterSeasonLabel(targetIso)}.json`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return [];
  }
}

/* 같은 시(hour)에 이미 실행된 기록이 있으면 중복 실행 — nowDisplay: "YYYY-MM-DD HH:MM" */
function alreadyRanThisHour(log, nowDisplay) {
  const hourKey = nowDisplay.slice(0, 13); // "YYYY-MM-DD HH"
  return log.some(e => (e.executed_at || '').slice(0, 13) === hourKey);
}

/* 오늘(대상일) 실제로 알림을 보낸 기록 중 최고 단계 — 수동 테스트 발송은 집계에서 뺀다(통계 오염 방지) */
function maxAlertedLevel(log, targetIso) {
  let max = 0;
  log.forEach(e => {
    if (e.target === targetIso && e.sent && !e.is_manual && e.level > max) max = e.level;
  });
  return max;
}

/* 가장 최근에 실제로 보낸 알림 — 재판정 문구의 "이전 상태" 비교 기준(수동 테스트 제외) */
function lastAlertEntry(log, targetIso) {
  let best = null;
  log.forEach(e => {
    if (e.target === targetIso && e.sent && !e.is_manual) best = e;
  });
  return best;
}

function cautionReasonTag(res) {
  if (res.level !== 2) return null;
  if (res.downgrade_types.includes('early_recovery')) return 'early_recovery';
  if (res.downgrade_types.includes('strong_wind')) return 'strong_wind';
  const order = ['증발냉각', '재결빙', '물고임', '노면영하', '서리', '저녁결빙'];
  const hit = order.find(t => res.types.includes(t));
  return hit ? { 증발냉각: 'evap_cooling', 재결빙: 'refreeze', 물고임: 'puddle', 노면영하: 'warm_surface', 서리: 'frost', 저녁결빙: 'evening' }[hit] : 'unknown';
}

function appendIcingLog(res, isManual, alertKind, sent, nowDisplay) {
  const file = path.join(LOG_DIR, `${winterSeasonLabel(res.target)}.json`);
  fs.mkdirSync(LOG_DIR, { recursive: true });
  let log = [];
  try { log = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { log = []; }
  log.push({
    executed_at: nowDisplay,
    is_manual: isManual,
    target: res.target,
    level: res.level, level_name: res.level_name,
    types: res.types, downgrade_types: res.downgrade_types,
    caution_reason: cautionReasonTag(res),
    forecast_base: res.base,
    morning_min_temp: res.morning_min_temp,
    night_min_temp: res.night_min_temp,
    last_rain_time: res.last_rain_time, last_rain_ms: res.last_rain_ms,
    freeze_start_time: res.freeze_start_time, freeze_start_ms: res.freeze_start_ms,
    precip_start_time: res.precip_start_time, precip_start_ms: res.precip_start_ms,
    freeze_avg_wind: res.freeze_avg_wind,
    alert_kind: alertKind, // 'initial' | 'escalate' | 'cleanup' | null(발송 없음)
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
    throw new Error(`카카오 메시지 전송 실패 (${json.error_code || resp.status})`);
  }
  console.log('카카오 메시지 전송: 성공');
}

/* ===================== 9-1. 이상 감지(지연·오류) 알림 — 과장님에게만, 하루 1회 =====================
   대상일이 아니라 "오늘(실행일) KST 날짜" 기준으로 하루 1회만 보낸다. 판정 흐름이 실패해도
   이 알림 자체의 실패가 전체 실행을 추가로 막지는 않는다(최선 노력). */
function anomalyLogFile(todayIso) {
  return path.join(LOG_DIR, `${winterSeasonLabel(todayIso)}.json`);
}

function anomalyAlreadySentToday(todayIso) {
  try {
    const log = JSON.parse(fs.readFileSync(anomalyLogFile(todayIso), 'utf8'));
    return log.some(e => e.anomaly && (e.executed_at || '').slice(0, 10) === todayIso);
  } catch (e) {
    return false;
  }
}

function appendAnomalyMark(todayIso, reason, nowDisplay) {
  const file = anomalyLogFile(todayIso);
  fs.mkdirSync(LOG_DIR, { recursive: true });
  let log = [];
  try { log = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { log = []; }
  log.push({ executed_at: nowDisplay, anomaly: true, reason, sent: true });
  fs.writeFileSync(file, JSON.stringify(log, null, 1), 'utf8');
}

/* 감시 시간대(16:30~04:30) 안에서 직전 실행과 2시간 넘게 공백이 있었는지 — 감시 시간대 밖에서
   시작하는 하루 첫 실행(예: 04:30 다음 16:30)의 정상적인 ~12시간 공백은 대상에서 제외한다. */
function detectExecutionGap(log, nowMs, kstHour) {
  const inWindow = kstHour >= 16 || kstHour < 5;
  if (!inWindow || !log.length) return null;
  const last = log[log.length - 1];
  const m = (last.executed_at || '').match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/);
  if (!m) return null;
  const lastHour = Number(m[4]);
  if (lastHour === 4 && kstHour >= 16) return null; // 04:30(감시 종료)→16:30(감시 시작) 정상적인 하루 공백
  const lastInWindow = lastHour >= 16 || lastHour < 5;
  if (!lastInWindow) return null; // 그 밖의 감시 시간대 바깥 마지막 실행 → 정상 공백으로 간주
  // 로그의 executed_at은 KST 벽시계 문자열 — icingKstNowMs()·icingKstMs()와 같은 규칙(UTC getter로 KST 숫자를 읽는 epoch)으로 맞춰 뺀다
  const lastMs = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  const gapMs = nowMs - lastMs;
  if (gapMs > 2 * 3600000) return `마지막 실행 ${last.executed_at} 이후 ${(gapMs / 3600000).toFixed(1)}시간 공백`;
  return null;
}

async function sendAnomalyAlert(kakaoRestKey, kakaoClientSecret, kakaoRefreshToken, reason, nowDisplay) {
  const todayIso = nowDisplay.slice(0, 10);
  if (anomalyAlreadySentToday(todayIso)) {
    console.log(`이상 알림: 오늘 이미 보냄 — 생략(${reason})`);
    return;
  }
  const text = `[결빙알림] 자동 판정 지연·오류 발생(${reason}), 결빙예측 페이지에서 직접 확인 필요`;
  try {
    const accessToken = await refreshKakaoToken(kakaoRestKey, kakaoClientSecret, kakaoRefreshToken);
    await sendKakaoMemo(accessToken, text, '결빙예측 페이지');
    appendAnomalyMark(todayIso, reason, nowDisplay);
    console.log(`이상 알림 발송: 성공(${reason})`);
  } catch (e) {
    console.log(`이상 알림 발송 실패(최선 노력이었음): ${e && e.message ? e.message : String(e)}`);
  }
}

function kstNowDisplay() {
  const d = new Date(Date.now() + 9 * 3600000);
  const p2 = v => String(v).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
}

/* 워크플로의 "판정 기록 push" 단계처럼 icing-notify.js 바깥(셸)에서, 판정 과정 없이
   이상 알림만 보낼 때 쓰는 진입점 — KMA 키·판정 로직 로딩 없이 독립적으로 동작한다. */
async function sendAnomalyAlertCli(reason) {
  const kakaoRestKey = process.env.KAKAO_REST_KEY;
  const kakaoClientSecret = process.env.KAKAO_CLIENT_SECRET;
  const kakaoRefreshToken = process.env.KAKAO_REFRESH_TOKEN;
  if (!kakaoRestKey || !kakaoClientSecret || !kakaoRefreshToken) {
    console.log('이상 알림(CLI): 카카오 시크릿 없음 — 생략');
    return;
  }
  await sendAnomalyAlert(kakaoRestKey, kakaoClientSecret, kakaoRefreshToken, reason, kstNowDisplay());
}

/* ===================== 메인 =====================
   더 이상 16:30/21:00 슬롯이 없다 — cron-job.org가 매시간(16:30~04:30, 13회)
   workflow_dispatch를 호출하고(GitHub schedule은 보조), 매 실행이 스스로
   "오늘 대상일에 대해 지금 무엇을 보낼지"(초기/상향/정리(21:30)/반복-무발송)를 정한다. */
async function main() {
  const kmaKey = process.env.KMA_SERVICE_KEY;
  const kakaoRestKey = process.env.KAKAO_REST_KEY;
  const kakaoClientSecret = process.env.KAKAO_CLIENT_SECRET;
  const kakaoRefreshToken = process.env.KAKAO_REFRESH_TOKEN;
  const isManual = process.env.ICING_IS_MANUAL === 'true';

  if (!kmaKey) fail('KMA_SERVICE_KEY 시크릿이 없습니다.');
  if (!kakaoRestKey || !kakaoClientSecret || !kakaoRefreshToken) {
    fail('KAKAO_REST_KEY / KAKAO_CLIENT_SECRET / KAKAO_REFRESH_TOKEN 시크릿을 확인하세요.');
  }

  console.log(`실행 방식: ${isManual ? '수동 테스트' : '자동(정기)'}`);

  const icing = loadIcingModule(kmaKey);
  const nowMs = icing.icingKstNowMs();
  const nowDisplay = icing.icingFmtDateTime(nowMs);
  const kstHour = icing.icingKstDateParts(nowMs).h;
  const nowHHMM = nowDisplay.slice(11, 16);

  // 0) 감시 시간대(KST 16:00~05:00) 밖의 자동 실행(schedule·cron-job.org)은 판정·발송·기록 없이 바로 종료.
  //    수동 실행(Run workflow)만 시간과 관계없이 동작한다.
  const inMonitorWindow = kstHour >= 16 || kstHour < 5;
  if (!isManual && !inMonitorWindow) {
    console.log(`감시 시간대(16:00~05:00) 밖(KST ${kstHour}시) 자동 실행 — 바로 종료합니다.`);
    return;
  }

  runIcingTests();

  const target = computeTarget(icing, nowMs);
  const targetIso = icing.icingTargetIso(target);
  const seasonLog = loadSeasonLog(targetIso);

  // 1) 같은 시(hour)에 이미 실행된 기록이 있으면 아무것도 하지 않고 종료(수동 실행은 항상 진행)
  if (!isManual && alreadyRanThisHour(seasonLog, nowDisplay)) {
    console.log(`중복 실행 — ${nowDisplay.slice(0, 13)}시에 이미 실행된 기록이 있어 종료합니다.`);
    return;
  }

  // 2) 실행 공백 감지 — 감시 시간대(16:30~04:30) 안에서 직전 실행과 2시간 넘게 비면 이상 알림
  const gapReason = detectExecutionGap(seasonLog, nowMs, kstHour);
  if (gapReason) {
    await sendAnomalyAlert(kakaoRestKey, kakaoClientSecret, kakaoRefreshToken, gapReason, nowDisplay);
  }

  // 3) 실황 캐시 파일 → 인메모리 localStorage 시드(매시간 실행 간 기상청 재조회를 "새로 지난 시간"만으로 줄임)
  icing.__store.icing_obs_cache = JSON.stringify(loadObsCacheFile());

  let res;
  try {
    res = await icing.icingRunJudge(target);
  } catch (e) {
    console.log('판정 단계: (기상청 자료 조회 실패)');
    await sendAnomalyAlert(kakaoRestKey, kakaoClientSecret, kakaoRefreshToken, `기상청 자료 조회 실패: ${e.message}`, nowDisplay);
    try {
      saveObsCacheFile(pruneObsCache(JSON.parse(icing.__store.icing_obs_cache || '{}'), nowMs));
    } catch (e2) { /* 캐시 저장 실패는 치명적이지 않음 */ }
    fail('기상청 자료 조회 실패');
    return;
  }
  try {
    saveObsCacheFile(pruneObsCache(JSON.parse(icing.__store.icing_obs_cache || '{}'), nowMs));
  } catch (e) { console.log('실황 캐시 저장 실패(치명적이지 않음):', e.message); }

  console.log(`판정 단계: ${res.level_name}`);

  const maxAlerted = maxAlertedLevel(seasonLog, targetIso);
  const prior = lastAlertEntry(seasonLog, targetIso);

  let kind = null;
  if (res.level >= 2 && maxAlerted === 0) kind = 'initial';
  else if (res.level > maxAlerted) kind = 'escalate';
  else if (kstHour === 21 && maxAlerted >= 2 && res.level <= maxAlerted) kind = 'cleanup';

  let messages = null; // [[text, buttonTitle], ...] — 순서대로 연달아 발송
  if (isManual) {
    messages = res.level >= 2
      ? [[build1Message(res), '결빙예측 페이지'], [build2Message(res), '시간별 그래프 보기']]
      : [[buildCalmMessage(res), '결빙예측 페이지']];
  } else if (kind === 'initial') {
    messages = [[build1Message(res), '결빙예측 페이지'], [build2Message(res), '시간별 그래프 보기']];
  } else if (kind === 'escalate' || kind === 'cleanup') {
    messages = [[buildReassessMessage(res, prior, nowHHMM, kstHour), '결빙예측 페이지']];
  }

  if (!messages) {
    console.log(`발송: 조건 미충족(단계 ${res.level_name}, 이미 알린 최고 단계 ${maxAlerted}) — 보내지 않음`);
    appendIcingLog(res, isManual, kind, false, nowDisplay);
    return;
  }

  try {
    const accessToken = await refreshKakaoToken(kakaoRestKey, kakaoClientSecret, kakaoRefreshToken);
    for (const [text, buttonTitle] of messages) {
      // eslint-disable-next-line no-await-in-loop
      await sendKakaoMemo(accessToken, text, buttonTitle);
    }
  } catch (e) {
    appendIcingLog(res, isManual, kind, false, nowDisplay);
    await sendAnomalyAlert(kakaoRestKey, kakaoClientSecret, kakaoRefreshToken, `카카오 발송 실패: ${e.message}`, nowDisplay);
    fail(`카카오 메시지 전송 실패: ${e.message}`);
    return;
  }
  appendIcingLog(res, isManual, isManual ? null : kind, true, nowDisplay);
}

if (require.main === module) {
  main().catch(e => fail(e && e.message ? e.message : String(e)));
}

module.exports = {
  composeWithLimit, pickPrimaryType, hourRangeKo, tempRangeKo, formatBaseKo, snowRangeKo,
  build1Message, build2Message, buildCalmMessage, buildReassessMessage, buildReassessAction, describeChange,
  fmtHeaderDate, hourOnlyKo, precipPhrase, loadIcingModule,
  computeTarget, winterSeasonLabel, cautionReasonTag, appendIcingLog,
  loadSeasonLog, alreadyRanThisHour, maxAlertedLevel, lastAlertEntry, detectExecutionGap,
  sendAnomalyAlertCli,
};
