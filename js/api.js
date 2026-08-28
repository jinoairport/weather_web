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
   기상청 데이터 준비 시간 약 2~3분 → 5분 버퍼 적용
   미준비 오류는 getPrevBaseTime+재시도 로직으로 대응 (30분 대기 불필요) */
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

/* 직전 기준시각 반환 (재시도용: 현재 기준시각 API가 미준비일 때 사용) */
function getPrevBaseTime(bt) {
  const baseHours = [2, 5, 8, 11, 14, 17, 20, 23];
  const curHour   = parseInt(bt.base_time.slice(0, 2), 10);
  const idx       = baseHours.indexOf(curHour);
  const pad       = n => String(n).padStart(2, '0');
  if (idx <= 0) {
    const d = new Date(
      parseInt(bt.base_date.slice(0, 4), 10),
      parseInt(bt.base_date.slice(4, 6), 10) - 1,
      parseInt(bt.base_date.slice(6, 8), 10)
    );
    d.setDate(d.getDate() - 1);
    return { base_date: `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}`, base_time: '2300' };
  }
  return { base_date: bt.base_date, base_time: pad(baseHours[idx - 1]) + '00' };
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

/* getWthrWrnMsg는 stnId 없이 호출하면 응답이 비어 있고, 있어도 wrnTitle/area 같은
   정형 필드가 없다 — 실제로는 t6 한 필드에 그 지방청의 "현재 활성인 특보 전체"가
   "o 종류 : 지역목록" 줄들로 뭉쳐서 온다. 그래서 활성 stnId를 모두 순회해 각 지방청의
   가장 최근 통보문 하나(tmFc 기준)만 가져와 t6를 파싱해야 한다 (overview.js와 동일 방식). */
var WRN_TYPES = ['태풍', '폭설', '대설', '호우', '강풍', '풍랑', '폭염', '한파', '건조', '황사', '뇌우', '안개'];

/* t6 텍스트를 "종류 : 지역목록" 청크로 분리 → [{type, level, region}] (해상전용 제외) */
function parseT6(t6) {
  var result = [];
  ('\n' + (t6 || '')).split(/\no\s+/).forEach(function(chunk) {
    chunk = chunk.trim().replace(/\n\s*/g, ' ');
    var m = chunk.match(/^([가-힣]+)\s*:\s*(.+)/);
    if (!m) return;
    var titlePart = m[1].trim(), region = m[2].trim();
    var type = '';
    WRN_TYPES.forEach(function(k) { if (!type && titlePart.includes(k)) type = k; });
    if (!type || MARITIME_WARN_TITLES.includes(type)) return;
    /* 중대경보를 먼저 체크해야 '경보' 포함 여부 오판을 막음 */
    var level = titlePart.includes('중대경보') ? '중대경보'
              : titlePart.includes('경보')    ? '경보'
              : titlePart.includes('주의보')  ? '주의보'
              : titlePart.includes('예비')    ? '예비특보' : '';
    if (!level) return;
    result.push({ type: type, level: level, region: region });
  });
  return result;
}

function wrnLevelRank(lv) {
  return lv === '중대경보' ? 4 : lv === '경보' ? 3 : lv === '주의보' ? 2 : lv === '예비특보' ? 1 : 0;
}

/* 지역 문자열에서 선택 공항(wrnKeys) 매칭 spec + 대표 표시 지역명 계산 (세그먼트 단위 검사) */
function matchCityInRegion(keyArr, region) {
  var best = { spec: 0, area: '' };
  splitRegion(region).forEach(function(seg) {
    var top = seg.replace(/\([^()]*\)/g, '').replace(/[()]/g, '').trim();
    var isExcl = /제외/.test(seg);
    var segSpec = 0, segKey = '';
    keyArr.forEach(function(kw) {
      var s = 0, key = '';
      if (Array.isArray(kw)) {
        s = kw.every(function(k) { return k && _kwInRegion(k, seg, top, isExcl); })
          ? kw.reduce(function(sum, k) { return sum + k.length; }, 0) : 0;
        key = kw[0] || '';
      } else {
        if (!kw || !_kwInRegion(kw, seg, top, isExcl)) return;
        s = (_PROV_ALIAS[kw] || _METRO_SET[kw]) ? kw.length : kw.length * 2;
        key = kw;
      }
      if (s > segSpec) { segSpec = s; segKey = key; }
    });
    if (segSpec > best.spec) {
      /* 제외형 세그먼트: 표시 area는 매칭된 구체 키워드로 대체 (예: '부산(부산동부 제외)' → '부산서부') */
      best = { spec: segSpec, area: (isExcl && segKey) ? segKey : seg.trim() };
    }
  });
  return best;
}

/* 활성 stnId별 최신 통보문(t6) 조회 → 전국 특보 원자료 배열 [{type,level,region,tmFc}] */
async function fetchWrnList() {
  var lu = new URL('https://apis.data.go.kr/1360000/WthrWrnInfoService/getWthrWrnList');
  lu.searchParams.set('serviceKey', CONFIG.API_KEY);
  lu.searchParams.set('pageNo',    '1');
  lu.searchParams.set('numOfRows', '200');
  lu.searchParams.set('dataType',  'JSON');
  var lj = await fetch(lu.toString()).then(function(r){ return r.ok ? r.json() : null; }).catch(function(){ return null; });
  var lItems = lj && lj.response && lj.response.body && lj.response.body.items && lj.response.body.items.item;
  if (!lItems) return [];
  if (!Array.isArray(lItems)) lItems = [lItems];

  /* stnId별 가장 최근 tmFc — getWthrWrnMsg 호출 시 정확히 그 통보문만 지정해서 가져옴 */
  var stnLatest = {};
  lItems.forEach(function(w) {
    var sid = String(w.stnId || ''), tfc = String(w.tmFc || '');
    if (sid && (!stnLatest[sid] || tfc > stnLatest[sid])) stnLatest[sid] = tfc;
  });

  var all = [];
  await Promise.allSettled(Object.keys(stnLatest).map(async function(stnId) {
    var mu = new URL('https://apis.data.go.kr/1360000/WthrWrnInfoService/getWthrWrnMsg');
    mu.searchParams.set('serviceKey', CONFIG.API_KEY);
    mu.searchParams.set('stnId',      stnId);
    mu.searchParams.set('tmFc',       stnLatest[stnId]);
    mu.searchParams.set('numOfRows',  '100');
    mu.searchParams.set('dataType',   'JSON');
    var mj = await fetch(mu.toString()).then(function(r){ return r.ok ? r.json() : null; }).catch(function(){ return null; });
    var mItems = mj && mj.response && mj.response.body && mj.response.body.items && mj.response.body.items.item;
    if (!mItems) return;
    if (!Array.isArray(mItems)) mItems = [mItems];
    mItems.sort(function(a, b) { return (+(b.tmSeq || 0)) - (+(a.tmSeq || 0)); });
    var top = mItems[0];
    parseT6(top && top.t6).forEach(function(w) {
      all.push({ type: w.type, level: w.level, region: w.region, tmFc: (top && top.tmFc) || stnLatest[stnId] });
    });
  }));
  return all;
}

/* 기상청 기상특보 조회 — 활성 stnId 전체의 최신 통보문을 파싱해 선택 공항 키워드와
   매칭되는 특보만 유형별로(최고 단계 우선, 동률이면 더 구체적인 지역 우선) 추려서 반환 */
async function fetchWeatherWarning() {
  var keyArr = getCurrentWrnKeys();
  var list;
  try { list = await fetchWrnList(); } catch (e) { list = []; }

  var best = {};
  list.forEach(function(w) {
    var m = matchCityInRegion(keyArr, w.region);
    if (!m.spec) return;
    var cur = best[w.type];
    if (!cur || wrnLevelRank(w.level) > wrnLevelRank(cur.level) ||
        (wrnLevelRank(w.level) === wrnLevelRank(cur.level) && m.spec > cur.spec)) {
      best[w.type] = { type: w.type, level: w.level, tmFc: w.tmFc, spec: m.spec, area: m.area };
    }
  });

  return Object.values(best).map(function(w) {
    return { wrnTitle: w.type + w.level, tmFc: w.tmFc, area: w.area };
  });
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

/* 누적강수량 원장 — 단기예보(PCP)는 "예보값"이라 실제로 내린 양과 다를 수 있고,
   기준시각이 넘어가면 지난 시간대 값이 API 응답에서 사라지기까지 한다.
   그래서 실제 관측값인 초단기실황(getUltraSrtNcst)의 RN1(시간당 실측 강수량)을
   시간대별로 로컬에 영구 기록해두고, 그 값으로 자정~현재 누적을 계산한다.
   초단기실황은 과거 특정 시각도 조회 가능하므로, 처음 켤 때 그날 놓친 시간대를
   순차 조회해 채워넣는다(백필) — 하루 중 언제 접속해도 실제값 기준으로 정확해진다. */
const _PCP_LEDGER_KEY = 'kma_pcp_ledger_v2'; // v2: 예보(PCP) 기반 구버전 원장과 값 형식이 달라 키 분리

function _dateKey(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}`;
}

function _loadPcpLedger() {
  try {
    const raw = localStorage.getItem(_PCP_LEDGER_KEY);
    if (!raw) return {};
    const c = JSON.parse(raw);
    return c.date === _dateKey(new Date()) ? c.hours : {};
  } catch (e) { return {}; }
}

function _savePcpLedger(hours) {
  try {
    localStorage.setItem(_PCP_LEDGER_KEY, JSON.stringify({ date: _dateKey(new Date()), hours }));
  } catch (e) {}
}

/* 초단기실황 특정 시각(정시30분) 조회 → 실측 RN1(mm) 반환 */
async function fetchObservedRn1(base_date, base_time) {
  const items = await kmaFetch('getUltraSrtNcst', { base_date, base_time });
  const arr = Array.isArray(items) ? items : [items];
  let rn1Raw;
  arr.forEach(i => { if (i.category === 'RN1') rn1Raw = i.obsrValue; });
  if (rn1Raw === undefined) throw new Error('RN1 없음');
  return rn1Raw === '강수없음' ? 0
       : rn1Raw === '1mm 미만' ? 0.5
       : parseFloat(rn1Raw) || 0;
}

/* 오늘 0시~현재 사이 원장에 없는 시간대만 순차 백필 (실패 시 그 이후는 중단, 다음 호출 때 재시도) */
async function backfillPcpLedger() {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const dateStr = _dateKey(now);
  const lastObsHour = now.getMinutes() < 30 ? now.getHours() - 1 : now.getHours();
  const hours = _loadPcpLedger();
  for (let h = 0; h <= lastObsHour; h++) {
    if (hours[h] !== undefined) continue;
    try {
      hours[h] = await fetchObservedRn1(dateStr, pad(h) + '30');
      _savePcpLedger(hours);
    } catch (e) {
      break;
    }
  }
}

/* 오늘 0시~현재까지 누적강수량 (초단기실황 실측 기반) */
function getAccumPcpToday() {
  const hours = _loadPcpLedger();
  return Object.values(hours).reduce((s, v) => s + Math.max(0, v || 0), 0);
}

/* 메인 데이터 페치 */
async function fetchWeatherData(mode) {
  if (!CONFIG.API_KEY) {
    console.info('API 키 없음 → 목업 데이터 사용');
    return { ...buildMockData(mode), isReal: false, baseTimeDisplay: '목업', weatherWarnings: [] };
  }

  try {
    let { base_date, base_time } = getBaseTime();

    /* 최신 기준시각 시도 → 미준비(빈 응답/오류)이면 이전 기준시각으로 즉시 재시도 */
    let vilageItems;
    try {
      vilageItems = await kmaFetch('getVilageFcst', { base_date, base_time });
      if (!vilageItems || !vilageItems.length) throw new Error('빈 데이터');
    } catch (e1) {
      console.info(`[KMA] ${base_time} 미준비(${e1.message}) → 이전 기준시각 재시도`);
      const prev = getPrevBaseTime({ base_date, base_time });
      base_date = prev.base_date;
      base_time = prev.base_time;
      vilageItems = await kmaFetch('getVilageFcst', { base_date, base_time });
    }

    const baseTimeDisplay = `${base_date.slice(4,6)}/${base_date.slice(6,8)} ${base_time.slice(0,2)}:00 발표`;

    const [warnings, ncst] = await Promise.allSettled([
      fetchWeatherWarning(),
      fetchUltraNcst(),
    ]);

    const { dailyRows, hourlyRows } = parseVilageFcst(vilageItems);
    try { await backfillPcpLedger(); } catch (e) { console.warn('[누적강수량 백필 실패]', e.message); }
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
