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
   기상청 데이터 준비 시간 약 2~3분 → 5분 버퍼 적용 */
function getBaseTime() {
  const now      = new Date();
  const totalMin = now.getHours() * 60 + now.getMinutes();
  const baseHours = [2, 5, 8, 11, 14, 17, 20, 23];
  const BUF = 5;
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

/* 도명 약어 → 전체명 / 광역시 최상위 매칭 (overview.js _kwInRegion와 동일 로직) */
/* KMA API: t6 region이 약어(경남)·전체명(경상남도) 혼용 → 둘 다 체크 */
var _PROV_ALIAS = { '경남':'경상남도','경북':'경상북도','전남':'전라남도','전북':'전라북도','충남':'충청남도','충북':'충청북도' };
var _METRO_SET  = { '서울':1,'부산':1,'대구':1,'인천':1,'광주':1,'대전':1,'울산':1,'세종':1 };
function _kwInRegion(kw, full, top, isExcl) {
  if (_PROV_ALIAS[kw]) return top.includes(_PROV_ALIAS[kw]) || top.includes(kw);
  if (_METRO_SET[kw])  return top.includes(kw);
  if (!isExcl) return full.includes(kw);
  /* 제외형: '부산(부산동부 제외)' 처리
     - kw가 제외 목록에 있거나 제외 항목의 하위 단위면 → 불일치
     - kw가 부모 지역(top)의 하위 구역이고 제외되지 않았으면 → 일치
     예) kw='부산서부', top='부산', 제외='부산동부' → 일치 ✓
         kw='부산동부', 제외='부산동부' → 불일치 ✓
         kw='사천읍',  top='경상남도', 제외='사천' → 불일치('사천읍'.startsWith('사천')) ✓ */
  var em = full.match(/\(([^)]+제외)\)/);
  if (em) {
    var exclPart = em[1].replace(/\s*제외$/, '').trim();
    var exclList = exclPart.split(/\s*,\s*/);
    if (exclList.some(function(e) { e = e.trim(); return e && (e === kw || kw.startsWith(e)); })) return false;
    var topTokens = top.trim().split(/\s+/);
    if (topTokens.some(function(t) { return t.length >= 2 && kw.startsWith(t); })) return true;
  }
  return top.includes(kw);
}
/* 괄호 깊이 인식 쉼표 분리 — '부산(부산중부, 부산서부)'를 하나의 세그먼트로 유지 */
function splitRegion(s) {
  var segs = [], depth = 0, cur = '';
  for (var i = 0; i < s.length; i++) {
    var ch = s[i];
    if (ch === '(') { depth++; cur += ch; }
    else if (ch === ')') { depth--; cur += ch; }
    else if (ch === ',' && depth === 0) { if (cur.trim()) segs.push(cur.trim()); cur = ''; }
    else { cur += ch; }
  }
  if (cur.trim()) segs.push(cur.trim());
  return segs;
}

/* 특보/예비특보 공통 필터 — wrnKeys 배열 내 배열(AND 조건) 지원
   dedup 기준:
   ① 더 구체적인 키워드로 매칭된 것 우선 (AND > 긴 단일 > 짧은 단일)
   ② 구체성 동률이면 높은 단계 우선 (중대경보>경보>주의보>예비) — 시/군 명시된 주의보는 spec 2배로 자동 우선 */
function filterByCity(arr, keys) {
  var keyArr = Array.isArray(keys) ? keys : [keys];

  function calcSpec(targets) {
    var top = targets.replace(/\([^()]*\)/g, '').replace(/[()]/g, '');
    /* 복합 문자열(t6+t2+area 결합)에 isExcl 적용 불가 — 다른 특보 "제외" 텍스트로
       인해 포함형 지역 매칭이 깨질 수 있음 → isExcl=false 고정(full 검색)
       세그먼트별 isExcl은 matchSpecAndKey(폭염), aptMatchSpec(전체현황)에서 처리 */
    return keyArr.reduce(function(max, kw) {
      var s = 0;
      if (Array.isArray(kw)) {
        s = kw.every(function(k) { return k && _kwInRegion(k, targets, top, false); })
          ? kw.reduce(function(sum, k) { return sum + k.length; }, 0)
          : 0;
      } else {
        if (!kw || !_kwInRegion(kw, targets, top, false)) { return max; }
        /* 도명약어/광역시 = 광역 매칭(coarse) → kw.length
           일반 시·군·구·읍 = 세부 매칭(fine) → kw.length * 2 */
        s = (_PROV_ALIAS[kw] || _METRO_SET[kw]) ? kw.length : kw.length * 2;
      }
      return Math.max(max, s);
    }, 0);
  }

  var matchedWithSpec = [];
  arr.forEach(function(w) {
    var title = w.wrnTitle || '';
    if (MARITIME_WARN_TITLES.some(function(t) { return title.includes(t); })) return;
    /* t6=현재 특보 지역목록, t2=지역 요약, area/areaFc=지역 필드
       wrnStnm(발표기관 "부산지방기상청")·wrnTitle은 제외 → '부산' 키워드에 경남 경보가 오매칭되는 근본 원인 차단 */
    var targets = [w.t6, w.t2, w.area, w.areaFc].filter(Boolean).join(' ');
    var spec = calcSpec(targets);
    if (spec > 0) matchedWithSpec.push({ w: w, spec: spec });
  });

  /* rank: 예비특보=1, 주의보=2, 경보=3, 중대경보=4 */
  var best = {};
  matchedWithSpec.forEach(function(item) {
    var title = item.w.wrnTitle || '';
    /* 중대경보 먼저 제거 → '폭염중대경보' → '폭염' 올바르게 추출 */
    var type  = title.replace('중대경보', '').replace('예비특보', '').replace('경보', '').replace('주의보', '').replace('예비', '').replace('특보', '').trim();
    var rank  = title.includes('예비') ? 1 : title.includes('주의보') ? 2 : title.includes('중대경보') ? 4 : title.includes('경보') ? 3 : 0;
    var ex    = best[type];
    /* 더 구체적인 매칭이 우선; 동점이면 높은 단계 유지 (시/군명 주의보는 spec 2배로 자동 우선) */
    if (!ex || item.spec > ex._spec || (item.spec === ex._spec && rank > ex._rank)) {
      best[type] = Object.assign({}, item.w, { _spec: item.spec, _rank: rank });
    }
  });
  return Object.values(best).map(function(w) {
    var r = Object.assign({}, w); delete r._spec; delete r._rank; return r;
  });
}

/* 폭염특보 전용 조회 — getWthrWrnList → getWthrWrnMsg(stnId) 경유
   stnId 미지정 getWthrWrnMsg 응답에 폭염이 누락되는 경우를 보완 */
async function _fetchHeatWarns(wrnKeys) {
  var keyArr = Array.isArray(wrnKeys) ? wrnKeys : [wrnKeys];

  /* spec + 매칭된 대표 키워드 반환 (area 표시용) */
  function matchSpecAndKey(region) {
    var top = region.replace(/\([^()]*\)/g, '').replace(/[()]/g, '');
    var isExcl = /제외/.test(region);
    var bestSpec = 0, bestKey = '';
    keyArr.forEach(function(kw) {
      var s = 0, key = '';
      if (Array.isArray(kw)) {
        s = kw.every(function(k){ return k && _kwInRegion(k, region, top, isExcl); })
           ? kw.reduce(function(sum, k){ return sum + k.length; }, 0) : 0;
        key = kw[0] || '';
      } else {
        if (!kw || !_kwInRegion(kw, region, top, isExcl)) return;
        s = (_PROV_ALIAS[kw] || _METRO_SET[kw]) ? kw.length : kw.length * 2;
        key = kw;
      }
      if (s > bestSpec) { bestSpec = s; bestKey = key; }
    });
    return { spec: bestSpec, key: bestKey };
  }

  function rankHeat(lv) {
    return lv === '중대경보' ? 4 : lv === '경보' ? 3 : lv === '주의보' ? 2 : lv === '예비특보' ? 1 : 0;
  }

  /* 1) 활성 stnId 목록 */
  var lu = new URL('https://apis.data.go.kr/1360000/WthrWrnInfoService/getWthrWrnList');
  lu.searchParams.set('serviceKey', CONFIG.API_KEY);
  lu.searchParams.set('pageNo',    '1');
  lu.searchParams.set('numOfRows', '200');
  lu.searchParams.set('dataType',  'JSON');
  var lj = await fetch(lu.toString()).then(function(r){ return r.ok ? r.json() : null; }).catch(function(){ return null; });
  var lItems = lj && lj.response && lj.response.body && lj.response.body.items && lj.response.body.items.item;
  if (!lItems) return [];
  var stnIds = Array.from(new Set((Array.isArray(lItems) ? lItems : [lItems]).map(function(i){ return i.stnId; }).filter(Boolean)));
  if (!stnIds.length) return [];

  /* 2) 각 stnId별 getWthrWrnMsg → t6 파싱 → 폭염 매칭 */
  var best = {};  /* '폭염' → { level, wrnTitle, tmSt, tmEd, spec } */

  await Promise.allSettled(stnIds.map(async function(stnId) {
    var mu = new URL('https://apis.data.go.kr/1360000/WthrWrnInfoService/getWthrWrnMsg');
    mu.searchParams.set('serviceKey', CONFIG.API_KEY);
    mu.searchParams.set('pageNo',    '1');
    mu.searchParams.set('numOfRows', '50');
    mu.searchParams.set('dataType',  'JSON');
    mu.searchParams.set('stnId', stnId);
    var mj = await fetch(mu.toString()).then(function(r){ return r.ok ? r.json() : null; }).catch(function(){ return null; });
    var mItems = mj && mj.response && mj.response.body && mj.response.body.items && mj.response.body.items.item;
    if (!mItems) return;
    (Array.isArray(mItems) ? mItems : [mItems]).forEach(function(item) {
      var t6 = item.t6 || '';
      if (!t6.includes('폭염')) return;
      /* t6 한 섹션이 여러 줄에 걸칠 수 있음 → '\no ' 단위로 청크 분리 후
         내부 줄바꿈을 공백으로 합쳐서 파싱 (overview.js parseT6와 동일 방식) */
      ('\n' + t6).split(/\no\s+/).forEach(function(chunk) {
        chunk = chunk.trim().replace(/\n\s*/g, ' ');
        if (!chunk.includes('폭염')) return;
        var m = chunk.match(/^([가-힣]+)\s*:\s*(.+)/);
        if (!m || !m[1].includes('폭염')) return;
        var tp = m[1].trim(), region = m[2].trim();
        var level = tp.includes('중대경보') ? '중대경보'
                  : tp.includes('경보')    ? '경보'
                  : tp.includes('주의보')  ? '주의보'
                  : tp.includes('예비')    ? '예비특보' : '';
        if (!level) return;
        var bestMk = { spec: 0, key: '', segment: '', isExcl: false };
        splitRegion(region).forEach(function(seg) {
          var mk = matchSpecAndKey(seg.trim());
          var segIsExcl = /제외/.test(seg);
          /* 높은 spec 우선, 동점이면 포함형(isExcl=false)이 제외형보다 우선 */
          if (mk.spec > bestMk.spec || (mk.spec === bestMk.spec && !segIsExcl && bestMk.isExcl)) {
            bestMk = { spec: mk.spec, key: mk.key, segment: seg.trim(), isExcl: segIsExcl };
          }
        });
        if (!bestMk.spec) return;
        /* 제외형 세그먼트: 표시 area는 매칭된 구체 키워드(예: '부산서부')로 대체
           → '부산(부산동부 제외)' 대신 '부산서부' 표시 */
        var areaText = (bestMk.isExcl && bestMk.key) ? bestMk.key : bestMk.segment;
        var cur = best['폭염'];
        if (!cur || rankHeat(level) > rankHeat(cur.level) ||
            (rankHeat(level) === rankHeat(cur.level) && (
              bestMk.spec > cur.spec ||
              (bestMk.spec === cur.spec && !bestMk.isExcl && cur.isExcl)
            ))) {
          best['폭염'] = { wrnTitle: '폭염' + level, level: level,
                           tmSt: item.tmSt, tmEd: item.tmEd, tmFc: item.tmFc,
                           spec: bestMk.spec, isExcl: bestMk.isExcl, area: areaText };
        }
      });
    });
  }));

  return Object.values(best).map(function(w) {
    return { wrnTitle: w.wrnTitle, tmSt: w.tmSt, tmEd: w.tmEd, tmFc: w.tmFc, area: w.area };
  });
}

/* 기상청 기상특보 조회
   일반 특보(stnId 없음)와 폭염특보(stnId별) 병렬 조회 후 병합
   폭염은 stnId별 조회가 더 정확하므로 regular 결과의 폭염을 대체함 */
async function fetchWeatherWarning() {
  const city = getCurrentWrnKeys();

  async function regularFetch() {
    try {
      const url = new URL('https://apis.data.go.kr/1360000/WthrWrnInfoService/getWthrWrnMsg');
      url.searchParams.set('serviceKey', CONFIG.API_KEY);
      url.searchParams.set('pageNo',    '1');
      url.searchParams.set('numOfRows', '100');
      url.searchParams.set('dataType',  'JSON');
      const res = await fetch(url.toString());
      if (!res.ok) return [];
      const json = await res.json();
      if (json?.response?.header?.resultCode !== '00') return [];
      const items = json?.response?.body?.items?.item;
      if (!items) return [];
      const arr = Array.isArray(items) ? items : [items];
      /* 폭염은 _fetchHeatWarns에서 더 정확하게 처리하므로 제외 */
      return filterByCity(arr, city).filter(function(w){ return !(w.wrnTitle || '').includes('폭염'); });
    } catch(e) { return []; }
  }

  const [regular, heat] = await Promise.all([
    regularFetch(),
    _fetchHeatWarns(city).catch(function(){ return []; }),
  ]);

  return regular.concat(heat);
}

/* localStorage 캐시 — 페이지 재로드 시에도 이전 데이터 복원 */
const _LS_KEY = 'kma_wx_cache';
const _LS_TTL = 60 * 60 * 1000; // 1시간 이내 캐시 유효

function _saveCache(data) {
  try {
    localStorage.setItem(_LS_KEY, JSON.stringify({
      baseTimeDisplay: data.baseTimeDisplay,
      base_date: data.base_date,
      base_time: data.base_time,
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
    /* 기상청 발표 기준시각이 바뀌면 즉시 무효 — 구 예보를 계속 보여주는 문제 방지 */
    const cur = getBaseTime();
    if (c.base_date !== cur.base_date || c.base_time !== cur.base_time) return null;
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

    _lastGoodData  = { dailyRows, hourlyRows, generatedAt: new Date(), isReal: true, baseTimeDisplay, base_date, base_time, weatherWarnings, ncstData };
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
