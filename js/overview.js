/* ===================================================
   공항별 기상전망 — 전체 공항 현황 페이지
   =================================================== */

const OV_DAYS = 7;
var OV_DATES  = [];

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
async function kmaFetchApt(nx, ny) {
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
  if (!res.ok) throw new Error('HTTP ' + res.status);
  var json = await res.json();
  if (json?.response?.header?.resultCode !== '00')
    throw new Error('KMA ' + json?.response?.header?.resultCode);
  return json.response.body.items.item;
}

/* ===================== API — 초단기실황 (현재기온·강수형태) ===================== */
async function kmaFetchNcstApt(nx, ny) {
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
  if (!res.ok) throw new Error('HTTP ' + res.status);
  var json = await res.json();
  if (json?.response?.header?.resultCode !== '00')
    throw new Error('NCST ' + json?.response?.header?.resultCode);
  return json.response.body.items.item;
}

/* 초단기실황 파싱 → {tmp, pty} */
function parseNcstApt(items) {
  var map = {};
  var arr = Array.isArray(items) ? items : [items];
  arr.forEach(function(it) { map[it.category] = it.obsrValue; });
  return {
    tmp: parseFloat(map.T1H || '20'),
    pty: parseInt(map.PTY  || '0'),
  };
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
      return { h: +ht.slice(0,2), pty: +(v.PTY||0), sky: +(v.SKY||1), tmp: +(v.TMP||20) };
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
        return {
          h:   +ht.slice(0,2),
          pty: +(v.PTY||0),
          sky: +(v.SKY||1),
          tmp: +(v.TMP||20),
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

      return {
        date,
        amWx:    repWx(amH.length ? amH : allH.filter(function(r){return r.h<12;})),
        pmWx:    repWx(pmH.length ? pmH : allH.filter(function(r){return r.h>=12;})),
        tmin:    allH.length ? Math.min.apply(null,allH.map(function(r){return r.tmp;})) : null,
        tmax:    allH.length ? Math.max.apply(null,allH.map(function(r){return r.tmp;})) : null,
        pcp:     allH.reduce(function(s,r){return s+r.pcp;},0),
        sno:     allH.reduce(function(s,r){return s+r.sno;},0),
        hasSnow: allH.some(function(r){return r.pty===3;}),
      };
    });

  return { days: days, current: current };
}

/* ===================== 목업 데이터 ===================== */
function mockAptData(apt) {
  var today = new Date(); today.setHours(0,0,0,0);
  var sc    = [1,4,3,1,3,1,4];
  var days  = Array.from({length:OV_DAYS}, function(_,i) {
    var d = new Date(today); d.setDate(today.getDate()+i);
    var rain = (i===1);
    return {
      date: d,
      amWx: {pty:rain?1:0, sky:sc[i%7]},
      pmWx: {pty:0,         sky:sc[i%7]},
      tmin: 17+(apt.nx%6), tmax:27+(apt.ny%5),
      pcp: rain?5+(apt.nx%20):0, sno:0, hasSnow:false,
    };
  });
  var cur = {pty:0, sky:3, tmp:22+(apt.nx%8)};
  return { days:days, current:cur };
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
async function fetchAllWarnings() {
  if (!CONFIG.API_KEY) return [];
  try {
    var url = new URL('https://apis.data.go.kr/1360000/WthrWrnInfoService/getWthrWrnMsg');
    var key = CONFIG.API_KEY;
    if (key.includes('%')) key = decodeURIComponent(key);
    url.searchParams.set('serviceKey', key);
    url.searchParams.set('pageNo',    '1');
    url.searchParams.set('numOfRows', '100');
    url.searchParams.set('dataType',  'JSON');
    var res  = await fetch(url.toString());
    var json = await res.json();
    if (json?.response?.header?.resultCode !== '00') return [];
    var items = json?.response?.body?.items?.item;
    if (!items) return [];
    return Array.isArray(items) ? items : [items];
  } catch(e) {
    return [];
  }
}

/* 특보 목록 → 헤더 레이블 문자열 */
function buildWarnLabel(warnings) {
  if (!warnings || !warnings.length) return '*호우특보';

  var types = {};  /* {호우:true, 폭설:true, ...} */
  var WRN_MAP = [
    { keys:['태풍'],                tag:'태풍'  },
    { keys:['대설','폭설','착설'],   tag:'폭설'  },
    { keys:['호우','강수'],          tag:'호우'  },
    { keys:['강풍','풍랑'],          tag:'강풍'  },
    { keys:['폭염'],                 tag:'폭염'  },
    { keys:['한파'],                 tag:'한파'  },
    { keys:['건조'],                 tag:'건조'  },
  ];
  warnings.forEach(function(w) {
    var title = (w.wrnTitle || w.title || '');
    WRN_MAP.forEach(function(m) {
      if (m.keys.some(function(k){ return title.includes(k); }))
        types[m.tag] = true;
    });
  });

  /* 강수 주 타입 결정 (태풍>폭설>호우) */
  var primary = types['태풍'] ? '태풍' : types['폭설'] ? '폭설' : '호우';
  /* 나머지 부가 타입 */
  var extras = ['강풍','폭염','한파','건조','태풍'].filter(function(t) {
    return types[t] && t !== primary;
  });

  var label = '*' + primary + '특보';
  if (extras.length)
    label += ', ' + extras.map(function(t){return t+'특보';}).join(', ');
  return label;
}

function updateWarnLabel(warnings) {
  var el = document.getElementById('warn-label');
  if (el) el.textContent = buildWarnLabel(warnings);
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
       '<br><span class="ov-hd-sm" id="warn-label">*호우특보</span></th>';
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
    var cur    = item.current || {pty:0, sky:1, tmp:null};
    var dayMap = {};
    days.forEach(function(dy) { dayMap[dy.date.toDateString()] = dy; });

    /* ── 날씨 행 ── */
    h += '<tr class="ov-wx-row">';
    h += '<td class="ov-apt-cell" rowspan="3">' + apt.name + '</td>';
    h += '<td class="ov-warn-cell" rowspan="3" contenteditable="true">-</td>';
    h += '<td class="ov-label">날씨</td>';
    dates.forEach(function(d) {
      var isTd = d.toDateString() === todayStr;
      var dy   = dayMap[d.toDateString()];
      var amTxt, pmTxt;
      if (isTd) {
        /* 현재 날씨 (초단기실황 PTY + 예보 SKY) */
        amTxt = wxTxt(cur.pty, cur.sky);
        pmTxt = dy ? wxTxt(dy.pmWx.pty, dy.pmWx.sky) : '-';
      } else {
        amTxt = dy ? wxTxt(dy.amWx.pty, dy.amWx.sky) : '-';
        pmTxt = dy ? wxTxt(dy.pmWx.pty, dy.pmWx.sky) : '-';
      }
      h += '<td class="ov-c' + (isTd?' ov-cur':'') + '">' + amTxt + '</td>';
      h += '<td class="ov-c' + (isTd?' ov-cur':'') + '">' + pmTxt + '</td>';
    });
    h += '<td class="ov-note-cell" rowspan="3" contenteditable="true"></td></tr>';

    /* ── 최저/최고기온 행 ── */
    h += '<tr class="ov-tmp-row">';
    h += '<td class="ov-label">최저/최고기온</td>';
    dates.forEach(function(d) {
      var isTd = d.toDateString() === todayStr;
      var dy   = dayMap[d.toDateString()];
      var mn, mx;
      if (isTd) {
        /* 현재 기온 (초단기실황 T1H) */
        mn = cur.tmp !== null ? cur.tmp + '℃' : '-℃';
        mx = (dy && dy.tmax !== null) ? dy.tmax + '℃' : '-℃';
      } else {
        mn = (dy && dy.tmin !== null) ? dy.tmin + '℃' : '-℃';
        mx = (dy && dy.tmax !== null) ? dy.tmax + '℃' : '-℃';
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
}

/* ===================== 단일 공항 데이터 로드 ===================== */
async function loadAptData(apt, chipEl) {
  if (chipEl) chipEl.className = 'ov-chip loading';
  try {
    var result;
    if (!CONFIG.API_KEY) {
      result = mockAptData(apt);
    } else {
      /* 단기예보 + 초단기실황 병렬 호출 */
      var both = await Promise.allSettled([
        kmaFetchApt(apt.nx, apt.ny),
        kmaFetchNcstApt(apt.nx, apt.ny),
      ]);
      var fcst = both[0], ncst = both[1];

      if (fcst.status === 'fulfilled') {
        result = parseAptItems(fcst.value);
        if (!result.days.length) result = mockAptData(apt);
      } else {
        result = mockAptData(apt);
      }

      /* 초단기실황 기온·강수형태로 current 보강 */
      if (ncst.status === 'fulfilled') {
        var obs = parseNcstApt(ncst.value);
        result.current = {
          pty: obs.pty,
          /* SKY는 실황에 없으므로 예보 current에서 가져옴 */
          sky: (result.current && result.current.sky) || 1,
          tmp: obs.tmp,
        };
      }
    }

    if (chipEl) chipEl.className = 'ov-chip done';
    return { apt: apt, days: result.days, current: result.current || {pty:0,sky:1,tmp:null} };
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
      await new Promise(function(res){ setTimeout(res, 300); });
  }

  renderOvTable(allData, dates);

  /* 특보 API → 헤더 레이블 갱신 (비동기, 테이블 렌더 후) */
  fetchAllWarnings().then(function(w){ updateWarnLabel(w); });
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

/* ===================== 초기화 ===================== */
window.addEventListener('DOMContentLoaded', async function() {
  await CONFIG.ready;
  await loadAll();
  setInterval(loadAll, 10 * 60 * 1000);
});
