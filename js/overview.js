/* ===================================================
   공항별 기상전망 — 전체 공항 현황 페이지
   =================================================== */

const OV_DAYS = 7;
var OV_DATES  = [];
var MID_DATA  = null;   /* 중기예보 사전조회 캐시 { fcstCache, taCache, issuanceDate } */

/* ===================== overview localStorage 캐시 (30분 TTL) ===================== */
var _OV_CACHE_KEY = 'kma_ov_cache';
var _OV_CACHE_TTL = 30 * 60 * 1000;

function _saveOvCache(allData) {
  try {
    localStorage.setItem(_OV_CACHE_KEY, JSON.stringify({
      allData: allData.map(function(item) {
        return {
          aptCode: item.apt.code,
          current: item.current,
          days: item.days.map(function(dy) {
            return {
              date: dy.date.toISOString(), amWx: dy.amWx, pmWx: dy.pmWx,
              tmin: dy.tmin, tmax: dy.tmax, pcp: dy.pcp, sno: dy.sno, hasSnow: dy.hasSnow,
            };
          }),
        };
      }),
      _at: Date.now(),
    }));
  } catch(e) {}
}

function _loadOvCache() {
  try {
    var raw = localStorage.getItem(_OV_CACHE_KEY);
    if (!raw) return null;
    var c = JSON.parse(raw);
    if (Date.now() - c._at > _OV_CACHE_TTL) return null;
    var restored = c.allData.map(function(item) {
      var apt = AIRPORTS.find(function(a) { return a.code === item.aptCode; });
      if (!apt) return null;
      item.days.forEach(function(dy) { dy.date = new Date(dy.date); });
      return { apt: apt, current: item.current, days: item.days };
    }).filter(Boolean);
    if (restored.length < AIRPORTS.length) return null;
    return restored;
  } catch(e) { return null; }
}

/* ===================== 날씨 코드 → 텍스트 ===================== */
function wxTxt(pty, sky) {
  if (pty === 4) return '소나기';
  if (pty === 3) return '눈';
  if (pty === 2) return '비/눈';
  if (pty === 1) return '비';
  if (sky === 4) return '흐림';
  if (sky === 3) return '구름많음';
  if (sky === 2) return '구름조금';
  return '맑음';
}

/* ===================== API — 단기예보 (공항별 좌표) ===================== */
async function kmaFetchApt(nx, ny, _retry) {
  if (_retry === undefined) _retry = true;
  var bt  = getBaseTime();
  var url = new URL(KMA_BASE + '/getVilageFcst');
  var key = CONFIG.API_KEY;
  if (key.includes('%')) key = decodeURIComponent(key);
  url.searchParams.set('serviceKey', key);
  url.searchParams.set('numOfRows', '1500');
  url.searchParams.set('pageNo',    '1');
  url.searchParams.set('dataType',  'JSON');
  url.searchParams.set('base_date', bt.base_date);
  url.searchParams.set('base_time', bt.base_time);
  url.searchParams.set('nx', nx);
  url.searchParams.set('ny', ny);
  var res = await fetch(url.toString());
  if (!res.ok) {
    if (_retry && (res.status >= 500 || res.status === 429)) {
      var delay = res.status === 429 ? 8000 : 2000;
      await new Promise(function(r){ setTimeout(r, delay); });
      return kmaFetchApt(nx, ny, false);
    }
    throw new Error('HTTP ' + res.status);
  }
  var json = await res.json();
  if (json?.response?.header?.resultCode !== '00')
    throw new Error('KMA ' + json?.response?.header?.resultCode);
  return json.response.body.items.item;
}

/* ===================== API — 초단기실황 (현재기온·강수형태) ===================== */
async function kmaFetchNcstApt(nx, ny, _retry) {
  if (_retry === undefined) _retry = true;
  var bt  = getNcstBaseTime();
  var url = new URL(KMA_BASE + '/getUltraSrtNcst');
  var key = CONFIG.API_KEY;
  if (key.includes('%')) key = decodeURIComponent(key);
  url.searchParams.set('serviceKey', key);
  url.searchParams.set('numOfRows', '100');
  url.searchParams.set('pageNo',    '1');
  url.searchParams.set('dataType',  'JSON');
  url.searchParams.set('base_date', bt.base_date);
  url.searchParams.set('base_time', bt.base_time);
  url.searchParams.set('nx', nx);
  url.searchParams.set('ny', ny);
  var res = await fetch(url.toString());
  if (!res.ok) {
    if (_retry && (res.status >= 500 || res.status === 429)) {
      var delay = res.status === 429 ? 8000 : 2000;
      await new Promise(function(r){ setTimeout(r, delay); });
      return kmaFetchNcstApt(nx, ny, false);
    }
    throw new Error('HTTP ' + res.status);
  }
  var json = await res.json();
  if (json?.response?.header?.resultCode !== '00')
    throw new Error('NCST ' + json?.response?.header?.resultCode);
  return json.response.body.items.item;
}

/* 초단기실황 파싱 → {tmp, pty}  ※ T1H=-999 = 관측 불가 → null */
function parseNcstApt(items) {
  var map = {};
  var arr = Array.isArray(items) ? items : [items];
  arr.forEach(function(it) { map[it.category] = it.obsrValue; });
  var rawTmp = parseFloat(map.T1H);
  /* -99 미만: 관측불가(결측), -50~60 범위 외: 물리적으로 불가 → null */
  var validTmp = !isNaN(rawTmp) && rawTmp > -99 && rawTmp >= -50 && rawTmp <= 60;
  return {
    tmp: validTmp ? rawTmp : null,
    pty: parseInt(map.PTY || '0'),
  };
}

/* ===================== METAR API + 파싱 ===================== */

/* 풍향 각도 → 한국어 8방위 */
function windDirKo(deg) {
  if (deg === null || deg === undefined) return '풍향가변';
  var dirs = ['북','북동','동','남동','남','남서','서','북서'];
  return dirs[Math.round(deg / 45) % 8];
}

/* knots → m/s (소수점 1자리) */
function knotsToMs(kt) {
  return Math.round(kt * 0.5144 * 10) / 10;
}

/* 시정 표시 */
function fmtVis(vis) {
  if (vis === null || vis === undefined) return '-';
  if (vis >= 9999) return '10km↑';
  if (vis >= 1000) return (Math.round(vis / 100) / 10) + 'km';
  return vis + 'm';
}

/* METAR 문자열에서 관측 시각(UTC) 추출 (DDHHmmZ 토큰) */
function parseMetarTime(raw) {
  var parts = String(raw || '').trim().split(/\s+/);
  for (var i = 0; i < parts.length; i++) {
    var dtz = parts[i].match(/^(\d{2})(\d{2})(\d{2})Z$/);
    if (dtz) {
      var now = new Date();
      var d   = new Date(Date.UTC(
        now.getUTCFullYear(), now.getUTCMonth(),
        parseInt(dtz[1]), parseInt(dtz[2]), parseInt(dtz[3])
      ));
      if (d > now) d.setUTCMonth(d.getUTCMonth() - 1); /* 말일→익월 방지 */
      return d;
    }
  }
  return new Date(0);
}

/* METAR API 호출 → raw METAR 문자열 반환 (가장 최신 관측 선택) */
async function kmaFetchMetar(icao) {
  var url = new URL('https://apis.data.go.kr/1360000/AftnAmmService/getMetar');
  var key = CONFIG.API_KEY;
  if (key.includes('%')) key = decodeURIComponent(key);
  /* 오늘 날짜 범위로 오래된 데이터 제외 */
  var now = new Date();
  var p2  = function(n){ return String(n).padStart(2,'0'); };
  var tm2 = '' + now.getFullYear() + p2(now.getMonth()+1) + p2(now.getDate())
          + p2(now.getHours()) + p2(now.getMinutes());
  var past = new Date(now.getTime() - 3 * 3600 * 1000);
  var tm1 = '' + past.getFullYear() + p2(past.getMonth()+1) + p2(past.getDate())
          + p2(past.getHours()) + p2(past.getMinutes());
  url.searchParams.set('serviceKey', key);
  url.searchParams.set('pageNo',    '1');
  url.searchParams.set('numOfRows', '10');
  url.searchParams.set('dataType',  'JSON');
  url.searchParams.set('icao',      icao);
  url.searchParams.set('tm1',       tm1);
  url.searchParams.set('tm2',       tm2);
  var res  = await fetch(url.toString());
  if (!res.ok) throw new Error('HTTP ' + res.status);
  var json = await res.json();
  if (json?.response?.header?.resultCode !== '00')
    throw new Error('METAR ' + json?.response?.header?.resultCode);
  var item = json.response.body?.items?.item;
  if (!item) return null;
  var arr = Array.isArray(item) ? item : [item];
  /* METAR 문자열 내 시각 기준 최신 선택 */
  arr.sort(function(a, b) {
    var ra = a.metarMsg || a.metar || a.obsrValue || '';
    var rb = b.metarMsg || b.metar || b.obsrValue || '';
    return parseMetarTime(rb) - parseMetarTime(ra);
  });
  var it = arr[0];
  return it.metarMsg || it.metar || it.obsrValue || null;
}

/* METAR 문자열 파싱 → {tmp, dew, windDir, windSpd, windGust, vis, clouds, qnh, pty, sky} */
function parseMetar(raw) {
  if (!raw) return null;
  var m = String(raw).trim();
  var r = {
    raw: m, tmp: null, dew: null,
    windDir: null, windSpd: null, windGust: null,
    vis: null, clouds: [], qnh: null, pty: 0, sky: 1,
  };
  var parts    = m.split(/\s+/);
  var visReady = false;

  for (var i = 0; i < parts.length; i++) {
    var p = parts[i];
    if (/^(TEMPO|BECMG|NOSIG|RMK|=)$/.test(p)) break;

    /* 풍향풍속: 18003KT / VRB03KT / 18003G15KT / 18003MPS */
    var wM = p.match(/^(VRB|\d{3})(\d{2,3})(?:G(\d{2,3}))?(KT|MPS)$/);
    if (wM) {
      var isMps  = wM[4] === 'MPS';
      r.windDir  = wM[1] === 'VRB' ? null : parseInt(wM[1]);
      r.windSpd  = isMps ? Math.round(parseInt(wM[2]) / 0.5144) : parseInt(wM[2]);
      r.windGust = wM[3] ? (isMps ? Math.round(parseInt(wM[3]) / 0.5144) : parseInt(wM[3])) : null;
      visReady   = true;
      continue;
    }
    /* 가변 풍향: 350V040 → 무시 */
    if (/^\d{3}V\d{3}$/.test(p)) continue;

    /* CAVOK */
    if (p === 'CAVOK') { r.vis = 9999; visReady = false; continue; }

    /* 시정: 4자리, 풍향풍속 직후만 허용 */
    if (visReady && /^\d{4}$/.test(p)) {
      r.vis = parseInt(p); visReady = false; continue;
    }
    visReady = false;

    /* 운량 */
    if (/^(FEW|SCT|BKN|OVC)\d{3}(CB|TCU)?$/.test(p)) { r.clouds.push(p); continue; }
    if (/^(NSC|NCD|SKC|CLR)$/.test(p)) { r.clouds.push(p); continue; }

    /* 기온/이슬점: 26/21, M05/10 */
    var tM = p.match(/^(M?\d{2})\/(M?\d{2})$/);
    if (tM) {
      r.tmp = parseFloat(tM[1].replace('M', '-'));
      r.dew = parseFloat(tM[2].replace('M', '-'));
      continue;
    }

    /* QNH */
    if (/^Q\d{4}$/.test(p)) { r.qnh = parseInt(p.slice(1)); continue; }
    if (/^A\d{4}$/.test(p)) { r.qnh = Math.round(parseInt(p.slice(1)) * 33.8639) / 100; continue; }
  }

  /* SKY 도출 */
  var low = r.clouds[0] || '';
  r.sky = /^(NSC|NCD|SKC|CLR)/.test(low) ? 1
        : /^FEW/.test(low)               ? 2
        : /^SCT/.test(low)               ? 3
        : /^(BKN|OVC)/.test(low)         ? 4 : (r.clouds.length ? 1 : 1);

  return r;
}

/* ===================== 레이더 이미지 ===================== */
async function loadRadarImage() {
  if (!CONFIG.API_KEY) return;
  try {
    var url = new URL('https://apis.data.go.kr/1360000/RadarImgInfoService/getCmpImg');
    var key = CONFIG.API_KEY;
    if (key.includes('%')) key = decodeURIComponent(key);
    var now = new Date();
    var p2  = function(n){ return String(n).padStart(2,'0'); };
    var ts  = '' + now.getFullYear() + p2(now.getMonth()+1) + p2(now.getDate());
    url.searchParams.set('serviceKey', key);
    url.searchParams.set('pageNo',     '1');
    url.searchParams.set('numOfRows',  '20');
    url.searchParams.set('dataType',   'JSON');
    url.searchParams.set('data',       'CMP_WRC');
    url.searchParams.set('time',       ts);
    var res  = await fetch(url.toString());
    if (!res.ok) return;
    var json = await res.json();
    if (json?.response?.header?.resultCode !== '00') return;
    var items = json.response.body?.items?.item;
    if (!items) return;
    var arr    = Array.isArray(items) ? items : [items];
    var latest = arr[arr.length - 1];
    /* rdr-img-file이 배열로 오는 경우 → 마지막(최신) URL 사용 */
    var rawImg  = latest['rdr-img-file'] || latest.rdrImg || latest.rdrImgPath || latest.cmpPath || latest.imgFile || '';
    var imgFile = Array.isArray(rawImg) ? rawImg[rawImg.length - 1] : rawImg;
    imgFile = typeof imgFile === 'string' ? imgFile.trim() : '';
    if (!imgFile) return;
    var imgUrl = imgFile.startsWith('http')
      ? imgFile
      : 'https://www.weather.go.kr/plus/images/radar/ppi/' + imgFile;
    var rawTs = latest.timeStamp || latest.regDate || '';
    var section = document.getElementById('radar-section');
    var img     = document.getElementById('radar-img');
    var timeEl  = document.getElementById('radar-time');
    if (section && img) {
      img.src = imgUrl;
      section.style.display = '';
      if (timeEl && rawTs.length >= 12) {
        timeEl.textContent = rawTs.slice(0,4)+'-'+rawTs.slice(4,6)+'-'+rawTs.slice(6,8)
          +' '+rawTs.slice(8,10)+':'+rawTs.slice(10,12)+' KST 기준';
      }
    }
  } catch(e) {
    console.warn('레이더 이미지 로드 실패:', e.message);
  }
}

/* ===================== 단기예보 파싱 → { days[], current } ===================== */
function parseAptItems(items) {
  if (!items) return { days: [], current: null };
  var arr = Array.isArray(items) ? items : [items];

  /* 날짜·시각별 묶기 */
  var byDate = {};
  arr.forEach(function(it) {
    var dk = it.fcstDate;
    if (!byDate[dk]) byDate[dk] = {};
    var hk = it.fcstTime;
    if (!byDate[dk][hk]) byDate[dk][hk] = {};
    byDate[dk][hk][it.category] = it.fcstValue;
  });

  /* 오늘 날짜 키 (YYYYMMDD) */
  var now0 = new Date();
  var p2   = function(n) { return String(n).padStart(2,'0'); };
  var todayKey = '' + now0.getFullYear() + p2(now0.getMonth()+1) + p2(now0.getDate());
  var nowHour  = now0.getHours();

  /* 오늘 예보 시간대 중 현재에 가장 가까운 슬롯 → current (SKY 포함) */
  var current = null;
  if (byDate[todayKey]) {
    var todayHrs = Object.keys(byDate[todayKey]).map(function(ht) {
      var v = byDate[todayKey][ht];
      return { h: +ht.slice(0,2), pty: +(v.PTY||0), sky: +(v.SKY||1), tmp: (v.TMP && +v.TMP > -99) ? +v.TMP : 20 };
    });
    if (todayHrs.length) {
      current = todayHrs.reduce(function(a, b) {
        return Math.abs(b.h - nowHour) < Math.abs(a.h - nowHour) ? b : a;
      });
    }
  }

  /* 일별 집계 */
  var days = Object.entries(byDate)
    .sort(function(a,b) { return a[0].localeCompare(b[0]); })
    .slice(0, OV_DAYS)
    .map(function(entry) {
      var dk      = entry[0];
      var hourMap = entry[1];
      var y = +dk.slice(0,4), m = +dk.slice(4,6)-1, d = +dk.slice(6,8);
      var date = new Date(y, m, d);

      var allH = Object.keys(hourMap).map(function(ht) {
        var v = hourMap[ht];
        var rawTmp = v.TMP !== undefined && v.TMP !== null ? +v.TMP : NaN;
        return {
          h:   +ht.slice(0,2),
          pty: +(v.PTY||0),
          sky: +(v.SKY||1),
          tmp: (!isNaN(rawTmp) && rawTmp > -99) ? rawTmp : null,
          pcp: v.PCP==='강수없음'?0: v.PCP==='1mm 미만'?0.5:(parseFloat(v.PCP)||0),
          sno: v.SNO==='적설없음'?0: v.SNO==='1cm 미만'?0.5:(parseFloat(v.SNO)||0),
        };
      });

      var amH = allH.filter(function(r){ return r.h>=6  && r.h<12; });
      var pmH = allH.filter(function(r){ return r.h>=12 && r.h<24; });

      var repWx = function(hrs) {
        if (!hrs.length) return { pty:0, sky:1 };
        var maxP = Math.max.apply(null, hrs.map(function(r){return r.pty;}));
        if (maxP>0) return hrs.find(function(r){return r.pty===maxP;});
        return hrs.reduce(function(a,b){return b.sky>a.sky?b:a;});
      };

      var tmpVals = allH.map(function(r){return r.tmp;}).filter(function(t){return t !== null;});
      return {
        date,
        amWx:    repWx(amH.length ? amH : allH.filter(function(r){return r.h<12;})),
        pmWx:    repWx(pmH.length ? pmH : allH.filter(function(r){return r.h>=12;})),
        tmin:    tmpVals.length ? Math.min.apply(null, tmpVals) : null,
        tmax:    tmpVals.length ? Math.max.apply(null, tmpVals) : null,
        pcp:     allH.reduce(function(s,r){return s+r.pcp;},0),
        sno:     allH.reduce(function(s,r){return s+r.sno;},0),
        hasSnow: allH.some(function(r){return r.pty===3;}),
      };
    });

  return { days: days, current: current };
}

/* ===================== 목업 데이터 (API 실패 폴백) ===================== */
function mockAptData(apt) {
  var today = new Date(); today.setHours(0,0,0,0);
  var sc    = [1,4,3,1,3,1,4];
  /* API 커버리지(~72h = 3일)에 맞춰 실데이터 구간만 채우고 나머지 비움
     → 정상 공항(실데이터)과 외관상 동일하게 유지 */
  var REAL_DAYS = 3;
  var days = Array.from({length:OV_DAYS}, function(_,i) {
    var d = new Date(today); d.setDate(today.getDate()+i);
    if (i >= REAL_DAYS) {
      /* 데이터 없는 날: tmin/tmax=null → 테이블에 '-' 표시 */
      return { date:d, amWx:{pty:0,sky:1}, pmWx:{pty:0,sky:1},
               tmin:null, tmax:null, pcp:0, sno:0, hasSnow:false };
    }
    var rain = (i===1);
    return {
      date: d,
      amWx: {pty:rain?1:0, sky:sc[i%7]},
      pmWx: {pty:0,         sky:sc[i%7]},
      tmin: 17+(apt.nx%6), tmax:27+(apt.ny%5),
      pcp:  rain?5+(apt.nx%20):0, sno:0, hasSnow:false,
    };
  });
  var cur = {pty:0, sky:3, tmp:22+(apt.nx%8)};
  return { days:days, current:cur };
}

/* ===================== 중기예보 (D+3 ~ D+10) ===================== */

/* 중기예보 발표시각 계산 — 06:00 / 18:00 기준 */
function getMidTmFc() {
  var now = new Date();
  var p2  = function(n){ return String(n).padStart(2,'0'); };
  var d   = new Date(now.getFullYear(), now.getMonth(), now.getDate()); /* 오늘 자정 */
  var h = now.getHours(), m = now.getMinutes();
  var base;
  if (h > 18 || (h === 18 && m >= 10)) {
    base = 18;
  } else if (h > 6 || (h === 6 && m >= 10)) {
    base = 6;
  } else {
    /* 새벽 06:10 이전 → 전날 18시 발표 기준 */
    d.setDate(d.getDate() - 1);
    base = 18;
  }
  var ds = '' + d.getFullYear() + p2(d.getMonth()+1) + p2(d.getDate());
  return { tmFc: ds + p2(base) + '00', issuanceDate: d, base: base };
}

/* 중기예보 API 공통 호출 (getMidFcst / getMidTa) */
async function kmaFetchMidRaw(endpoint, regId, tmFc) {
  var url = new URL('https://apis.data.go.kr/1360000/MidFcstInfoService/' + endpoint);
  var key = CONFIG.API_KEY;
  if (key.includes('%')) key = decodeURIComponent(key);
  url.searchParams.set('serviceKey', key);
  url.searchParams.set('numOfRows', '10');
  url.searchParams.set('pageNo',    '1');
  url.searchParams.set('dataType',  'JSON');
  url.searchParams.set('regId',     regId);
  url.searchParams.set('tmFc',      tmFc);
  var res = await fetch(url.toString());
  if (!res.ok) throw new Error('HTTP ' + res.status);
  var json = await res.json();
  if (json?.response?.header?.resultCode !== '00')
    throw new Error('MID ' + json?.response?.header?.resultCode);
  var item = json.response.body.items.item;
  if (!item) return null;
  return Array.isArray(item) ? item[0] : item;
}

/* 중기예보 날씨 문자열 → {pty, sky} */
function wfToWx(wf) {
  if (!wf) return {pty:0, sky:1};
  var s = String(wf).trim();
  if (s.includes('소나기'))                       return {pty:4, sky:4};
  if (s.includes('비/눈') || s.includes('눈/비')) return {pty:2, sky:4};
  if (s.includes('눈'))                          return {pty:3, sky:4};
  if (s.includes('비') || s.includes('강수'))     return {pty:1, sky:4};
  if (s.includes('흐림'))                        return {pty:0, sky:4};
  if (s.includes('구름많'))                      return {pty:0, sky:3};
  if (s.includes('구름조'))                      return {pty:0, sky:2};
  return {pty:0, sky:1};
}

/* 중기예보 데이터를 days 배열에 적용 (tmin/tmax=null인 날만) */
function applyMidTermData(days, fcstItem, taItem, issuanceDate) {
  days.forEach(function(dy) {
    var n = Math.round((dy.date.getTime() - issuanceDate.getTime()) / 86400000);
    if (n < 3 || n > 10) return;
    if (dy.tmin !== null && dy.tmax !== null) return; /* 단기예보 데이터 있으면 유지 */
    if (taItem) {
      var mn = taItem['taMin' + n], mx = taItem['taMax' + n];
      if (mn !== undefined && mn !== null) dy.tmin = parseFloat(mn);
      if (mx !== undefined && mx !== null) dy.tmax = parseFloat(mx);
    }
    if (fcstItem) {
      var amWf = fcstItem['wf' + n + 'Am'] || fcstItem['wf' + n];
      var pmWf = fcstItem['wf' + n + 'Pm'] || fcstItem['wf' + n];
      if (amWf) dy.amWx = wfToWx(amWf);
      if (pmWf) dy.pmWx = wfToWx(pmWf);
    }
  });
}

/* 중기예보 사전조회 — 유니크 지역코드별로 묶어서 한 번에 조회 */
async function prefetchMidTerm() {
  var mt = getMidTmFc();
  /* 유니크 구역코드 수집 */
  var fcstIds = [], taIds = [];
  AIRPORTS.forEach(function(a) {
    if (fcstIds.indexOf(a.midFcst) === -1) fcstIds.push(a.midFcst);
    if (taIds.indexOf(a.midTa)    === -1) taIds.push(a.midTa);
  });

  /* 특정 tmFc 로 전체 조회 */
  async function fetchAll(tmFcStr) {
    var all = fcstIds.map(function(id) {
      return kmaFetchMidRaw('getMidFcst', id, tmFcStr)
        .then(function(v){ return {t:'f', id:id, v:v}; })
        .catch(function(){ return {t:'f', id:id, v:null}; });
    }).concat(taIds.map(function(id) {
      return kmaFetchMidRaw('getMidTa', id, tmFcStr)
        .then(function(v){ return {t:'t', id:id, v:v}; })
        .catch(function(){ return {t:'t', id:id, v:null}; });
    }));
    var results = await Promise.all(all);
    var fcstCache = {}, taCache = {};
    results.forEach(function(r) {
      if (r.t === 'f') fcstCache[r.id] = r.v;
      else             taCache[r.id]   = r.v;
    });
    return { fcstCache: fcstCache, taCache: taCache };
  }

  /* 이전 발표 시각 계산 (재시도용) */
  var p2    = function(n){ return String(n).padStart(2,'0'); };
  var prevD = new Date(mt.issuanceDate);
  var prevBase;
  if (mt.base === 18) { prevBase = 6; }
  else                { prevD.setDate(prevD.getDate()-1); prevBase = 18; }
  var prevTmFc = '' + prevD.getFullYear() + p2(prevD.getMonth()+1) + p2(prevD.getDate()) + p2(prevBase) + '00';

  /* 1차 시도: 최신 발표 시각 */
  var cache = await fetchAll(mt.tmFc);
  var taHit = Object.values(cache.taCache).filter(Boolean).length;

  if (taHit === 0) {
    /* 전체 실패 → 이전 발표로 전체 재시도 */
    var cache2 = await fetchAll(prevTmFc);
    var taHit2 = Object.values(cache2.taCache).filter(Boolean).length;
    if (taHit2 > 0) {
      cache = cache2;
      mt.issuanceDate = prevD;
      // 재시도 성공
    } else {
      console.warn('[중기예보] 기온 데이터 없음 — data.go.kr 기상청_중기예보 조회서비스 구독 확인 필요');
    }
  } else {
    // 기온 조회 성공

    /* 일부 지역 실패 → 해당 지역만 이전 발표로 개별 재시도 */
    var failedTaIds = taIds.filter(function(id){ return !cache.taCache[id]; });
    if (failedTaIds.length) {
      // 일부 지역 개별 재시도
      var retries = await Promise.all(failedTaIds.map(function(id) {
        return kmaFetchMidRaw('getMidTa', id, prevTmFc)
          .then(function(v){ return {id: id, v: v}; })
          .catch(function(){ return {id: id, v: null}; });
      }));
      retries.forEach(function(r){
        if (r.v) {
          cache.taCache[r.id] = r.v;
          // 개별 재시도 성공
        }
      });
    }
  }

  return { fcstCache: cache.fcstCache, taCache: cache.taCache, issuanceDate: mt.issuanceDate };
}

/* ===================== 강수/적설 표시 ===================== */
function ovPcpStr(pcp, sno) {
  if (sno>0.5) return (sno<1?'<1':Math.round(sno))+'cm';
  if (pcp<=0)  return '-';
  if (pcp<1)   return '<1mm';
  return Math.round(pcp)+'mm';
}
function ovPcpCls(pcp, sno) {
  if (sno>0.5)  return 'ov-snow';
  if (pcp>=20)  return 'ov-heavy';
  if (pcp>0)    return 'ov-rain';
  return '';
}

/* ===================== 7일 날짜 배열 ===================== */
function buildOvDates() {
  var today = new Date(); today.setHours(0,0,0,0);
  return Array.from({length:OV_DAYS}, function(_,i) {
    var d = new Date(today); d.setDate(today.getDate()+i); return d;
  });
}

/* ===================== 특보 API + 레이블 ===================== */

/* 특보 종류 코드 (getWthrWrnList wrnTy) */
var WRN_TY_MAP = {
  '01':'강풍','02':'강설','03':'풍랑','04':'호우',
  '05':'대설','06':'건조','07':'폭풍해일','08':'한파',
  '09':'태풍','10':'황사','11':'폭염','12':'뇌우','13':'안개',
};

/* 특보 시각 문자열 포맷 (202406301400 → 6.30 14:00) */
function fmtWrnTime(s) {
  s = String(s || '').replace(/\D/g, '');
  if (s.length < 12) return '';
  var mo = parseInt(s.slice(4, 6), 10);
  var dy = parseInt(s.slice(6, 8), 10);
  var hh = s.slice(8, 10);
  var mm = s.slice(10, 12);
  return mo + '.' + dy + ' ' + hh + ':' + mm;
}

/* 통보문 제목에서 특보 타입·레벨 추출 (getWthrWrnMsg 파싱용) */
function parseWrnTitle(title) {
  var t = title || '';
  /* 예비특보를 먼저 체크해야 '경보' 포함 여부 오판을 막음 */
  var level = t.includes('예비') ? '예비특보'
            : t.includes('경보') ? '경보'
            : t.includes('주의보') ? '주의보'
            : '';
  var type  = '';
  ['태풍','폭설','대설','호우','강풍','풍랑','폭염','한파','건조','황사','뇌우','안개'].forEach(function(k) {
    if (!type && t.includes(k)) type = k;
  });
  return { type: type, level: level };
}

/* t6 필드 파싱 → [{type,level,region}] 배열
   t6 형식: "o 강풍주의보 : 경기도(하남...) \no 호우주의보 : ..." */
function parseT6(t6) {
  var result  = [];
  var MARITIME = { '풍랑':1,'해일':1,'지진해일':1 };
  var WRN_TYPES = ['태풍','폭설','대설','호우','강풍','풍랑','폭염','한파','건조','황사','뇌우','안개'];
  ('\n' + (t6 || '')).split(/\no\s+/).forEach(function(line) {
    line = line.trim().replace(/\n/g, ' ');
    var m = line.match(/^([가-힣]+)\s*:\s*(.+)/);
    if (!m) return;
    var titlePart = m[1].trim(), region = m[2].trim();
    var type = '';
    WRN_TYPES.forEach(function(k) { if (!type && titlePart.includes(k)) type = k; });
    if (!type || MARITIME[type]) return;
    var level = titlePart.includes('경보')  ? '경보'
              : titlePart.includes('주의보') ? '주의보'
              : titlePart.includes('예비')   ? '예비특보' : '';
    if (!level) return;
    result.push({ type: type, level: level, region: region });
  });
  return result;
}

/* 특보 조회:
   ① getWthrWrnList → 활성 통보문 목록(stnId·tmFc)
   ② stnId별 getWthrWrnMsg?stnId&tmFc → 최신 메시지의 t6 파싱
   → 특보 유형별 region이 정확히 분리되어 오매칭 제거 */
async function fetchWrnList() {
  if (!CONFIG.API_KEY) return null;
  var key = CONFIG.API_KEY;
  if (key.includes('%')) key = decodeURIComponent(key);

  try {
    /* ① 통보문 목록 */
    var listUrl = new URL('https://apis.data.go.kr/1360000/WthrWrnInfoService/getWthrWrnList');
    listUrl.searchParams.set('serviceKey', key);
    listUrl.searchParams.set('pageNo',     '1');
    listUrl.searchParams.set('numOfRows',  '100');
    listUrl.searchParams.set('dataType',   'JSON');
    var listJson = await fetch(listUrl.toString()).then(function(r){ return r.json(); });
    if (listJson?.response?.header?.resultCode !== '00') {
      console.warn('[특보] getWthrWrnList rc:', listJson?.response?.header?.resultCode);
      return null;
    }
    var listItems = listJson?.response?.body?.items?.item;
    if (!listItems) return [];
    if (!Array.isArray(listItems)) listItems = [listItems];

    /* ② stnId별 최신 tmFc 수집 */
    var stnLatest = {};
    listItems.forEach(function(w) {
      var sid = String(w.stnId || ''), tfc = String(w.tmFc || '');
      if (sid && (!stnLatest[sid] || tfc > stnLatest[sid])) stnLatest[sid] = tfc;
    });

    /* ③ 각 station 병렬 조회 → t6 파싱 */
    var allWarnings = [];
    await Promise.all(Object.keys(stnLatest).map(async function(stnId) {
      try {
        var msgUrl = new URL('https://apis.data.go.kr/1360000/WthrWrnInfoService/getWthrWrnMsg');
        msgUrl.searchParams.set('serviceKey', key);
        msgUrl.searchParams.set('stnId',      stnId);
        msgUrl.searchParams.set('tmFc',       stnLatest[stnId]);
        msgUrl.searchParams.set('dataType',   'JSON');
        var json = await fetch(msgUrl.toString()).then(function(r){ return r.json(); });
        if (json?.response?.header?.resultCode !== '00') return;
        var msgs = json?.response?.body?.items?.item;
        if (!msgs) return;
        if (!Array.isArray(msgs)) msgs = [msgs];
        msgs.sort(function(a, b) { return (+(b.tmSeq || 0)) - (+(a.tmSeq || 0)); });
        var top = msgs[0];
        var t6  = top?.t6 || '';
        var tfc = top?.tmFc || stnLatest[stnId];
        parseT6(t6).forEach(function(w) {
          allWarnings.push({ type: w.type, level: w.level, region: w.region,
                             start: fmtWrnTime(String(tfc)), end: '' });
        });
      } catch(e) {
        console.warn('[특보] stnId=' + stnId + ' 오류:', e.message);
      }
    }));

    return allWarnings;
  } catch(e) {
    console.warn('[특보] fetchWrnList 오류:', e.message);
    return null;
  }
}

/* 특보 전체 조회: {list:[…], msgs:[…]} 반환 */
async function fetchAllWarnings() {
  if (!CONFIG.API_KEY) return { list: [], msgs: [] };

  var list = await fetchWrnList();
  if (list === null) list = [];
  // 특보 목록 처리 완료

  /* 헤더 레이블용 — type+level 정보만 필요 */
  var msgs = list.map(function(w) { return { wrnTitle: (w.type || '') + (w.level || '') }; });

  return { list: list, msgs: msgs };
}

/* 헤더 레이블용 문자열 빌드 (통보문 제목 기반) */
function buildWarnLabel(msgs) {
  if (!msgs || !msgs.length) return '*특보현황';
  var types = {};
  var WRN_MAP = [
    { keys:['태풍'],              tag:'태풍' },
    { keys:['대설','폭설','착설'], tag:'폭설' },
    { keys:['호우','강수'],        tag:'호우' },
    { keys:['강풍','풍랑'],        tag:'강풍' },
    { keys:['폭염'],               tag:'폭염' },
    { keys:['한파'],               tag:'한파' },
    { keys:['건조'],               tag:'건조' },
  ];
  msgs.forEach(function(w) {
    var title = (w.wrnTitle || w.title || '');
    WRN_MAP.forEach(function(m) {
      if (m.keys.some(function(k){ return title.includes(k); }))
        types[m.tag] = true;
    });
  });
  var primary = types['태풍'] ? '태풍' : types['폭설'] ? '폭설' : '호우';
  var extras  = ['강풍','폭염','한파','건조','태풍'].filter(function(t) {
    return types[t] && t !== primary;
  });
  var label = '*' + primary + '특보';
  if (extras.length)
    label += ', ' + extras.map(function(t){ return t+'특보'; }).join(', ');
  return label;
}

function updateWarnLabel(msgs) {
  var el = document.getElementById('warn-label');
  if (el) el.textContent = buildWarnLabel(msgs);
}

/* 강수 관련 특보 타입 (특보현황 칸) */
var WRN_PCP_TYPES = { '호우': 1, '대설': 1, '강설': 1, '태풍': 1 };

/* 특보 list → 공항별 {pcpMap, othMap} 두 맵으로 분류
   pcpMap : 특보현황 칸 (호우·대설·강설·태풍)
   othMap : 특이사항 칸 (폭염·강풍·뇌우·안개·한파·황사·건조 등)
   wrnKeys 배열로 매칭 — 광역시도 이름(충청북, 강원 등)도 포함 */
/* 공항에 무관한 해상 전용 특보 유형 */
var MARITIME_WARN_TYPES = { '풍랑': 1, '해일': 1, '지진해일': 1 };

/* 단계 우선순위: 경보=3 > 주의보=2 > 예비특보=1 */
function wrnLevelRank(lv) {
  return (lv === '경보') ? 3 : (lv === '주의보') ? 2 : (lv === '예비특보') ? 1 : 0;
}

/* 도명 약어 → 전체명 맵 (약어가 전체명의 부분문자열이 아닌 것만 — 경남≠경상남도 등) */
var _PROV_ALIAS = { '경남':'경상남도','경북':'경상북도','전남':'전라남도','충남':'충청남도','충북':'충청북도' };
/* 광역시/특별시 이름 — 다른 도의 괄호 목록 안에도 동명이시로 등장할 수 있어 최상위(괄호 밖) 매칭만 허용 */
var _METRO_SET  = { '서울':1,'부산':1,'대구':1,'인천':1,'광주':1,'대전':1,'울산':1,'세종':1 };
/* kw가 region에 실제 포함되는지 판별
   · 도명 약어: 전체명이 괄호 제거(최상위) 텍스트에 있어야 함
   · 광역시명: 괄호 안 다른 도 하위 지명과 혼동 방지 위해 괄호 제거 텍스트에서 확인
   · 일반 시/군/구: 전체 텍스트에서 확인 (괄호 안 세부 지명 포함) */
function _kwInRegion(kw, full, top) {
  if (_PROV_ALIAS[kw]) return top.includes(_PROV_ALIAS[kw]);
  if (_METRO_SET[kw])  return top.includes(kw);
  return full.includes(kw);
}

/* 공항-region 매칭 구체성 점수: AND 조건 > 긴 단일 키워드 > 짧은 단일 키워드 (0 = 불일치) */
function aptMatchSpec(apt, region) {
  var keys = apt.wrnKeys && apt.wrnKeys.length ? apt.wrnKeys : [apt.wrnCity || ''];
  var top  = region.replace(/\([^)]*\)/g, '');
  return keys.reduce(function(max, kw) {
    var s = 0;
    if (Array.isArray(kw)) {
      s = kw.every(function(k) { return k && _kwInRegion(k, region, top); })
        ? kw.reduce(function(sum, k) { return sum + k.length; }, 0)
        : 0;
    } else {
      s = (kw && _kwInRegion(kw, region, top)) ? kw.length : 0;
    }
    return Math.max(max, s);
  }, 0);
}

function buildAptWarnMaps(list) {
  var pcpMap = {}, othMap = {};
  AIRPORTS.forEach(function(apt) { pcpMap[apt.code] = []; othMap[apt.code] = []; });
  (list || []).forEach(function(w) {
    if (MARITIME_WARN_TYPES[w.type]) return;
    var region = w.region || '';
    AIRPORTS.forEach(function(apt) {
      var spec = aptMatchSpec(apt, region);
      if (!spec) return;
      var map = WRN_PCP_TYPES[w.type] ? pcpMap : othMap;
      var existIdx = map[apt.code].findIndex(function(x) { return x.type === w.type; });
      var entry = { type: w.type, level: w.level, start: w.start, end: w.end, _spec: spec };
      if (existIdx === -1) {
        map[apt.code].push(entry);
      } else {
        var cur = map[apt.code][existIdx];
        /* 더 구체적인 매칭이 우선; 동점이면 낮은 단계(예비<주의보<경보) 유지 — 광역 경보가 지역 주의보를 덮는 방지 */
        if (spec > (cur._spec || 0) || (spec === (cur._spec || 0) && wrnLevelRank(w.level) < wrnLevelRank(cur.level))) {
          map[apt.code].splice(existIdx, 1, entry);
        }
      }
    });
  });
  return { pcpMap: pcpMap, othMap: othMap };
}

/* 특보 배열 → 셀 innerHTML */
function renderWarnCell(warns) {
  if (!warns || !warns.length) return '';
  return warns.map(function(w) {
    var label = (w.type || '') + (w.level || '');
    var time  = '';
    if (w.start && w.end)  time = w.start + '~' + w.end;
    else if (w.end)        time = '~' + w.end;
    else if (w.start)      time = w.start + '~';
    return label + (time ? '<br><small style="font-size:0.75em;font-weight:normal">' + time + '</small>' : '');
  }).join('<br>');
}

/* 셀 배경·글자색 적용 */
function styleWarnCell(cell, warns) {
  var hasAlert  = warns.some(function(w){ return w.level === '경보'; });
  var hasNotice = warns.some(function(w){ return w.level === '주의보'; });
  var hasPre    = warns.some(function(w){ return w.level === '예비특보'; });
  cell.style.backgroundColor = hasAlert ? '#ffd6d6' : hasNotice ? '#fffbe6' : hasPre ? '#f0f4ff' : '';
  cell.style.color            = hasAlert ? '#c00'    : hasNotice ? '#a06000' : hasPre ? '#3a5ca0' : '';
  cell.style.fontWeight       = hasAlert ? 'bold'    : '';
}

/* contenteditable 셀 localStorage 저장/복원 바인딩
   lsPrefix: 'ov-warn-' 또는 'ov-note-' */
function bindEditCells(selector, lsPrefix) {
  document.querySelectorAll(selector + '[data-code]').forEach(function(cell) {
    var code = cell.dataset.code;
    try {
      var saved = localStorage.getItem(lsPrefix + code);
      if (saved !== null) { cell.innerHTML = saved; cell.dataset.manual = '1'; }
    } catch(e) {}
    cell.addEventListener('blur', function() {
      var c = cell.innerHTML.trim();
      try {
        if (!c) { localStorage.removeItem(lsPrefix + code); cell.dataset.manual = ''; }
        else    { localStorage.setItem(lsPrefix + code, c); cell.dataset.manual = '1'; }
      } catch(e) {}
    });
  });
}

/* 특보현황 칸(호우·대설류) + 특이사항 칸(기타 특보) 동시 주입
   data-manual='1' 셀(수동 편집)은 건너뜀 */
function applyWarnCells(pcpMap, othMap) {
  document.querySelectorAll('.ov-warn-cell[data-code]').forEach(function(cell) {
    if (cell.dataset.manual === '1') return;
    var warns = pcpMap[cell.dataset.code] || [];
    cell.innerHTML = renderWarnCell(warns);
    styleWarnCell(cell, warns);
    if (!warns.length) cell.innerHTML = '-';
  });
  document.querySelectorAll('.ov-note-cell[data-code]').forEach(function(cell) {
    if (cell.dataset.manual === '1') return;
    var warns = othMap[cell.dataset.code] || [];
    cell.innerHTML = renderWarnCell(warns);
    styleWarnCell(cell, warns);
  });
}

/* ===================== 테이블 렌더 ===================== */
function renderOvTable(allData, dates) {
  var tbl = document.getElementById('ov-tbl');
  if (!tbl) return;

  var today    = new Date(); today.setHours(0,0,0,0);
  var todayStr = today.toDateString();
  var h = '';

  /* colgroup */
  h += '<colgroup>';
  h += '<col style="width:36px">';
  h += '<col style="width:58px">';
  h += '<col style="width:72px">';
  dates.forEach(function() { h += '<col style="width:44px"><col style="width:44px">'; });
  h += '<col style="width:66px">';
  h += '</colgroup>';

  /* 헤더 1행 — 날짜 */
  h += '<thead><tr class="ov-hd1">';
  h += '<th rowspan="2">공항</th>';
  /* warn-label 에 id 부여 → 특보 API 결과로 갱신됨 */
  h += '<th rowspan="2">특보현황<br><span class="ov-hd-sm">(기상청)</span>' +
       '<br><span class="ov-hd-sm" id="warn-label">*특보현황</span></th>';
  h += '<th rowspan="2">구분</th>';

  dates.forEach(function(d) {
    var dow = d.getDay();
    var isTd = d.toDateString() === todayStr;
    var cls  = 'ov-date-hd';
    if (isTd)                           cls += ' ov-td-hd';
    else if (dow===6)                   cls += ' ov-sat-hd';
    else if (dow===0 || isHoliday(d))  cls += ' ov-sun-hd';
    h += '<th colspan="2" class="' + cls + '">' +
         (d.getMonth()+1) + '월 ' + d.getDate() + '일<br>' + DAYS_KO[dow] + '요일</th>';
  });
  h += '<th rowspan="2">특이사항</th></tr>';

  /* 헤더 2행 — 오전/오후 */
  h += '<tr class="ov-hd2">';
  dates.forEach(function(d) {
    var isTd = d.toDateString() === todayStr;
    h += '<th class="ov-sub">' + (isTd ? '현재' : '오전') + '</th>';
    h += '<th class="ov-sub">오후</th>';
  });
  h += '</tr></thead>';

  /* tbody */
  h += '<tbody>';
  allData.forEach(function(item) {
    var apt    = item.apt;
    var days   = item.days;
    var cur    = item.current || {pty:0, sky:1, tmp:null, dew:null, windDir:null, windSpd:null, windGust:null, vis:null, qnh:null};
    var dayMap = {};
    days.forEach(function(dy) { dayMap[dy.date.toDateString()] = dy; });

    /* ── 날씨 행 ── */
    h += '<tr class="ov-wx-row">';
    h += '<td class="ov-apt-cell" rowspan="3">' + apt.name + '</td>';
    h += '<td class="ov-warn-cell" data-code="' + apt.code + '" rowspan="3" contenteditable="true">-</td>';
    h += '<td class="ov-label">날씨</td>';
    dates.forEach(function(d) {
      var isTd = d.toDateString() === todayStr;
      var dy   = dayMap[d.toDateString()];
      var amTxt, pmTxt;
      if (isTd) {
        /* 현재 날씨 (METAR PTY + SKY) + 풍향풍속 */
        var windLine = '';
        if (cur.windSpd !== null) {
          var wDir = cur.windDir !== null ? windDirKo(cur.windDir) : '풍향가변';
          var wSpd = knotsToMs(cur.windSpd) + 'm/s';
          if (cur.windGust) wSpd += '(돌풍' + knotsToMs(cur.windGust) + ')';
          windLine = '<br><small class="ov-wind">' + wDir + ' ' + wSpd + '</small>';
        }
        amTxt = wxTxt(cur.pty, cur.sky) + windLine;
        pmTxt = dy ? wxTxt(dy.pmWx.pty, dy.pmWx.sky) : '-';
      } else {
        amTxt = dy ? wxTxt(dy.amWx.pty, dy.amWx.sky) : '-';
        pmTxt = dy ? wxTxt(dy.pmWx.pty, dy.pmWx.sky) : '-';
      }
      h += '<td class="ov-c' + (isTd?' ov-cur':'') + '">' + amTxt + '</td>';
      h += '<td class="ov-c' + (isTd?' ov-cur':'') + '">' + pmTxt + '</td>';
    });
    h += '<td class="ov-note-cell" data-code="' + apt.code + '" rowspan="3" contenteditable="true"></td></tr>';

    /* ── 최저/최고기온 행 ── */
    h += '<tr class="ov-tmp-row">';
    h += '<td class="ov-label">최저/최고기온</td>';
    dates.forEach(function(d) {
      var isTd = d.toDateString() === todayStr;
      var dy   = dayMap[d.toDateString()];
      var mn, mx;
      var fmtT = function(v) { return (v !== null && !isNaN(v)) ? Math.round(v) + '℃' : '-℃'; };
      if (isTd) {
        /* 현재 기온 (초단기실황 T1H, 없으면 단기예보 현재시각 기온) */
        mn = fmtT(cur.tmp);
        mx = fmtT(dy ? dy.tmax : null);
      } else {
        mn = fmtT(dy ? dy.tmin : null);
        mx = fmtT(dy ? dy.tmax : null);
      }
      h += '<td class="ov-c ov-tmp' + (isTd?' ov-cur':'') + '">' + mn + '</td>';
      h += '<td class="ov-c ov-tmp' + (isTd?' ov-cur':'') + '">' + mx + '</td>';
    });
    h += '</tr>';

    /* ── 예상강수량 행 ── */
    var aptHasSnow = days.some(function(dy){return dy.hasSnow;});
    h += '<tr class="ov-pcp-row">';
    h += '<td class="ov-label">' + (aptHasSnow ? '예상강설량' : '예상강수량') + '</td>';
    dates.forEach(function(d) {
      var dy  = dayMap[d.toDateString()];
      var pcp = dy ? (dy.pcp||0) : 0;
      var sno = dy ? (dy.sno||0) : 0;
      var val = ovPcpStr(pcp, sno);
      var cls = val!=='-' ? ovPcpCls(pcp,sno) : '';
      h += '<td class="ov-c ov-pcp ' + cls + '" colspan="2">' + val + '</td>';
    });
    h += '</tr>';

  });

  h += '</tbody>';
  tbl.innerHTML = h;
  bindEditCells('.ov-warn-cell', 'ov-warn-');
  bindEditCells('.ov-note-cell', 'ov-note-');
}

/* ===================== 단일 공항 데이터 로드 ===================== */
async function loadAptData(apt, chipEl) {
  if (chipEl) chipEl.className = 'ov-chip loading';
  try {
    var result;
    if (!CONFIG.API_KEY) {
      result = mockAptData(apt);
    } else {
      /* 단기예보 + METAR + NCST 3개 병렬 호출 */
      var three = await Promise.allSettled([
        kmaFetchApt(apt.nx, apt.ny),
        apt.icao ? kmaFetchMetar(apt.icao) : Promise.reject(new Error('no icao')),
        kmaFetchNcstApt(apt.nx, apt.ny),
      ]);
      var fcstP = three[0], metarP = three[1], ncstP = three[2];

      if (fcstP.status === 'fulfilled') {
        result = parseAptItems(fcstP.value);
        if (!result.days.length) result = mockAptData(apt);
      } else {
        result = mockAptData(apt);
      }

      /* 1순위: METAR → current 보강 (실측기온·풍향풍속·시정·QNH) */
      if (metarP.status === 'fulfilled' && metarP.value) {
        var obs = parseMetar(metarP.value);
        if (obs) {
          var fcstTmp = result.current ? result.current.tmp : null;
          var fcstSky = (result.current && result.current.sky) || 1;
          result.current = {
            pty:      obs.pty,
            sky:      obs.clouds.length ? obs.sky : fcstSky,
            tmp:      obs.tmp !== null ? obs.tmp : fcstTmp,
            dew:      obs.dew,
            windDir:  obs.windDir,
            windSpd:  obs.windSpd,
            windGust: obs.windGust,
            vis:      obs.vis,
            qnh:      obs.qnh,
            raw:      obs.raw,
          };
        }
      }

      /* 2순위: METAR에서 기온 미확보 시 NCST fallback (T1H=-999 제외) */
      if ((!result.current || result.current.tmp === null) && ncstP.status === 'fulfilled') {
        try {
          var ncstObs = parseNcstApt(ncstP.value);
          if (!result.current) result.current = { pty: ncstObs.pty, sky: 1, tmp: null };
          else result.current.pty = ncstObs.pty;
          if (ncstObs.tmp !== null) result.current.tmp = ncstObs.tmp;
        } catch(ne) { /* NCST 파싱 오류 무시 */ }
      }
    }

    /* OV_DAYS(7일) 전체 날짜 확보 — 단기예보에 없는 날은 빈 칸으로 추가 */
    var today0 = new Date(); today0.setHours(0,0,0,0);
    for (var di = 0; di < OV_DAYS; di++) {
      var td = new Date(today0); td.setDate(today0.getDate() + di);
      var already = result.days.some(function(dy) {
        return dy.date.toDateString() === td.toDateString();
      });
      if (!already) {
        result.days.push({
          date: td, amWx:{pty:0,sky:1}, pmWx:{pty:0,sky:1},
          tmin:null, tmax:null, pcp:0, sno:0, hasSnow:false,
        });
      }
    }
    result.days.sort(function(a,b){ return a.date - b.date; });

    /* 중기예보 적용 (사전조회 성공 시) */
    if (MID_DATA) {
      applyMidTermData(
        result.days,
        MID_DATA.fcstCache[apt.midFcst] || null,
        MID_DATA.taCache[apt.midTa]     || null,
        MID_DATA.issuanceDate
      );
    }

    /* 3순위 최종 fallback: current가 없거나 기온이 null이면 오늘 예보 tmax로 보강 */
    if (!result.current) result.current = { pty:0, sky:1, tmp:null };
    if (result.current.tmp === null) {
      var todayDay = result.days.find(function(dy){
        return dy.date.toDateString() === today0.toDateString();
      });
      if (todayDay) {
        result.current.tmp = todayDay.tmax !== null ? todayDay.tmax : todayDay.tmin;
      }
    }

    if (chipEl) chipEl.className = 'ov-chip done';
    return { apt: apt, days: result.days, current: result.current };
  } catch (e) {
    console.warn('[' + apt.code + '] 실패:', e.message);
    if (chipEl) chipEl.className = 'ov-chip err';
    var mock = mockAptData(apt);
    return { apt: apt, days: mock.days, current: mock.current };
  }
}

/* ===================== 전체 로드 + 렌더 ===================== */
async function loadAll() {
  var dates = buildOvDates();
  OV_DATES  = dates;

  /* 날짜/시각 갱신 */
  var now = new Date();
  var p2  = function(n){ return String(n).padStart(2,'0'); };
  var el  = document.getElementById('ov-dateline');
  if (el) el.textContent =
    (now.getMonth()+1) + '월 ' + now.getDate() + '일  ' +
    DAYS_KO[now.getDay()] + '요일  ' +
    p2(now.getHours()) + '시 ' + p2(now.getMinutes()) + '분 기준';

  /* 진행 칩 */
  var prog  = document.getElementById('ov-progress');
  var chips = {};
  if (prog) {
    prog.innerHTML = '';
    AIRPORTS.forEach(function(apt) {
      var s = document.createElement('span');
      s.className = 'ov-chip'; s.textContent = apt.name;
      s.id = 'chip-' + apt.code;
      prog.appendChild(s); chips[apt.code] = s;
    });
  }

  /* 캐시 유효하면 API 호출 없이 렌더 */
  var cachedAll = _loadOvCache();
  if (cachedAll) {
    // 캐시 데이터 사용
    AIRPORTS.forEach(function(apt) {
      if (chips[apt.code]) chips[apt.code].className = 'ov-chip done';
    });
    renderOvTable(cachedAll, dates);
    fetchAllWarnings().then(function(result) {
      updateWarnLabel(result.msgs);
      var maps = buildAptWarnMaps(result.list);
      applyWarnCells(maps.pcpMap, maps.othMap);
    });
    loadRadarImage();
    return;
  }

  /* 중기예보 사전조회 (D+3~D+6 토/일 데이터) */
  MID_DATA = null;
  if (CONFIG.API_KEY) {
    try {
      MID_DATA = await prefetchMidTerm();
    } catch(e) {
      console.warn('[중기예보] 사전조회 실패:', e.message);
    }
  }

  /* 3개씩 배치 로드 */
  var allData = [];
  var BATCH   = 3;
  for (var i = 0; i < AIRPORTS.length; i += BATCH) {
    var batch   = AIRPORTS.slice(i, i+BATCH);
    var results = await Promise.allSettled(
      batch.map(function(apt){ return loadAptData(apt, chips[apt.code]); })
    );
    results.forEach(function(r, j) {
      if (r.status === 'fulfilled') allData.push(r.value);
      else {
        var mock = mockAptData(batch[j]);
        allData.push({ apt:batch[j], days:mock.days, current:mock.current });
      }
    });
    if (i+BATCH < AIRPORTS.length)
      await new Promise(function(res){ setTimeout(res, 500); });
  }

  _saveOvCache(allData);
  renderOvTable(allData, dates);

  /* 특보 API → 헤더 레이블 + 공항별 특보현황 칸 갱신 (비동기, 테이블 렌더 후) */
  fetchAllWarnings().then(function(result) {
    updateWarnLabel(result.msgs);
    var maps = buildAptWarnMaps(result.list);
    applyWarnCells(maps.pcpMap, maps.othMap);
  });

  /* 레이더 이미지 갱신 */
  loadRadarImage();
}

/* ===================== 엑셀 다운로드 ===================== */
function exportToExcel() {
  var XLSX = window.XLSX;
  if (!XLSX) { alert('엑셀 라이브러리를 로드하는 중입니다. 잠시 후 다시 시도하세요.'); return; }

  var tbl = document.getElementById('ov-tbl');
  if (!tbl || !tbl.rows.length) {
    alert('데이터를 먼저 로드하세요 (↺ 새로고침).'); return;
  }

  var wb = XLSX.utils.book_new();

  /* 제목 행 */
  var dateEl  = document.getElementById('ov-dateline');
  var dateStr = dateEl ? dateEl.textContent.trim() : '';
  var titleRows = [
    ['공항별 기상전망', dateStr],
    ['※ 세부 강수량은 해당일 2일전부터 조회 가능'],
    [],
  ];
  var titleWs = XLSX.utils.aoa_to_sheet(titleRows);

  /* DOM 테이블 → 시트 */
  var tableWs = XLSX.utils.table_to_sheet(tbl, { raw: false });

  /* 두 시트 세로 합치기 (OFFSET = 제목행 수) */
  var OFFSET = titleRows.length;
  var merged = {};

  Object.keys(titleWs).filter(function(k){return k[0]!=='!';}).forEach(function(addr){
    merged[addr] = titleWs[addr];
  });
  Object.keys(tableWs).filter(function(k){return k[0]!=='!';}).forEach(function(addr){
    var ref    = XLSX.utils.decode_cell(addr);
    var newAddr= XLSX.utils.encode_cell({r: ref.r+OFFSET, c: ref.c});
    merged[newAddr] = tableWs[addr];
  });

  var tblRef = XLSX.utils.decode_range(tableWs['!ref'] || 'A1');
  merged['!ref'] = XLSX.utils.encode_range({
    s: {r:0, c:0},
    e: {r: tblRef.e.r+OFFSET, c: Math.max(tblRef.e.c, 1)},
  });

  merged['!merges'] = (tableWs['!merges'] || []).map(function(m){
    return { s:{r:m.s.r+OFFSET, c:m.s.c}, e:{r:m.e.r+OFFSET, c:m.e.c} };
  });

  var cols = [{wch:6},{wch:12},{wch:12}];
  if (OV_DATES && OV_DATES.length)
    OV_DATES.forEach(function(){ cols.push({wch:9},{wch:9}); });
  cols.push({wch:14});
  merged['!cols'] = cols;

  XLSX.utils.book_append_sheet(wb, merged, '공항별기상전망');

  var now  = new Date();
  var p2   = function(n){ return String(n).padStart(2,'0'); };
  var fname = '공항별기상전망_' +
    now.getFullYear() + p2(now.getMonth()+1) + p2(now.getDate()) +
    '_' + p2(now.getHours()) + p2(now.getMinutes()) + '.xlsx';

  XLSX.writeFile(wb, fname);
}

/* ===================== 인증키 설정 (overview 전용) ===================== */
function ovOpenKeyModal() {
  var inp = document.getElementById('ov-key-inp');
  if (inp) inp.value = localStorage.getItem('kma_api_key') || '';
  var modal = document.getElementById('ov-key-modal');
  if (modal) modal.style.display = 'flex';
}

function ovSaveKey() {
  var key = (document.getElementById('ov-key-inp').value || '').trim();
  if (!key) return;
  CONFIG.API_KEY = key;
  localStorage.setItem('kma_api_key', key);
  /* 서버 실행 중이면 apikey.js 파일도 즉시 업데이트 */
  fetch('/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: key }),
  }).catch(function(){});
  document.getElementById('ov-key-modal').style.display = 'none';
  loadAll();
}

/* ===================== 초기화 + 자동갱신 ===================== */
var _ovRefreshTimer = null;

async function loadAllAndSchedule() {
  await loadAll();
  clearTimeout(_ovRefreshTimer);
  // 전체현황은 데이터 변화가 적으므로 30분 자동갱신
  _ovRefreshTimer = setTimeout(loadAllAndSchedule, 30 * 60 * 1000);
}

window.addEventListener('DOMContentLoaded', async function() {
  await CONFIG.ready;
  await loadAllAndSchedule();
});
