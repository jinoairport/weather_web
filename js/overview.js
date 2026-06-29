/* ===================================================
   공항별 기상전망 — 전체 공항 현황 페이지
   =================================================== */

const OV_DAYS = 7;

/* 날씨 코드 → 한국어 텍스트 */
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

/* API 호출 — 공항별 좌표 지정 */
async function kmaFetchApt(nx, ny) {
  const { base_date, base_time } = getBaseTime();
  const url = new URL(KMA_BASE + '/getVilageFcst');
  const rawKey = CONFIG.API_KEY;
  const apiKey = rawKey.includes('%') ? decodeURIComponent(rawKey) : rawKey;
  url.searchParams.set('serviceKey', apiKey);
  url.searchParams.set('numOfRows', '1500');
  url.searchParams.set('pageNo', '1');
  url.searchParams.set('dataType', 'JSON');
  url.searchParams.set('base_date', base_date);
  url.searchParams.set('base_time', base_time);
  url.searchParams.set('nx', nx);
  url.searchParams.set('ny', ny);
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const json = await res.json();
  if (json?.response?.header?.resultCode !== '00')
    throw new Error('KMA ' + json?.response?.header?.resultCode);
  return json.response.body.items.item;
}

/* API 응답 → 일별 구조 파싱 */
function parseAptItems(items) {
  if (!items) return [];
  const arr = Array.isArray(items) ? items : [items];

  /* 날짜별로 묶기 */
  const byDate = {};
  for (const it of arr) {
    const dk = it.fcstDate;
    if (!byDate[dk]) byDate[dk] = {};
    const hk = it.fcstTime;
    if (!byDate[dk][hk]) byDate[dk][hk] = {};
    byDate[dk][hk][it.category] = it.fcstValue;
  }

  return Object.entries(byDate)
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, OV_DAYS)
    .map(([dk, hourMap]) => {
      const y = +dk.slice(0, 4), m = +dk.slice(4, 6) - 1, d = +dk.slice(6, 8);
      const date = new Date(y, m, d);

      const allH = Object.entries(hourMap).map(([ht, vals]) => ({
        h:   +ht.slice(0, 2),
        pty: +(vals.PTY || 0),
        sky: +(vals.SKY || 1),
        tmp: +(vals.TMP || 20),
        pcp: vals.PCP === '강수없음' ? 0
           : vals.PCP === '1mm 미만' ? 0.5
           : (parseFloat(vals.PCP) || 0),
        sno: vals.SNO === '적설없음' ? 0
           : vals.SNO === '1cm 미만' ? 0.5
           : (parseFloat(vals.SNO) || 0),
      }));

      const amH = allH.filter(r => r.h >= 6  && r.h < 12);
      const pmH = allH.filter(r => r.h >= 12 && r.h < 24);

      const repWx = function(hrs) {
        if (!hrs.length) return { pty: 0, sky: 1 };
        const maxPty = Math.max.apply(null, hrs.map(function(r){ return r.pty; }));
        if (maxPty > 0) return hrs.find(function(r){ return r.pty === maxPty; });
        return hrs.reduce(function(a, b){ return b.sky > a.sky ? b : a; });
      };

      const tmin = allH.length ? Math.min.apply(null, allH.map(function(r){ return r.tmp; })) : null;
      const tmax = allH.length ? Math.max.apply(null, allH.map(function(r){ return r.tmp; })) : null;
      const pcpTot = allH.reduce(function(s, r){ return s + r.pcp; }, 0);
      const snoTot = allH.reduce(function(s, r){ return s + r.sno; }, 0);

      return {
        date,
        amWx: repWx(amH.length ? amH : allH.filter(function(r){ return r.h < 12; })),
        pmWx: repWx(pmH.length ? pmH : allH.filter(function(r){ return r.h >= 12; })),
        tmin, tmax,
        pcp: pcpTot, sno: snoTot,
        hasSnow: allH.some(function(r){ return r.pty === 3; }),
      };
    });
}

/* 목업 공항 데이터 */
function mockAptDays(apt) {
  var today = new Date(); today.setHours(0, 0, 0, 0);
  var skyCycle = [1, 4, 3, 1, 3, 1, 4];
  return Array.from({ length: OV_DAYS }, function(_, i) {
    var d = new Date(today); d.setDate(today.getDate() + i);
    var rain = (i === 1);
    return {
      date: d,
      amWx: { pty: rain ? 1 : 0, sky: skyCycle[i % 7] },
      pmWx: { pty: 0,             sky: skyCycle[i % 7] },
      tmin: 17 + (apt.nx % 6),
      tmax: 27 + (apt.ny % 5),
      pcp:  rain ? 5 + (apt.nx % 20) : 0,
      sno:  0, hasSnow: false,
    };
  });
}

/* 강수/적설 표시 */
function ovPcpStr(pcp, sno) {
  if (sno > 0.5) return (sno < 1 ? '<1' : Math.round(sno)) + 'cm';
  if (pcp <= 0)  return '-';
  if (pcp < 1)   return '<1mm';
  return Math.round(pcp) + 'mm';
}
function ovPcpCls(pcp, sno) {
  if (sno > 0.5)  return 'ov-snow';
  if (pcp >= 20)  return 'ov-heavy';
  if (pcp > 0)    return 'ov-rain';
  return '';
}

/* 7일 날짜 배열 */
function buildOvDates() {
  var today = new Date(); today.setHours(0, 0, 0, 0);
  return Array.from({ length: OV_DAYS }, function(_, i) {
    var d = new Date(today); d.setDate(today.getDate() + i); return d;
  });
}

/* 테이블 렌더 */
function renderOvTable(allData, dates) {
  var tbl = document.getElementById('ov-tbl');
  if (!tbl) return;

  var today = new Date(); today.setHours(0, 0, 0, 0);
  var todayStr = today.toDateString();

  var h = '';

  /* colgroup */
  h += '<colgroup>';
  h += '<col style="width:36px">';   /* 공항 */
  h += '<col style="width:58px">';   /* 특보현황 */
  h += '<col style="width:72px">';   /* 구분 */
  dates.forEach(function() { h += '<col style="width:44px"><col style="width:44px">'; });
  h += '<col style="width:66px">';   /* 특이사항 */
  h += '</colgroup>';

  /* thead — 행1 날짜 */
  h += '<thead>';
  h += '<tr class="ov-hd1">';
  h += '<th rowspan="2">공항</th>';
  h += '<th rowspan="2">특보현황<br><span class="ov-hd-sm">(기상청)</span><br><span class="ov-hd-sm">* 호우특보</span></th>';
  h += '<th rowspan="2">구분</th>';

  dates.forEach(function(d) {
    var dow = d.getDay();
    var isTd = d.toDateString() === todayStr;
    var cls = 'ov-date-hd';
    if (isTd)                            cls += ' ov-td-hd';
    else if (dow === 6)                  cls += ' ov-sat-hd';
    else if (dow === 0 || isHoliday(d)) cls += ' ov-sun-hd';
    var mo = d.getMonth() + 1, day = d.getDate();
    h += '<th colspan="2" class="' + cls + '">' +
         mo + '월 ' + day + '일<br>' + DAYS_KO[dow] + '요일</th>';
  });

  h += '<th rowspan="2">특이사항</th>';
  h += '</tr>';

  /* thead — 행2 오전/오후 */
  h += '<tr class="ov-hd2">';
  dates.forEach(function(d) {
    var isTd = d.toDateString() === todayStr;
    h += '<th class="ov-sub">' + (isTd ? '현재' : '오전') + '</th>';
    h += '<th class="ov-sub">오후</th>';
  });
  h += '</tr>';
  h += '</thead>';

  /* tbody */
  h += '<tbody>';

  allData.forEach(function(item) {
    var apt = item.apt;
    var days = item.days;
    var dayMap = {};
    days.forEach(function(dy) { dayMap[dy.date.toDateString()] = dy; });

    /* 날씨 행 */
    h += '<tr class="ov-wx-row">';
    h += '<td class="ov-apt-cell" rowspan="3">' + apt.name + '</td>';
    h += '<td class="ov-warn-cell" rowspan="3" contenteditable="true">-</td>';
    h += '<td class="ov-label">날씨</td>';
    dates.forEach(function(d) {
      var isTd = d.toDateString() === todayStr;
      var dy   = dayMap[d.toDateString()];
      var amTxt = (isTd || !dy) ? '-' : wxTxt(dy.amWx.pty, dy.amWx.sky);
      var pmTxt = dy ? wxTxt(dy.pmWx.pty, dy.pmWx.sky) : '-';
      h += '<td class="ov-c' + (isTd ? ' ov-cur' : '') + '">' + amTxt + '</td>';
      h += '<td class="ov-c' + (isTd ? ' ov-cur' : '') + '">' + pmTxt + '</td>';
    });
    h += '<td class="ov-note-cell" rowspan="3" contenteditable="true"></td>';
    h += '</tr>';

    /* 최저/최고기온 행 */
    h += '<tr class="ov-tmp-row">';
    h += '<td class="ov-label">최저/최고기온</td>';
    dates.forEach(function(d) {
      var isTd = d.toDateString() === todayStr;
      var dy   = dayMap[d.toDateString()];
      var mn = (!isTd && dy && dy.tmin !== null) ? dy.tmin + '℃' : '-℃';
      var mx = (dy && dy.tmax !== null) ? dy.tmax + '℃' : '-℃';
      h += '<td class="ov-c ov-tmp' + (isTd ? ' ov-cur' : '') + '">' + mn + '</td>';
      h += '<td class="ov-c ov-tmp' + (isTd ? ' ov-cur' : '') + '">' + mx + '</td>';
    });
    h += '</tr>';

    /* 예상강수량/적설 행 */
    h += '<tr class="ov-pcp-row">';
    h += '<td class="ov-label" id="pcp-lbl-' + apt.code + '">예상강수량</td>';
    dates.forEach(function(d) {
      var dy  = dayMap[d.toDateString()];
      var pcp = dy ? (dy.pcp || 0) : 0;
      var sno = dy ? (dy.sno || 0) : 0;
      var val = ovPcpStr(pcp, sno);
      var cls = val !== '-' ? ovPcpCls(pcp, sno) : '';
      /* 눈이 있는 공항은 레이블 변경 */
      if (dy && dy.hasSnow) {
        var lbl = document.getElementById('pcp-lbl-' + apt.code);
        if (lbl) lbl.textContent = '예상강설량';
      }
      h += '<td class="ov-c ov-pcp ' + cls + '" colspan="2">' + val + '</td>';
    });
    h += '</tr>';
  });

  h += '</tbody>';
  tbl.innerHTML = h;
}

/* 단일 공항 데이터 로드 */
async function loadAptData(apt, chipEl) {
  if (chipEl) chipEl.className = 'ov-chip loading';
  try {
    var days;
    if (!CONFIG.API_KEY) {
      days = mockAptDays(apt);
    } else {
      var items = await kmaFetchApt(apt.nx, apt.ny);
      var parsed = parseAptItems(items);
      days = parsed.length ? parsed : mockAptDays(apt);
    }
    if (chipEl) chipEl.className = 'ov-chip done';
    return { apt: apt, days: days };
  } catch (e) {
    console.warn('[' + apt.code + '] API 실패, 목업 사용:', e.message);
    if (chipEl) chipEl.className = 'ov-chip err';
    return { apt: apt, days: mockAptDays(apt) };
  }
}

/* 전체 로드 + 렌더 */
async function loadAll() {
  var dates = buildOvDates();

  /* 상단 날짜/시각 갱신 */
  var now = new Date();
  var p2  = function(n) { return String(n).padStart(2, '0'); };
  var el  = document.getElementById('ov-dateline');
  if (el) el.textContent =
    (now.getMonth()+1) + '월 ' + now.getDate() + '일  ' +
    DAYS_KO[now.getDay()] + '요일  ' +
    p2(now.getHours()) + '시 ' + p2(now.getMinutes()) + '분 기준';

  /* 진행 칩 생성 */
  var prog = document.getElementById('ov-progress');
  var chips = {};
  if (prog) {
    prog.innerHTML = '';
    AIRPORTS.forEach(function(apt) {
      var s = document.createElement('span');
      s.className = 'ov-chip';
      s.textContent = apt.name;
      s.id = 'chip-' + apt.code;
      prog.appendChild(s);
      chips[apt.code] = s;
    });
  }

  /* 3개씩 배치 로드 */
  var allData = [];
  var BATCH = 3;
  for (var i = 0; i < AIRPORTS.length; i += BATCH) {
    var batch = AIRPORTS.slice(i, i + BATCH);
    var results = await Promise.allSettled(
      batch.map(function(apt) { return loadAptData(apt, chips[apt.code]); })
    );
    results.forEach(function(r, j) {
      if (r.status === 'fulfilled') allData.push(r.value);
      else allData.push({ apt: batch[j], days: mockAptDays(batch[j]) });
    });
    if (i + BATCH < AIRPORTS.length)
      await new Promise(function(res) { setTimeout(res, 300); });
  }

  renderOvTable(allData, dates);
}

function printOv() {
  window.print();
}

/* 초기화 */
window.addEventListener('DOMContentLoaded', async function() {
  await CONFIG.ready;
  await loadAll();
  /* 10분 자동 갱신 */
  setInterval(loadAll, 10 * 60 * 1000);
});
