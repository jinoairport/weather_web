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

/* "MM/DD HH시" -> "DD일 HH시" (시각은 2자리 그대로 유지) */
function dayHourKo(mdH) {
  if (!mdH) return null;
  const m = mdH.match(/^(\d{2})\/(\d{2}) (\d{2})시$/);
  if (!m) return mdH;
  return `${parseInt(m[2], 10)}일 ${m[3]}시`;
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

/* ===================== 5. 메시지 조합 (16:30) ===================== */
function buildRiskCauseAndPlan(res) {
  /* 결빙형/강수형 중 어떤 문구를 쓸지 — 둘 다 해당하면 결빙 시작이 빠른 쪽 */
  const hasA = res.types.includes('결빙형');
  const hasDS = res.types.includes('강수형');
  let useA = hasA;
  if (hasA && hasDS) {
    useA = (res.freeze_start_ms != null && res.precip_start_ms != null)
      ? res.freeze_start_ms <= res.precip_start_ms
      : hasA;
  }

  if (useA) {
    return {
      cause: `${dayHourKo(res.last_rain_time) || '전날'}까지 내린 비로 노면이 젖은 상태에서 `
        + `새벽 기온 ${res.morning_min_temp}℃까지 하강`,
      expect: `${hourOnlyKo(res.freeze_start_time) || '새벽'}경부터 노면 결빙, `
        + `일출(${res.sunrise}) 이후 해소`,
      action: '제설제 살포인원 05시 조기출근, 결빙 취약구간 제설제 사전 살포',
    };
  }
  const precipTemp = (res.criteria && res.criteria.DS_precip_temp != null) ? res.criteria.DS_precip_temp : 2;
  return {
    cause: `밤사이 ${res.night_min_temp}℃로 노면이 냉각된 상태에서 `
      + `${hourOnlyKo(res.precip_start_time) || '새벽'}경부터 0~${precipTemp}℃의 `
      + `${precipPhrase(res.precip_kinds)} 예보`,
    expect: '강수와 동시에 노면 결빙',
    action: '제설제 살포인원 05시 조기출근, 강수 시작 즉시 취약구간 제설제 살포',
  };
}

function buildCautionCauseAndAction(res) {
  if (res.downgrade_types.includes('early_recovery')) {
    return {
      cause: `비 그친 뒤 새벽 ${res.morning_min_temp}℃까지 하강하나, `
        + `맑은 날씨·이른 일출(${res.sunrise})로 일출 전후 노면 회복 예상`,
      action: '조기출근 없음, 출근 즉시 결빙 취약구간 순찰 후 결빙 시 국부 살포',
    };
  }
  // strong_wind (또는 그 외 알 수 없는 하향 사유 — 안전하게 강풍 문구로 폴백)
  return {
    cause: `비 그친 뒤 새벽 ${res.morning_min_temp}℃까지 하강하나, `
      + `강풍(평균 ${res.freeze_avg_wind}m/s)으로 노면이 빨리 말라 결빙 가능성 낮음`,
    action: '조기출근 없음, 출근 즉시 결빙 취약구간 순찰 후 결빙 시 국부 살포',
  };
}

function build1630Message(res) {
  const header = fmtHeaderDate(res.target);
  if (res.level === 3) {
    const { cause, expect, action } = buildRiskCauseAndPlan(res);
    return composeWithLimit([
      { text: `[김해공항 노면결빙 예보] ${header} 새벽 「위험」` },
      { text: `■원인: ${cause}`, trimmable: true },
      { text: `■예상: ${expect}` },
      { text: `■조치: ${action}` },
      { text: '※21시 재판정 결과 추가 통보' },
    ]);
  }
  // level === 2 (주의)
  const { cause, action } = buildCautionCauseAndAction(res);
  return composeWithLimit([
    { text: `[김해공항 노면결빙 예보] ${header} 새벽 「주의」` },
    { text: `■원인: ${cause}`, trimmable: true },
    { text: `■조치: ${action}` },
    { text: '※21시 재판정에서 「위험」 상향 시 05시 조기출근 전환' },
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

function build2100Message(kind, res, prior) {
  const header = fmtHeaderDate(res.target);
  if (kind === 'new') {
    // 16:30 형식과 같되 첫 줄 끝에 "(21시 신규)"를 붙인다
    const base = build1630Message(res);
    const lines = base.split('\n');
    lines[0] = lines[0] + '(21시 신규)';
    return lines.join('\n');
  }

  let title, action;
  if (kind === 'up') {
    title = `${header} 새벽 ${levelBracket(prior.level_name)}→${levelBracket(res.level_name)} 상향`;
    action = res.level === 3
      ? '제설제 살포인원 05시 조기출근으로 전환'
      : '조기출근 없음, 출근 즉시 순찰 유지';
  } else if (kind === 'down') {
    title = `${header} 새벽 ${levelBracket(prior.level_name)}→${levelBracket(res.level_name)} 하향`;
    action = res.level === 2
      ? '05시 조기출근 취소, 출근 즉시 순찰'
      : '결빙 가능성 낮아져 조기출근·순찰 해제';
  } else { // keep
    title = `${header} 새벽 ${levelBracket(res.level_name)} 유지`;
    action = res.level === 3 ? '05시 조기출근 유지' : '조기출근 없음, 출근 즉시 순찰 유지';
  }

  const cause = describeChange(prior, res);

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
async function sendKakaoMemo(accessToken, text) {
  const template = {
    object_type: 'text',
    text,
    link: { web_url: LINK, mobile_web_url: LINK },
    button_title: '상세 판정 보기',
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
  let message = null;

  if (isManual) {
    shouldSend = true;
    message = res.level >= 2 ? build1630Message(res) : buildCalmMessage(res);
  } else if (slot === 'eve') {
    shouldSend = res.level >= 2;
    if (shouldSend) message = build1630Message(res);
  } else {
    // night
    const prior = loadPriorState();
    const priorRisk = prior ? prior.level >= 2 : false;
    const nowRisk = res.level >= 2;
    let kind = null;
    if (!prior) {
      kind = nowRisk ? 'new' : null;
    } else if (!priorRisk && nowRisk) {
      kind = 'new';
    } else if (priorRisk) {
      kind = res.level > prior.level ? 'up' : (res.level < prior.level ? 'down' : 'keep');
    }
    if (kind) {
      shouldSend = true;
      message = build2100Message(kind, res, prior);
    }
  }

  // 16:30 슬롯은 발송 여부와 무관하게 상태를 남겨 21시가 비교할 수 있게 한다
  if (slot === 'eve') saveState(res);

  if (!shouldSend) {
    console.log('발송: 조건 미충족 — 보내지 않음');
    return;
  }

  const accessToken = await refreshKakaoToken(kakaoRestKey, kakaoClientSecret, kakaoRefreshToken);
  await sendKakaoMemo(accessToken, message);
}

if (require.main === module) {
  main().catch(e => fail(e && e.message ? e.message : String(e)));
}

module.exports = {
  composeWithLimit, buildRiskCauseAndPlan, buildCautionCauseAndAction,
  build1630Message, buildCalmMessage, build2100Message, describeChange,
  fmtHeaderDate, dayHourKo, hourOnlyKo, precipPhrase, loadIcingModule,
  computeTomorrowTarget,
};
