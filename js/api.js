/* ===================================================
   기상청 오픈API 연동 모듈
   단기예보 + 초단기실황 조회
   API 키 없으면 목업 데이터 사용
   =================================================== */

const KMA_BASE = 'https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0';

/* 기상청 API 공통 호출 (5xx 오류 시 2초 후 1회 재시도) */
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
  return json.response.body.items.item;
}

/* 단기예보 발표시각 계산 (02,05,08,11,14,17,20,23시)
   기상청 발표 후 약 10분이면 데이터 생성 완료 → 10분 버퍼 적용 */
function getBaseTime() {
  const now      = new Date();
  const totalMin = now.getHours() * 60 + now.getMinutes();
  const baseHours = [2, 5, 8, 11, 14, 17, 20, 23];
  const BUF = 10; // 발표 후 10분 대기
  let base = 23;
  for (const bh of baseHours) {
    if (totalMin >= bh * 60 + BUF) base = bh;
  }
  const pad = (n) => String(n).padStart(2, '0');
  const d = new Date(now);
  // 자정~새벽2시: 전날 23시 발표 기준
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

  // 날짜별 집계
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
    if (h < 12) { dm.amSky = r.sky; dm.amPty = r.pty; dm.amPop = r.pop; }
    else         { dm.pmSky = r.sky; dm.pmPty = r.pty; dm.pmPop = r.pop; }
  }

  const dailyRows = Object.values(dailyMap).slice(0, 11);
  return { dailyRows, hourlyRows };
}

/* 초단기실황 발표시각 계산 — 매 10분 발표 (0,10,20,30,40,50분), 약 10분 후 제공 */
function getNcstBaseTime() {
  const now     = new Date();
  const pad     = n => String(n).padStart(2, '0');
  const d       = new Date(now);
  // 현재 시각에서 10분(버퍼) 뺀 뒤 10분 단위 내림
  const totalMin = now.getHours() * 60 + now.getMinutes() - 10;
  if (totalMin < 0) {
    d.setDate(d.getDate() - 1);
    const t = 24 * 60 + totalMin;
    return {
      base_date: `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}`,
      base_time: `${pad(Math.floor(t / 60))}${pad(Math.floor((t % 60) / 10) * 10)}`,
    };
  }
  return {
    base_date: `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}`,
    base_time: `${pad(Math.floor(totalMin / 60))}${pad(Math.floor((totalMin % 60) / 10) * 10)}`,
  };
}

/* 초단기실황 조회 — 매시간 발표, 현재 기온·강수량·바람 실측값 */
async function fetchUltraNcst() {
  const { base_date, base_time } = getNcstBaseTime();
  const items = await kmaFetch('getUltraSrtNcst', { base_date, base_time });
  const map = {};
  for (const it of (Array.isArray(items) ? items : [items])) map[it.category] = it.obsrValue;

  const pty    = parseInt(map.PTY || '0');
  const rn1Raw = map.RN1 || '강수없음';
  const rn1    = rn1Raw === '강수없음' ? 0
               : rn1Raw === '1mm 미만' ? 0.5
               : parseFloat(rn1Raw) || 0;

  return {
    tmp:  parseFloat(map.T1H || '20'),
    rn1,
    rn1Raw,
    reh:  parseInt(map.REH || '60'),
    wsd:  parseFloat(map.WSD || '0'),
    vec:  parseInt(map.VEC || '180'),
    pty,
    baseTime: base_time,
  };
}

/* 현재 선택 공항의 특보 매칭 키워드 배열 반환 (wrnKeys → wrnCity 순 fallback) */
function getCurrentWrnKeys() {
  const code = localStorage.getItem('airport_code') || 'PUS';
  const apt  = (typeof AIRPORTS !== 'undefined') ? AIRPORTS.find(a => a.code === code) : null;
  if (!apt) return ['부산'];
  return (apt.wrnKeys && apt.wrnKeys.length) ? apt.wrnKeys : [apt.wrnCity || '부산'];
}

/* 특보/예비특보 공통 필터 (wrnKeys 중 하나라도 포함 여부) */
function filterByCity(arr, keys) {
  var keyArr = Array.isArray(keys) ? keys : [keys];
  return arr.filter(function(w) {
    var targets = [w.wrnStnm, w.area, w.areaFc, w.wrnTitle];
    return keyArr.some(function(kw) {
      return kw && targets.some(function(t) { return t && t.includes(kw); });
    });
  });
}

/* 기상청 기상특보 조회 (선택 공항 소재지 기준, 5xx 시 재시도) */
async function fetchWeatherWarning(_retry = true) {
  const city = getCurrentWrnKeys();
  const url  = new URL('https://apis.data.go.kr/1360000/WthrWrnInfoService/getWthrWrnMsg');
  url.searchParams.set('serviceKey', CONFIG.API_KEY);
  url.searchParams.set('pageNo',    '1');
  url.searchParams.set('numOfRows', '50');
  url.searchParams.set('dataType',  'JSON');

  const res = await fetch(url.toString());
  if (!res.ok) {
    if (_retry && res.status >= 500) {
      await new Promise(r => setTimeout(r, 2000));
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

let _lastGoodData = null;

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

    _lastGoodData = { dailyRows, hourlyRows, generatedAt: new Date(), isReal: true, baseTimeDisplay, weatherWarnings, ncstData };
    return _lastGoodData;
  } catch (err) {
    console.warn('[KMA API 오류]', err.message);
    if (_lastGoodData) {
      console.info('[KMA] 일시 오류 — 이전 데이터 유지');
      return { ..._lastGoodData, baseTimeDisplay: `⚠${_lastGoodData.baseTimeDisplay}` };
    }
    console.error('API키 설정 확인: ⚙ 설정 → 기상청 오픈API 서비스키 입력 (data.go.kr)');
    return { ...buildMockData(mode), isReal: false, baseTimeDisplay: '⚠목업', weatherWarnings: [] };
  }
}
