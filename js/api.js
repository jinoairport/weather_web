/* ===================================================
   기상청 오픈API 연동 모듈
   단기예보 + 초단기예보 조회
   API 키 없으면 목업 데이터 사용
   =================================================== */

const KMA_BASE = 'https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0';

/* 기상청 API 공통 호출 (429/5xx 오류 시 재시도) */
async function kmaFetch(endpoint, params, _retry = true) {
  const url = new URL(`${KMA_BASE}/${endpoint}`);
  const apiKey = CONFIG.API_KEY.includes('%') ? decodeURIComponent(CONFIG.API_KEY) : CONFIG.API_KEY;
  url.searchParams.set('serviceKey', apiKey);
  url.searchParams.set('numOfRows', '1500');
  url.searchParams.set('pageNo', '1');
  url.searchParams.set('dataType', 'JSON');
  url.searchParams.set('base_date', params.base_date);
  url.searchParams.set('base_time', params.base_time);
  url.searchParams.set('nx', CONFIG.NX);
  url.searchParams.set('ny', CONFIG.NY);

  const res = await fetch(url.toString());
  if (!res.ok) {
    if (_retry && (res.status >= 500 || res.status === 429)) {
      const delay = res.status === 429 ? 5000 : 2000;
      await new Promise(r => setTimeout(r, delay));
      return kmaFetch(endpoint, params, false);
    }
    throw new Error(`HTTP ${res.status}`);
  }
  const json = await res.json();
  const code = json?.response?.header?.resultCode;
  if (code !== '00') throw new Error(`KMA 오류코드: ${code}`);
  // items가 null이거나 없을 때 빈 배열 반환
  return json?.response?.body?.items?.item ?? [];
}

/* 단기예보 발표시각 계산 (02,05,08,11,14,17,20,23시)
   기상청 발표 후 약 10분이면 데이터 생성 완료 → 10분 버퍼 적용 */
function getBaseTime() {
  const now      = new Date();
  const totalMin = now.getHours() * 60 + now.getMinutes();
  const baseHours = [2, 5, 8, 11, 14, 17, 20, 23];
  const BUF = 10;
  let base = 23;
  for (const bh of baseHours) {
    if (totalMin >= bh * 60 + BUF) base = bh;
  }
  const pad = (n) => String(n).padStart(2, '0');
  const d = new Date(now);
  if (base === 23 && now.getHours() < 3) d.setDate(d.getDate() - 1);
  const dateStr = `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}`;
  const timeStr = `${pad(base)}00`;
  return { base_date: dateStr, base_time: timeStr };
}

/* 단기예보 파싱 → 날짜별 / 시간별 구조 변환 */
function parseVilageFcst(items) {
  const byDT = {};
  for (const it of items) {
    const key = it.fcstDate + it.fcstTime;
    if (!byDT[key]) byDT[key] = { date: it.fcstDate, time: it.fcstTime };
    byDT[key][it.category] = it.fcstValue;
  }

  const hourlyRows = Object.values(byDT)
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))
    .map(r => {
      const y = parseInt(r.date.slice(0,4));
      const mo = parseInt(r.date.slice(4,6)) - 1;
      const d  = parseInt(r.date.slice(6,8));
      const h  = parseInt(r.time.slice(0,2));
      const t  = new Date(y, mo, d, h);

      const pty    = parseInt(r.PTY || '0');
      const sky    = parseInt(r.SKY || '1');
      const pcpRaw = r.PCP || '강수없음';
      const pcp    = pcpRaw === '강수없음' ? 0
                   : pcpRaw === '1mm 미만' ? 0.5
                   : parseFloat(pcpRaw) || 0;

      return {
        time:   t,
        tmp:    parseInt(r.TMP || '20'),
        feels:  parseInt(r.TMP || '20') - 1,
        sky,  pty,
        pop:    parseInt(r.POP || '0'),
        pcpRaw,
        pcp,
        vec:    parseInt(r.VEC || '180'),
        wsd:    parseFloat(r.WSD || '2'),
        reh:    parseInt(r.REH || '60'),
        dam:    '-',
      };
    });

  // 날짜별 집계 — 오전/오후 각각 최악 날씨(최대 PTY, 동률이면 최대 SKY) 반영
  const dailyMap = {};
  for (const r of hourlyRows) {
    const key = r.time.toDateString();
    if (!dailyMap[key]) {
      dailyMap[key] = {
        date: r.time, amSky:1, amPty:0, amPop:0, pmSky:1, pmPty:0, pmPop:0,
        tmin: 99, tmax: -99,
      };
    }
    const dm = dailyMap[key];
    const h  = r.time.getHours();
    dm.tmin = Math.min(dm.tmin, r.tmp);
    dm.tmax = Math.max(dm.tmax, r.tmp);
    if (h < 12) {
      // 오전: 강수형태 더 심한 것 우선, 같으면 하늘상태 더 나쁜 것 우선
      if (r.pty > dm.amPty || (r.pty === dm.amPty && r.sky > dm.amSky)) {
        dm.amSky = r.sky; dm.amPty = r.pty;
      }
      dm.amPop = Math.max(dm.amPop, r.pop);
    } else {
      if (r.pty > dm.pmPty || (r.pty === dm.pmPty && r.sky > dm.pmSky)) {
        dm.pmSky = r.sky; dm.pmPty = r.pty;
      }
      dm.pmPop = Math.max(dm.pmPop, r.pop);
    }
  }

  const dailyRows = Object.values(dailyMap).slice(0, 11);
  return { dailyRows, hourlyRows };
}

/* 초단기예보 발표시각 계산 — 매시 30분 발표 */
function getNcstBaseTime() {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const d   = new Date(now);
  if (now.getMinutes() < 30) d.setHours(d.getHours() - 1);
  return {
    base_date: `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}`,
    base_time: `${pad(d.getHours())}30`,
  };
}

/* 초단기예보 조회 — 전국 격자 커버, SKY·T1H 포함 */
async function fetchUltraNcst() {
  const { base_date, base_time } = getNcstBaseTime();
  const items = await kmaFetch('getUltraSrtFcst', { base_date, base_time });
  const arr = Array.isArray(items) ? items : [items];
  const nearestTime = [...new Set(arr.map(i => i.fcstTime))].sort()[0];
  const raw = {};
  arr.filter(i => i.fcstTime === nearestTime).forEach(i => {
    const v = parseFloat(i.fcstValue);
    if (!isNaN(v) && v !== -999) raw[i.category] = v;
    else if (isNaN(v))           raw[i.category] = i.fcstValue;
  });

  const pty    = raw.PTY || 0;
  const rn1Raw = raw.RN1 || '강수없음';
  const rn1    = rn1Raw === '강수없음' ? 0
               : rn1Raw === '1mm 미만' ? 0.5
               : parseFloat(rn1Raw) || 0;

  return {
    tmp:  raw.T1H  ?? 20,
    rn1,
    rn1Raw,
    reh:  raw.REH  ?? 60,
    wsd:  raw.WSD  ?? 0,
    vec:  raw.VEC  ?? 180,
    pty,
    baseTime: base_time,
  };
}

/* 현재 선택 공항의 특보 매칭 키워드 배열 반환 */
function getCurrentWrnKeys() {
  const code = localStorage.getItem('airport_code') || 'PUS';
  const apt  = (typeof AIRPORTS !== 'undefined') ? AIRPORTS.find(a => a.code === code) : null;
  if (!apt) return ['부산'];
  return (apt.wrnKeys && apt.wrnKeys.length) ? apt.wrnKeys : [apt.wrnCity || '부산'];
}

/* 해상 전용 특보 — 공항 운영과 무관하므로 매칭에서 제외 */
var MARITIME_WARN_TITLES = ['풍랑', '해일', '지진해일'];

/* 특보/예비특보 공통 필터 — wrnKeys 배열 내 배열(AND 조건) 지원
   dedup 기준: 더 구체적인 키워드로 매칭된 것 우선 (AND > 긴 단일 > 짧은 단일),
   구체성이 같을 때만 높은 단계(경보 > 주의보)로 선택 */
function filterByCity(arr, keys) {
  var keyArr = Array.isArray(keys) ? keys : [keys];

  function calcSpec(targets) {
    return keyArr.reduce(function(max, kw) {
      var s = 0;
      if (Array.isArray(kw)) {
        s = kw.every(function(k) { return k && targets.includes(k); })
          ? kw.reduce(function(sum, k) { return sum + k.length; }, 0)
          : 0;
      } else {
        s = (kw && targets.includes(kw)) ? kw.length : 0;
      }
      return Math.max(max, s);
    }, 0);
  }

  var matchedWithSpec = [];
  arr.forEach(function(w) {
    var title = w.wrnTitle || '';
    if (MARITIME_WARN_TITLES.some(function(t) { return title.includes(t); })) return;
    var targets = [w.wrnStnm, w.area, w.areaFc, w.wrnTitle].filter(Boolean).join(' ');
    var spec = calcSpec(targets);
    if (spec > 0) matchedWithSpec.push({ w: w, spec: spec });
  });

  /* 같은 유형: 더 구체적인 매칭 우선, 구체성 동률이면 높은 단계 우선 */
  var best = {};
  matchedWithSpec.forEach(function(item) {
    var title = item.w.wrnTitle || '';
    var type  = title.replace('경보', '').replace('주의보', '').replace('예비', '').trim();
    var rank  = title.includes('경보') ? 2 : 1;
    var ex    = best[type];
    if (!ex || item.spec > ex._spec || (item.spec === ex._spec && rank > ex._rank)) {
      best[type] = Object.assign({}, item.w, { _spec: item.spec, _rank: rank });
    }
  });
  return Object.values(best).map(function(w) {
    var r = Object.assign({}, w); delete r._spec; delete r._rank; return r;
  });
}

/* 기상청 기상특보 조회 (429/5xx 시 재시도) */
async function fetchWeatherWarning(_retry = true) {
  const city = getCurrentWrnKeys();
  const url  = new URL('https://apis.data.go.kr/1360000/WthrWrnInfoService/getWthrWrnMsg');
  url.searchParams.set('serviceKey', CONFIG.API_KEY);
  url.searchParams.set('pageNo',    '1');
  url.searchParams.set('numOfRows', '50');
  url.searchParams.set('dataType',  'JSON');

  const res = await fetch(url.toString());
  if (!res.ok) {
    if (_retry && (res.status >= 500 || res.status === 429)) {
      const delay = res.status === 429 ? 5000 : 2000;
      await new Promise(r => setTimeout(r, delay));
      return fetchWeatherWarning(false);
    }
    return [];
  }
  const json = await res.json();
  if (json?.response?.header?.resultCode !== '00') return [];

  const items = json?.response?.body?.items?.item;
  if (!items) return [];
  const arr = Array.isArray(items) ? items : [items];
  return filterByCity(arr, city);
}

/* localStorage 캐시 — 페이지 재로드 시에도 이전 데이터 복원 */
const _LS_KEY = 'kma_wx_cache';
const _LS_TTL = 60 * 60 * 1000; // 1시간 이내 캐시 유효

function _saveCache(data) {
  try {
    localStorage.setItem(_LS_KEY, JSON.stringify({
      baseTimeDisplay: data.baseTimeDisplay,
      weatherWarnings: data.weatherWarnings || [],
      hourlyRows: data.hourlyRows.map(r => ({ ...r, time: r.time.toISOString() })),
      dailyRows:  data.dailyRows.map(r =>  ({ ...r, date: r.date.toISOString() })),
      ncstData:   data.ncstData || null,
      _at: Date.now(),
    }));
  } catch(e) {}
}

function _loadCache() {
  try {
    const raw = localStorage.getItem(_LS_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw);
    if (Date.now() - c._at > _LS_TTL) return null;
    c.hourlyRows = c.hourlyRows.map(r => ({ ...r, time: new Date(r.time) }));
    c.dailyRows  = c.dailyRows.map(r =>  ({ ...r, date: new Date(r.date) }));
    c.generatedAt = new Date(c._at);
    c.isReal = true;
    return c;
  } catch(e) { return null; }
}

let _lastGoodData  = _loadCache();
let _lastGoodStale = false; // ⚠ 표시 중복 방지 플래그

/* 메인 데이터 페치 */
async function fetchWeatherData(mode) {
  if (!CONFIG.API_KEY) {
    console.info('API 키 없음 → 목업 데이터 사용');
    return { ...buildMockData(mode), isReal: false, baseTimeDisplay: '목업', weatherWarnings: [] };
  }

  try {
    const { base_date, base_time } = getBaseTime();
    const baseTimeDisplay = `${base_date.slice(4,6)}/${base_date.slice(6,8)} ${base_time.slice(0,2)}:00 발표`;

    const [items, warnings, ncst] = await Promise.allSettled([
      kmaFetch('getVilageFcst', { base_date, base_time }),
      fetchWeatherWarning(),
      fetchUltraNcst(),
    ]);

    if (items.status === 'rejected') throw new Error(items.reason?.message || 'API 실패');

    const { dailyRows, hourlyRows } = parseVilageFcst(items.value);
    const weatherWarnings = warnings.status === 'fulfilled' ? warnings.value : [];
    const ncstData = ncst.status === 'fulfilled' ? ncst.value : null;

    _lastGoodData  = { dailyRows, hourlyRows, generatedAt: new Date(), isReal: true, baseTimeDisplay, weatherWarnings, ncstData };
    _lastGoodStale = false;
    _saveCache(_lastGoodData);
    return _lastGoodData;
  } catch (err) {
    console.warn('[KMA API 오류]', err.message);
    if (_lastGoodData) {
      console.info('[KMA] 일시 오류 — 이전 데이터 유지');
      // ⚠ 중복 방지: 이미 stale 상태이면 baseTimeDisplay에 ⚠ 재추가 안 함
      const display = _lastGoodStale
        ? _lastGoodData.baseTimeDisplay
        : `⚠${_lastGoodData.baseTimeDisplay}`;
      _lastGoodStale = true;
      return { ..._lastGoodData, baseTimeDisplay: display };
    }
    console.error('API키 설정 확인: ⚙ 설정 → 기상청 오픈API 서비스키 입력 (data.go.kr)');
    return { ...buildMockData(mode), isReal: false, baseTimeDisplay: '⚠목업', weatherWarnings: [] };
  }
}
