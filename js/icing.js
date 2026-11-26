/* ===================================================
   노면 결빙 예측 — tools/icing-ref/icing_rules.py 포팅
   판정 로직·기준값·화면 문구는 원본과 동일 (바꾸지 않음).
   기준값은 ICING_CONFIG 한 곳에서만 관리.
   격자(nx,ny)는 config.js의 CONFIG.NX/NY(사이트 기존 값, 96/76)를 그대로 사용 —
   여기서 쓰는 lat/lon은 격자 조회용이 아니라 일출 계산 전용.
   모든 시간 계산은 한국시간(KST, UTC+9) 기준 — 아래 icingKst* 함수들을 통해서만
   날짜/시각을 다루고, Date의 로컬 getter(getHours 등)는 "그 숫자가 이미 KST다"라고
   가정해도 되는 hourlyRows 변환 지점 한 곳에서만 쓴다. 그 외에는 전부 UTC getter로
   읽고 Date.UTC(...)로 만든 epoch를 "KST 벽시계"로 취급한다.
   =================================================== */

/* ---- 기준값 (icing_rules.py CONFIG) ---- */
const ICING_CONFIG = {
  A_rain_window_start: 12,
  A_min_rain_hours: 2,
  A_last_rain_hour: 18,
  A_freeze_temp: 0.0,
  A_max_dep: 2.5,
  DS_night_min_temp: 0.0,
  DS_precip_temp: 2.0,
  DS_min_precip_hours: 2,
  DS_max_dep: 4.5,
  early_sunrise: '07:00',
  recover_temp_09: 3.0,
  strong_wind_ms: 6.0,
  C3_wetbulb_freeze: 0.0,
  C3_rh_clamp_min: 5.0,
  C3_rh_clamp_max: 99.0,
  watch_temp: 2.0,
  lat: 35.1795, lon: 128.9382,
};

const ICING_LEVELS = {
  3: ['위험', '제설제 사전 살포 권고'],
  2: ['주의', '새벽 순찰로 결빙 여부 확인, 살포 대비'],
  1: ['관심', '결빙 조건에 근접, 예보 변화 확인'],
  0: ['정상', '결빙 조건 없음'],
};

const ICING_PTY_NAME = { 0: '', 1: '비', 2: '비/눈', 3: '눈', 4: '소나기' };
const ICING_SKY_NAME = { 1: '맑음', 3: '구름많음', 4: '흐림' };

/* ===================== KST 시간 유틸 ===================== */
/* Date.now()(순수 UTC epoch)에 9시간을 더해두면, 그 결과를 UTC getter로 읽을 때
   나오는 값이 항상 KST 벽시계 값과 같다 — 브라우저 로컬 시간대 설정과 무관. */
function icingKstNowMs() {
  return Date.now() + 9 * 3600000;
}

/* y,mo(0-based),d,h,mi를 "KST 벽시계"로 보고 그 값을 그대로 담은 epoch(ms)를 만든다 */
function icingKstMs(y, mo, d, h, mi) {
  return Date.UTC(y, mo, d, h || 0, mi || 0);
}

/* 기존 hourlyRows의 Date(.time)는 브라우저 로컬 getter로 만들어진 값이며,
   사이트 전역적으로 "그 숫자가 KST다"라고 가정하고 쓰고 있음(이 파일만의 예외 아님).
   그 가정을 한 번만 적용해 KST epoch로 변환한다. */
function icingMsFromLocalDate(dtLocal) {
  return icingKstMs(dtLocal.getFullYear(), dtLocal.getMonth(), dtLocal.getDate(), dtLocal.getHours());
}

function icingKstDateParts(ms) {
  const d = new Date(ms);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes() };
}

function icingPad2(n) { return String(n).padStart(2, '0'); }

function icingFmtYmd(ms) {
  const p = icingKstDateParts(ms);
  return `${p.y}-${icingPad2(p.mo + 1)}-${icingPad2(p.d)}`;
}

function icingFmtHm(ms) {
  const p = icingKstDateParts(ms);
  return `${icingPad2(p.h)}:${icingPad2(p.mi)}`;
}

/* "YYYY-MM-DD HH:MM" (icing_rules.py judge()의 hours[].dt 포맷과 동일) */
function icingFmtDateTime(ms) {
  const p = icingKstDateParts(ms);
  return `${p.y}-${icingPad2(p.mo + 1)}-${icingPad2(p.d)} ${icingPad2(p.h)}:${icingPad2(p.mi)}`;
}

/* "MM/DD HH시" (judge()의 last/first_risk_time 등 표시 포맷) */
function icingFmtMdH(ms) {
  const p = icingKstDateParts(ms);
  return `${icingPad2(p.mo + 1)}/${icingPad2(p.d)} ${icingPad2(p.h)}시`;
}

/* 정오 이후면 내일, 그 전이면 오늘 — {y,mo,d} 반환 (app.py default_target과 동일) */
function icingDefaultTarget(nowMs) {
  const p = icingKstDateParts(nowMs);
  const base = icingKstMs(p.y, p.mo, p.d, 0, 0);
  const add = p.h >= 12 ? 1 : 0;
  const t = base + add * 86400000;
  const tp = icingKstDateParts(t);
  return { y: tp.y, mo: tp.mo, d: tp.d };
}

function icingTargetToMs(target) { return icingKstMs(target.y, target.mo, target.d, 0, 0); }
function icingTargetIso(target) { return `${target.y}-${icingPad2(target.mo + 1)}-${icingPad2(target.d)}`; }

/* ===================== 보조 계산 (icing_rules.py 포팅) ===================== */
function icingDewpoint(t, rh) {
  if (t === null || t === undefined || rh === null || rh === undefined || rh <= 0) return null;
  const a = 17.62, b = 243.12;
  const g = Math.log(rh / 100.0) + (a * t) / (b + t);
  return (b * g) / (a - g);
}

/* NOAA 근사식에 의한 일출 시각(KST) — icing_rules.py sunrise()와 동일 */
function icingSunrise(targetMs, lat, lon) {
  lat = lat === undefined ? ICING_CONFIG.lat : lat;
  lon = lon === undefined ? ICING_CONFIG.lon : lon;
  const p = icingKstDateParts(targetMs);
  // 해당 날짜 KST 자정의 "진짜 날짜"로 연중 일수(n)를 구함
  const jan1 = Date.UTC(p.y, 0, 1);
  const n = Math.floor((icingKstMs(p.y, p.mo, p.d, 0, 0) - jan1) / 86400000) + 1;
  const g = (2 * Math.PI / 365) * (n - 1);
  const eq = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g)
             - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const dec = (0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g)
             - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g)
             - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g));
  const D = Math.PI / 180.0;
  const ha = (180 / Math.PI) * Math.acos(
    Math.cos(90.833 * D) / (Math.cos(lat * D) * Math.cos(dec)) - Math.tan(lat * D) * Math.tan(dec)
  );
  const m = 720 - 4 * (lon + ha) - eq + 540; // 분 단위, KST 자정 기준 오프셋(기존 식과 동일하게 +540)
  return icingKstMs(p.y, p.mo, p.d, 0, 0) + Math.round(m * 60000);
}

/* Python의 반올림(은행가 반올림, round-half-to-even)을 그대로 재현 —
   JS의 toFixed/Math.round는 .5 경계에서 반올림 방향이 달라 그대로 쓰면 문구가 어긋남 */
function icingPyRoundHalfEven(x, digits) {
  const factor = Math.pow(10, digits);
  const scaled = x * factor;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  let roundedAbsScaled;
  if (Math.abs(diff - 0.5) < 1e-9) {
    const evenFloor = (((floor % 2) + 2) % 2 === 0);
    roundedAbsScaled = evenFloor ? floor : floor + 1;
  } else {
    roundedAbsScaled = Math.round(scaled);
  }
  const abs = Math.abs(roundedAbsScaled) / factor;
  return x < 0 ? -abs : abs;
}

/* Python의 f"{x:.Nf}" 문자열 포맷과 동일(음수 0도 "-0"으로 표시) */
function icingPyFixed(x, digits) {
  const abs = Math.abs(icingPyRoundHalfEven(x, digits));
  const sign = x < 0 ? '-' : '';
  return sign + abs.toFixed(digits);
}

function icingIsPrecip(h) {
  return (h.pty || 0) > 0 || (h.pcp || 0) > 0;
}

/* Stull(2011) 근사식으로 습구온도 계산 (RH는 5~99%로 제한) — icing_rules.py wetbulb()와 동일 */
function icingWetbulb(t, rh) {
  if (t === null || t === undefined || rh === null || rh === undefined) return null;
  const rhC = Math.min(Math.max(rh, ICING_CONFIG.C3_rh_clamp_min), ICING_CONFIG.C3_rh_clamp_max);
  return t * Math.atan(0.151977 * Math.sqrt(rhC + 8.313659))
    + Math.atan(t + rhC) - Math.atan(rhC - 1.676331)
    + 0.00391838 * Math.pow(rhC, 1.5) * Math.atan(0.023101 * rhC)
    - 4.686035;
}

/* ===================== 판정 (icing_rules.py judge() 포팅) =====================
   hours: [{dt: KST epoch ms, T, RH, pty, pcp, wsd, sky, src}, ...]
   target: {y, mo, d} */
function icingJudge(hours, target) {
  const c = ICING_CONFIG;
  const d0 = icingTargetToMs(target);
  const H = 3600000;

  const by = {};
  hours.forEach(h => {
    if (h.T === null || h.T === undefined) return;
    const Td = icingDewpoint(h.T, h.RH);
    const Tw = icingWetbulb(h.T, h.RH);
    by[h.dt] = Object.assign({}, h, { Td, dep: Td === null ? null : (h.T - Td), Tw });
  });

  function rng(a, b) {
    return Object.keys(by).map(Number).filter(t => t >= a && t < b).sort((x, y) => x - y).map(t => by[t]);
  }

  const win = rng(d0 - 12 * H, d0 + 12 * H);
  const eve = rng(d0 - (24 - c.A_rain_window_start) * H, d0 + 6 * H);
  const morning = rng(d0, d0 + 9 * H);
  const night = rng(d0 - 6 * H, d0 + 10 * H);
  const day = rng(d0, d0 + 24 * H);
  const missing = 24 - win.length;

  const checks = [];

  // ---- 결빙형
  const eveRain = eve.filter(h => icingIsPrecip(h) && h.dt < d0);
  const rainAfter = eve.filter(h => icingIsPrecip(h));
  const last = rainAfter.length ? rainAfter[rainAfter.length - 1].dt : null;
  const lastHourOk = last !== null && last >= d0 - (24 - c.A_last_rain_hour) * H;
  const freeze = morning.filter(h => h.T <= c.A_freeze_temp && (last === null || h.dt > last));
  const deps = freeze.map(h => h.dep).filter(v => v !== null && v !== undefined);
  const depMin = deps.length ? Math.min(...deps) : null;
  const A = eveRain.length >= c.A_min_rain_hours && lastHourOk && freeze.length > 0
    && depMin !== null && depMin <= c.A_max_dep;
  checks.push({
    type: '결빙형', met: !!A,
    items: [
      ['전날 오후·저녁 비', eveRain.length >= c.A_min_rain_hours,
        `${eveRain.length}시간 (기준 ${c.A_min_rain_hours}시간 이상)`],
      ['비가 늦게 그침', lastHourOk,
        `마지막 강수 ${last !== null ? icingFmtMdH(last) : '없음'} (기준 ${c.A_last_rain_hour}시 이후)`],
      ['새벽 영하', freeze.length > 0,
        morning.length ? `00~08시 최저 ${icingPyFixed(Math.min(...morning.map(h => h.T)), 0)}℃` : '자료 없음'],
      ['결빙 시점 습함', depMin !== null && depMin <= c.A_max_dep,
        depMin !== null ? `기온-이슬점 차 ${icingPyFixed(depMin, 1)}℃ (기준 ${c.A_max_dep}℃ 이하)` : '해당 시간 없음'],
    ],
  });

  // ---- 강수형
  const tminNight = night.length ? Math.min(...night.map(h => h.T)) : null;
  const coldPr = day.filter(h => icingIsPrecip(h) && h.T <= c.DS_precip_temp);
  const prDeps = coldPr.map(h => h.dep).filter(v => v !== null && v !== undefined);
  const prDep = prDeps.length ? Math.min(...prDeps) : null;
  const DS = tminNight !== null && tminNight <= c.DS_night_min_temp
    && coldPr.length >= c.DS_min_precip_hours
    && prDep !== null && prDep <= c.DS_max_dep;
  const kinds = Array.from(new Set(coldPr.map(h => ICING_PTY_NAME[h.pty || 0] || ''))).filter(Boolean).sort();
  checks.push({
    type: '강수형', met: !!DS,
    items: [
      ['밤사이 노면 냉각', tminNight !== null && tminNight <= c.DS_night_min_temp,
        tminNight !== null ? `전날 18시~09시 최저 ${icingPyFixed(tminNight, 0)}℃ (기준 ${icingPyFixed(c.DS_night_min_temp, 0)}℃ 이하)` : '자료 없음'],
      ['영하 근처 강수 지속', coldPr.length >= c.DS_min_precip_hours,
        `${icingPyFixed(c.DS_precip_temp, 0)}℃ 이하 강수 ${coldPr.length}시간${kinds.length ? ' (' + kinds.join(', ') + ')' : ''} (기준 ${c.DS_min_precip_hours}시간 이상)`],
      ['강수 중 습함', prDep !== null && prDep <= c.DS_max_dep,
        prDep !== null ? `기온-이슬점 차 ${icingPyFixed(prDep, 1)}℃ (기준 ${c.DS_max_dep}℃ 이하)` : '해당 강수 없음'],
    ],
  });

  // ---- 증발냉각(주의) — 기온은 영상이지만 젖은 노면이 마르며 노면 온도를 떨어뜨리는 경우
  const afterLastRainMorning = morning.filter(h => last === null || h.dt > last);
  let wbMinHour = null;
  afterLastRainMorning.forEach(h => {
    if (h.Tw !== null && h.Tw !== undefined && (wbMinHour === null || h.Tw < wbMinHour.Tw)) wbMinHour = h;
  });
  const wbMin = wbMinHour ? wbMinHour.Tw : null;
  const C3 = eveRain.length >= c.A_min_rain_hours && lastHourOk
    && wbMin !== null && wbMin <= c.C3_wetbulb_freeze;
  checks.push({
    type: '증발냉각', met: !!C3,
    items: [
      ['전날 오후·저녁 비', eveRain.length >= c.A_min_rain_hours,
        `${eveRain.length}시간 (기준 ${c.A_min_rain_hours}시간 이상)`],
      ['비가 늦게 그침', lastHourOk,
        `마지막 강수 ${last !== null ? icingFmtMdH(last) : '없음'} (기준 ${c.A_last_rain_hour}시 이후)`],
      ['습구온도 영하', wbMin !== null && wbMin <= c.C3_wetbulb_freeze,
        wbMin !== null ? `00~08시 최저 습구온도 ${icingPyFixed(wbMin, 1)}℃ (기준 ${icingPyFixed(c.C3_wetbulb_freeze, 0)}℃ 이하)` : '해당 시간 없음'],
    ],
  });

  // ---- 단계 결정
  let level = (A || DS) ? 3 : 0;
  const downs = [];
  const downgrade_types = []; // 메시지 조합용 — 판정 자체에는 쓰이지 않는 부가 태그
  const sr = icingSunrise(d0, c.lat, c.lon);
  // 결빙 시간대(freeze) 평균풍속 — 하향 임계값을 넘든 안 넘든 메시지용으로 항상 계산해둔다(판정 분기는 그대로)
  const freezeWinds = freeze.map(h => h.wsd).filter(v => v !== null && v !== undefined);
  const freezeAvgWind = freezeWinds.length ? freezeWinds.reduce((s, v) => s + v, 0) / freezeWinds.length : null;
  if (level === 3) {
    const t09 = by[d0 + 9 * H];
    const skies = [7, 8, 9].map(k => (by[d0 + k * H] || {}).sky).filter(s => s !== undefined);
    const early = icingFmtHm(sr) <= c.early_sunrise;
    const clear = skies.length > 0 && skies.every(s => s === 1);
    const warm = t09 !== undefined && t09.T >= c.recover_temp_09;
    if (early && clear && warm && !DS) {
      level = 2;
      downs.push(`일출 ${icingFmtHm(sr)}로 이르고 07~09시 맑음, 09시 ${icingPyFixed(t09.T, 0)}℃ → 노면 조기 회복 예상`);
      downgrade_types.push('early_recovery');
    }
    if (A && !DS && freezeWinds.length && freezeAvgWind >= c.strong_wind_ms) {
      level = Math.min(level, 2);
      downs.push(`결빙 시간대 평균풍속 ${icingPyFixed(freezeAvgWind, 1)}m/s → 노면 건조 빠름`);
      downgrade_types.push('strong_wind');
    }
  } else if (C3) {
    level = 2;
  } else {
    const near = tminNight !== null && tminNight <= c.watch_temp
      && eve.concat(day.slice(0, 10)).some(h => icingIsPrecip(h));
    if (near) level = 1;
  }

  const firstFreeze = (A && freeze.length) ? freeze[0].dt : (DS ? (coldPr.length ? coldPr[0].dt : null) : null);
  const [name, action] = ICING_LEVELS[level];
  return {
    target: icingTargetIso(target),
    level, level_name: name, action,
    types: checks.filter(ck => ck.met).map(ck => ck.type),
    checks, downgrades: downs,
    first_risk_time: firstFreeze !== null ? icingFmtMdH(firstFreeze) : null,
    sunrise: icingFmtHm(sr),
    missing_hours: Math.max(missing, 0),
    hours: win.map(h => ({
      dt: icingFmtDateTime(h.dt), T: h.T, RH: h.RH,
      Td: h.Td === null || h.Td === undefined ? null : icingPyRoundHalfEven(h.Td, 1),
      pty: h.pty || 0, pty_name: ICING_PTY_NAME[h.pty || 0] || '',
      pcp: h.pcp || 0, wsd: h.wsd === undefined ? null : h.wsd,
      sky: h.sky === undefined ? null : h.sky, sky_name: ICING_SKY_NAME[h.sky] || '',
      src: h.src || '',
    })),
    /* ---- 아래부터는 메시지 작성용으로 추가한 항목(판정 로직에는 영향 없음) ---- */
    downgrade_types,
    sunrise_ms: sr,
    last_rain_ms: last,
    last_rain_time: last !== null ? icingFmtMdH(last) : null,
    morning_min_temp: morning.length ? icingPyRoundHalfEven(Math.min(...morning.map(h => h.T)), 0) : null,
    night_min_temp: tminNight === null ? null : icingPyRoundHalfEven(tminNight, 0),
    precip_kinds: kinds,
    freeze_avg_wind: freezeAvgWind === null ? null : icingPyRoundHalfEven(freezeAvgWind, 1),
    freeze_start_time: (A && freeze.length) ? icingFmtMdH(freeze[0].dt) : null,
    precip_start_time: (DS && coldPr.length) ? icingFmtMdH(coldPr[0].dt) : null,
    freeze_start_ms: (A && freeze.length) ? freeze[0].dt : null,
    precip_start_ms: (DS && coldPr.length) ? coldPr[0].dt : null,
  };
}

/* ===================== 초단기실황 지난 시간대 캐시 ===================== */
const ICING_OBS_CACHE_KEY = 'icing_obs_cache';

function icingLoadObsCache() {
  try { return JSON.parse(localStorage.getItem(ICING_OBS_CACHE_KEY) || '{}'); }
  catch (e) { return {}; }
}
function icingSaveObsCache(cache) {
  try { localStorage.setItem(ICING_OBS_CACHE_KEY, JSON.stringify(cache)); } catch (e) {}
}

/* 특정 KST 정시(ms)의 초단기실황 1건 조회 — getUltraSrtNcst 카테고리에는 SKY가 없어 sky는 항상 null */
async function icingFetchObsHour(ms) {
  const p = icingKstDateParts(ms);
  const base_date = `${p.y}${icingPad2(p.mo + 1)}${icingPad2(p.d)}`;
  const base_time = `${icingPad2(p.h)}00`;
  const items = await kmaFetch('getUltraSrtNcst', { base_date, base_time });
  const arr = Array.isArray(items) ? items : [items];
  const v = {};
  arr.forEach(i => { v[i.category] = i.obsrValue; });
  if (v.T1H === undefined) throw new Error('관측값 없음');
  const pcpRaw = v.RN1;
  const pcp = (pcpRaw === undefined || pcpRaw === '강수없음') ? 0
    : pcpRaw === '1mm 미만' ? 0.5
    : parseFloat(pcpRaw) || 0;
  return {
    T: parseFloat(v.T1H),
    RH: v.REH !== undefined ? parseFloat(v.REH) : null,
    pty: parseInt(v.PTY || '0'),
    pcp,
    wsd: v.WSD !== undefined ? parseFloat(v.WSD) : null,
    sky: null,
    src: '실황',
  };
}

/* 판정 구간(대상일 전날 12시 ~ 대상일 24시)의 시간별 자료 모으기.
   이미 지난 정시는 초단기실황(캐시 우선), 나머지는 단기예보. 겹치면 실황 우선. */
async function icingCollectHours(target, forecastHourlyRows) {
  const H = 3600000;
  const d0 = icingTargetToMs(target);
  const winStart = d0 - 12 * H;
  const winEnd = d0 + 24 * H;
  const nowMs = icingKstNowMs();

  const hours = {};

  // 1) 단기예보로 구간 전체를 우선 채움
  (forecastHourlyRows || []).forEach(r => {
    const ms = icingMsFromLocalDate(r.time);
    if (ms >= winStart && ms < winEnd) {
      hours[ms] = { dt: ms, T: r.tmp, RH: r.reh, pty: r.pty, pcp: r.pcp, wsd: r.wsd, sky: r.sky, src: '예보' };
    }
  });

  // 2) 이미 지난 정시는 초단기실황으로 덮어씀 (겹치면 실황 우선)
  const cache = icingLoadObsCache();
  const pastEnd = Math.min(winEnd, nowMs);
  for (let ms = winStart; ms < pastEnd; ms += H) {
    const key = String(ms);
    if (cache[key]) { hours[ms] = Object.assign({ dt: ms }, cache[key]); continue; }
    try {
      const obs = await icingFetchObsHour(ms);
      cache[key] = obs;
      icingSaveObsCache(cache);
      hours[ms] = Object.assign({ dt: ms }, obs);
    } catch (e) {
      // 실황 조회 실패 — 예보값이 이미 있으면 그대로 두고, 없으면 결측으로 남김(judge()의 missing_hours에 반영됨)
    }
  }

  return Object.keys(hours).map(Number).sort((a, b) => a - b).map(ms => hours[ms]);
}

/* ===================== 판정 기록 (localStorage 로그 + CSV 다운로드) ===================== */
const ICING_LOG_KEY = 'icing_log';

function icingLoadLog() {
  try { return JSON.parse(localStorage.getItem(ICING_LOG_KEY) || '[]'); }
  catch (e) { return []; }
}

function icingAppendLog(res, baseDisplay) {
  try {
    const log = icingLoadLog();
    log.push({
      판정시각: icingFmtDateTime(icingKstNowMs()),
      예보발표: baseDisplay || '',
      대상일: res.target,
      단계: res.level_name,
      유형: res.types.join('/'),
      하향사유: res.downgrades.join('; '),
    });
    localStorage.setItem(ICING_LOG_KEY, JSON.stringify(log));
  } catch (e) {}
}

function icingDownloadLogCsv() {
  const log = icingLoadLog();
  const header = ['판정시각', '예보발표', '대상일', '단계', '유형', '하향사유'];
  const esc = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const lines = [header.join(',')].concat(log.map(r => header.map(k => esc(r[k])).join(',')));
  const csv = '﻿' + lines.join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = '판정기록.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* ===================== 메인 진입점 ===================== */
/* target이 없으면 기본 대상일(정오 이후 내일, 그 전 오늘) 사용.
   반환값은 icing_rules.py judge() 결과에 base/grid/now/default_target/criteria를 더한 것
   (app.py api_judge()와 동일한 형태) */
async function icingRunJudge(target) {
  await CONFIG.ready;
  const nowMs = icingKstNowMs();
  target = target || icingDefaultTarget(nowMs);

  const data = await fetchWeatherData('normal');
  const hours = await icingCollectHours(target, data.hourlyRows || []);
  const res = icingJudge(hours, target);
  res.base = data.baseTimeDisplay || '-';
  res.grid = `${CONFIG.NX},${CONFIG.NY}`;
  res.now = icingFmtDateTime(nowMs);
  res.default_target = icingTargetIso(icingDefaultTarget(nowMs));
  res.criteria = Object.assign({}, ICING_CONFIG);
  delete res.criteria.lat;
  delete res.criteria.lon;

  icingAppendLog(res, res.base);
  return res;
}

/* ===================== Node 환경 내보내기 =====================
   브라우저(<script> 태그)에서는 module이 없으므로 이 블록은 실행되지 않는다 —
   사이트(icing.html) 동작에는 아무 영향이 없다. GitHub Actions 등 Node에서
   이 파일을 재사용(판정 로직을 복사/수정하지 않고 그대로)할 때만 쓰인다. */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ICING_CONFIG, ICING_LEVELS, ICING_PTY_NAME, ICING_SKY_NAME,
    icingKstNowMs, icingKstMs, icingKstDateParts, icingDefaultTarget,
    icingTargetToMs, icingTargetIso, icingFmtMdH, icingFmtHm, icingFmtDateTime,
    icingDewpoint, icingWetbulb, icingSunrise, icingJudge,
    icingCollectHours, icingFetchObsHour,
    icingRunJudge,
  };
}
