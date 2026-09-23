/* ===================================================
   앱 진입점 — 모드 관리, 초기화, 이벤트 처리
   =================================================== */

let currentMode  = 'normal';
let hourlyStep   = 3;   // 항상 3시간 간격이 기본값
let modeManual   = false; // 사용자가 직접 모드를 바꾼 경우 자동감지 안함
let _autoRefreshTimer = null; // 자동갱신 타이머

/* ===================== 초기화 ===================== */
window.addEventListener('DOMContentLoaded', async () => {
  await CONFIG.ready;   // 서버 설정 로드 완료 후 진행
  loadSettings();
  updateDocDate();
  initAirportPanel();   // setAirport() → refreshData() 호출 포함

});

/* 다음 자동갱신까지 대기 시간: 다음 발표시각+5분에 맞추되 최대 10분 */
function _msUntilNextRefresh() {
  const now = new Date();
  const totalMin = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
  const baseHours = [2, 5, 8, 11, 14, 17, 20, 23];
  const BUF = 5;
  for (const bh of baseHours) {
    const triggerMin = bh * 60 + BUF;
    if (totalMin < triggerMin) {
      const ms = (triggerMin - totalMin) * 60 * 1000;
      return Math.min(ms, 10 * 60 * 1000); // 최대 10분
    }
  }
  // 23:05 이후 → 다음날 02:05까지
  const ms = ((24 * 60 + 2 * 60 + BUF) - totalMin) * 60 * 1000;
  return Math.min(ms, 10 * 60 * 1000);
}

/* ===================== 데이터 로드 ===================== */
async function refreshData() {
  // 이전 타이머 초기화 (중복 방지)
  clearTimeout(_autoRefreshTimer);

  document.getElementById('last-update').textContent = '로딩 중...';
  try {
    APP_DATA = await fetchWeatherData(currentMode);
    renderAll();
    const t   = APP_DATA.generatedAt;
    const src = APP_DATA.isReal ? '✓ 기상청' : '⚠ 목업';

    // 초단기예보 실황 정보 상태바 표시
    let ncstStr = '';
    if (APP_DATA.ncstData) {
      const n = APP_DATA.ncstData;
      const bh = n.baseTime.slice(0, 2), bm = n.baseTime.slice(2, 4);
      const ptyLabel = ['', '비', '비/눈', '눈', '소나기'][n.pty] || '';
      const condStr  = n.pty > 0
        ? `${ptyLabel}${n.rn1 > 0 ? ' ' + n.rn1 + 'mm/h' : ''}`
        : `${n.tmp}℃`;
      ncstStr = ` · 실황 ${bh}:${bm} ${condStr}`;
    }

    document.getElementById('last-update').textContent =
      `${t.getMonth()+1}/${t.getDate()} ${pad2(t.getHours())}:${pad2(t.getMinutes())} ${src}${ncstStr}`;
    // 최근발표시각 표시
    const btEl = document.getElementById('base-time-display');
    if (btEl) btEl.textContent = APP_DATA.baseTimeDisplay || '-';
    // 특보 자동 업데이트
    if (APP_DATA.weatherWarnings !== undefined) updateWeatherWarnings(APP_DATA.weatherWarnings);
  } catch (e) {
    console.error(e);
    document.getElementById('last-update').textContent = '업데이트 실패';
  } finally {
    _autoRefreshTimer = setTimeout(refreshData, _msUntilNextRefresh());
  }
}

function renderAll() {
  if (!APP_DATA) return;

  // 사용자가 모드를 직접 선택하지 않은 경우 → 주말 강우 자동감지
  if (!modeManual) {
    const detected = detectMode(APP_DATA);
    if (detected !== currentMode) applyMode(detected);
  }

  if (APP_DATA.dailyRows) renderDailyTable(APP_DATA.dailyRows);
  renderHourlyTable(APP_DATA.hourlyRows, hourlyStep, currentMode);
  if (currentMode === 'normal') updateNormalSummary(APP_DATA);
  if (currentMode === 'rain')   updateRainSummary(APP_DATA);
}

/* 강우 모드 자동감지 — 향후 72시간 내 비(pty>0) 또는 강수확률 50% 이상 */
function detectMode(data) {
  const now   = new Date();
  const limit = new Date(now.getTime() + 72 * 3600 * 1000);

  const hasRain = data.hourlyRows.some(r =>
    r.time >= now && r.time <= limit && (r.pty > 0 || r.pop >= 50)
  );
  return hasRain ? 'rain' : 'normal';
}

/* 모드 UI 반영 (내부 공통 함수) */
function applyMode(mode) {
  currentMode = mode;
  // 상단 바 + 모바일 하단 바 동기화
  ['btn-normal','mb-btn-normal'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('active', mode === 'normal');
  });
  ['btn-rain','mb-btn-rain'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('active', mode === 'rain');
  });
  document.getElementById('sec-normal').style.display     = mode === 'normal' ? '' : 'none';
  document.getElementById('sec-rain').style.display       = mode === 'rain'   ? '' : 'none';
  document.getElementById('sec-rain-extra').style.display = mode === 'rain'   ? '' : 'none';
}

/* ===================== 모드 전환 (사용자 직접 선택) ===================== */
function setMode(mode) {
  modeManual = true;  // 이후 자동감지 비활성
  applyMode(mode);
  if (APP_DATA) {
    renderHourlyTable(APP_DATA.hourlyRows, hourlyStep, currentMode);
    if (currentMode === 'normal') updateNormalSummary(APP_DATA);
    if (currentMode === 'rain')   updateRainSummary(APP_DATA);
  } else {
    refreshData();
  }
}

/* ===================== 시간 간격 전환 ===================== */
function setHourlyStep(step) {
  hourlyStep = step;
  document.getElementById('tab-3h').classList.toggle('active', step === 3);
  document.getElementById('tab-1h').classList.toggle('active', step === 1);
  if (APP_DATA) renderHourlyTable(APP_DATA.hourlyRows, step, currentMode);
}

/* ===================== 문서 날짜 표시 ===================== */
function updateDocDate() {
  const el = document.getElementById('doc-date');
  if (el) el.textContent = fmtDocDate(new Date());
}

/* ===================== 일반 모드 요약 자동 채우기 ===================== */
function updateNormalSummary(data) {
  const today = new Date();
  const dow   = today.getDay();

  // 기간 제목
  const titleEl = document.getElementById('sec-normal-title');
  if (titleEl) {
    const { sat, sun } = getWeekendRange(today);
    const fFull  = (d) => `'${String(d.getFullYear()).slice(2)}. ${d.getMonth()+1}. ${d.getDate()}.`;
    const fShort = (d) => `${d.getMonth()+1}. ${d.getDate()}.`;
    let prefix, from, to;
    if (dow === 5) {
      // 금요일: 오늘~일요일 (오늘 비도 포함)
      prefix = '금주'; from = today; to = sun;
    } else if (dow === 6) {
      // 토요일: 금주 주말 (오늘~내일 일요일)
      prefix = '금주 주말'; from = today;
      to = new Date(today); to.setDate(today.getDate() + 1);
    } else if (dow === 0) {
      if (today.getHours() < 12) {
        // 일요일 오전: 금주 주말 (오늘만)
        prefix = '금주 주말'; from = today; to = today;
      } else {
        // 일요일 오후: 평일처럼 금주 (오늘~다음 금요일)
        prefix = '금주'; from = today;
        to = new Date(today); to.setDate(today.getDate() + 5);
      }
    } else {
      // 월~목: 금주 단기 (오늘~이번 주 금요일)
      prefix = '금주'; from = today;
      const fri = new Date(today);
      fri.setDate(today.getDate() + (5 - dow));
      to = fri;
    }
    titleEl.textContent = `□ ${prefix} (${fFull(from)} ~ ${fShort(to)}) 기상예보`;
  }

  // 제목과 동일한 기간으로 hourlyRows 필터 (기온은 하루 시작부터)
  const { sat, sun } = getWeekendRange(today);
  const todayStart = new Date(today); todayStart.setHours(0, 0, 0, 0);
  let periodFrom, periodTo;
  if (dow === 5) {
    // 금요일: 오늘~일요일 (오늘 비도 반영)
    periodFrom = todayStart; periodTo = sun;
  } else if (dow === 6) {
    // 토요일: 오늘~내일 일요일
    periodFrom = todayStart;
    periodTo = new Date(today); periodTo.setDate(today.getDate() + 1);
  } else if (dow === 0) {
    if (today.getHours() < 12) {
      // 일요일 오전: 오늘만
      periodFrom = todayStart; periodTo = today;
    } else {
      // 일요일 오후: 오늘~다음 금요일
      periodFrom = todayStart;
      periodTo = new Date(today); periodTo.setDate(today.getDate() + 5);
    }
  } else {
    // 월~목: 오늘 0시 ~ 이번 주 금요일
    periodFrom = todayStart;
    periodTo   = new Date(today);
    periodTo.setDate(today.getDate() + (5 - dow));
  }
  const periodEnd = new Date(periodTo);
  periodEnd.setHours(23, 59, 59, 999);

  const rows = (data.hourlyRows || []).filter(r => r.time >= periodFrom && r.time <= periodEnd);
  if (rows.length === 0) return;

  // 기온
  const tmin = Math.min(...rows.map(r => r.tmp));
  const tmax = Math.max(...rows.map(r => r.tmp));
  setText('v-tmin', tmin);
  setText('v-tmax', tmax);

  // 강수량 — 기간 총량 + 집중 시간대 표시
  const hasTrace = rows.some(r => r.pcpRaw === '1mm 미만');
  const totalPcp = rows.reduce((s, r) => s + Math.max(0, r.pcp || 0), 0);
  const vRain    = document.getElementById('v-rainfall');
  if (vRain) {
    if (totalPcp >= 1) {
      const range = pcpRange(totalPcp);
      const intense = findIntenseSegment(rows, totalPcp);
      let rainStr = `${range} 예상`;
      if (intense) {
        const fmtMDdow = t => `${t.getMonth()+1}/${t.getDate()}(${DAYS_KO[t.getDay()]})`;
        const fmtH2    = t => `${String(t.getHours()).padStart(2, '0')}시`;
        const sameDay  = intense.start.toDateString() === intense.end.toDateString();
        rainStr += sameDay
          ? ` [${fmtMDdow(intense.start)} ${fmtH2(intense.start)}~${fmtH2(intense.end)}]`
          : ` [${fmtMDdow(intense.start)} ${fmtH2(intense.start)} ~ ${fmtMDdow(intense.end)} ${fmtH2(intense.end)}]`;
      }
      vRain.textContent = rainStr;
    } else if (hasTrace) {
      vRain.textContent = '1mm 미만';
    } else {
      vRain.textContent = '없음';
    }
  }
}

/* ===================== 명절 연휴 기상개황 통보문 =====================
   설날·추석처럼 연휴가 단기예보(3일) 범위를 넘어가면, 넘어가는 날짜만
   중기예보(getMidLandFcst/getMidTa, D+4~D+10)로 보완해 일자별 서술형 문장으로 표시.
   기존 강수량/기온/특보 표는 그대로 두고 그 위에 통보문 문단만 추가한다. */

/* 중기예보 발표시각 계산 — 06:00/18:00 기준 (overview.js와 동일 로직) */
function getMidTmFc() {
  const now = new Date();
  const p2  = n => String(n).padStart(2, '0');
  const d   = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const h = now.getHours(), m = now.getMinutes();
  let base;
  if (h > 18 || (h === 18 && m >= 10)) base = 18;
  else if (h > 6 || (h === 6 && m >= 10)) base = 6;
  else { d.setDate(d.getDate() - 1); base = 18; }
  const ds = `${d.getFullYear()}${p2(d.getMonth()+1)}${p2(d.getDate())}`;
  return { tmFc: ds + p2(base) + '00', issuanceDate: d, base };
}

async function kmaFetchMidRaw(endpoint, regId, tmFc) {
  const url = new URL(`https://apis.data.go.kr/1360000/MidFcstInfoService/${endpoint}`);
  const key = CONFIG.API_KEY.includes('%') ? decodeURIComponent(CONFIG.API_KEY) : CONFIG.API_KEY;
  url.searchParams.set('serviceKey', key);
  url.searchParams.set('numOfRows', '10');
  url.searchParams.set('pageNo',    '1');
  url.searchParams.set('dataType',  'JSON');
  url.searchParams.set('regId',     regId);
  url.searchParams.set('tmFc',      tmFc);
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const json = await res.json();
  if (json?.response?.header?.resultCode !== '00') throw new Error('MID ' + json?.response?.header?.resultCode);
  const item = json.response.body.items.item;
  if (!item) return null;
  return Array.isArray(item) ? item[0] : item;
}

/* 중기예보 날씨 문자열 → {pty, sky} (overview.js wfToWx와 동일 로직) */
function wfToWxLocal(wf) {
  if (!wf) return { pty: 0, sky: 1 };
  const s = String(wf).trim();
  if (s.includes('소나기'))                        return { pty: 4, sky: 4 };
  if (s.includes('비/눈') || s.includes('눈/비'))  return { pty: 2, sky: 4 };
  if (s.includes('눈'))                            return { pty: 3, sky: 4 };
  if (s.includes('비') || s.includes('강수'))       return { pty: 1, sky: 4 };
  if (s.includes('흐림'))                          return { pty: 0, sky: 4 };
  if (s.includes('구름많'))                        return { pty: 0, sky: 3 };
  if (s.includes('구름조'))                        return { pty: 0, sky: 2 };
  return { pty: 0, sky: 1 };
}

/* 현재 선택 공항의 중기예보 조회 — 최신 발표 미준비 시 이전 발표로 재시도 */
async function fetchMidTermForCurrentAirport() {
  const code = localStorage.getItem('airport_code') || 'PUS';
  const apt  = AIRPORTS.find(a => a.code === code) || AIRPORTS.find(a => a.code === 'PUS');
  const mt   = getMidTmFc();

  async function fetchBoth(tmFc) {
    const [fcstItem, taItem] = await Promise.all([
      kmaFetchMidRaw('getMidLandFcst', apt.midFcst, tmFc).catch(() => null),
      kmaFetchMidRaw('getMidTa',   apt.midTa,   tmFc).catch(() => null),
    ]);
    return { fcstItem, taItem };
  }

  let result = await fetchBoth(mt.tmFc);
  let issuanceDate = mt.issuanceDate;
  if (!result.taItem) {
    const p2 = n => String(n).padStart(2, '0');
    const prevD = new Date(mt.issuanceDate);
    const prevBase = mt.base === 18 ? 6 : (prevD.setDate(prevD.getDate() - 1), 18);
    const prevTmFc = `${prevD.getFullYear()}${p2(prevD.getMonth()+1)}${p2(prevD.getDate())}${p2(prevBase)}00`;
    const retry = await fetchBoth(prevTmFc);
    if (retry.taItem) { result = retry; issuanceDate = prevD; }
  }

  return { fcstItem: result.fcstItem, taItem: result.taItem, issuanceDate };
}

/* 날씨상태(pty/sky) → 서술형 어구 */
function holidaySkyPhrase(sky, pty) {
  if (pty === 4) return '소나기가 오는 곳이 있겠으며';
  if (pty === 3) return '눈이 오겠으며';
  if (pty === 2) return '비나 눈이 오겠으며';
  if (pty === 1) return '비가 오겠으며';
  if (sky === 4) return '흐리겠으며';
  if (sky === 3) return '구름이 많겠으며';
  if (sky === 2) return '구름이 조금 있겠으며';
  return '대체로 맑겠으며';
}

async function updateHolidayOverview(data) {
  const el = document.getElementById('v-overview');
  if (!el) return;

  const today = new Date();
  const block = getUpcomingHolidayBlock(today, 14);
  if (!block) { el.textContent = '해당없음'; return; }

  const fShort = d => `${d.getMonth()+1}.${d.getDate()}`;

  const days = [];
  for (let d = new Date(block.from); d <= block.to; d.setDate(d.getDate() + 1)) days.push(new Date(d));

  const perDay = days.map(day => {
    const dayStart = new Date(day); dayStart.setHours(0, 0, 0, 0);
    const dayEnd   = new Date(day); dayEnd.setHours(23, 59, 59, 999);
    const rows = (data.hourlyRows || []).filter(r => r.time >= dayStart && r.time <= dayEnd);
    if (!rows.length) return { date: day, tmin: null, tmax: null, pop: null, sky: 1, pty: 0 };
    const tmin = Math.min(...rows.map(r => r.tmp));
    const tmax = Math.max(...rows.map(r => r.tmp));
    const pop  = Math.max(...rows.map(r => r.pop || 0));
    let sky = 1, pty = 0;
    rows.forEach(r => { if (r.pty > pty || (r.pty === pty && r.sky > sky)) { sky = r.sky; pty = r.pty; } });
    return { date: day, tmin, tmax, pop, sky, pty };
  });

  /* 단기예보 범위 밖(그 날짜 hourlyRows가 아예 없는 경우)만 중기예보로 보완 */
  if (perDay.some(d => d.tmin === null)) {
    try {
      const mid = await fetchMidTermForCurrentAirport();
      const issuanceDay = new Date(mid.issuanceDate.getFullYear(), mid.issuanceDate.getMonth(), mid.issuanceDate.getDate());
      perDay.forEach(d => {
        if (d.tmin !== null) return;
        const dayOnly = new Date(d.date.getFullYear(), d.date.getMonth(), d.date.getDate());
        const n = Math.round((dayOnly - issuanceDay) / 86400000);
        if (n < 4 || n > 10) return; /* getMidLandFcst/getMidTa는 D+4부터 필드가 존재 */
        if (mid.taItem) {
          const mn = mid.taItem['taMin' + n], mx = mid.taItem['taMax' + n];
          if (mn != null) d.tmin = parseFloat(mn);
          if (mx != null) d.tmax = parseFloat(mx);
        }
        if (mid.fcstItem) {
          const amWf  = mid.fcstItem['wf' + n + 'Am'] || mid.fcstItem['wf' + n];
          const pmWf  = mid.fcstItem['wf' + n + 'Pm'] || mid.fcstItem['wf' + n];
          const amWx  = wfToWxLocal(amWf), pmWx = wfToWxLocal(pmWf);
          d.sky = Math.max(amWx.sky, pmWx.sky);
          d.pty = Math.max(amWx.pty, pmWx.pty);
          const amPop = mid.fcstItem['rnSt' + n + 'Am'] ?? mid.fcstItem['rnSt' + n];
          const pmPop = mid.fcstItem['rnSt' + n + 'Pm'] ?? mid.fcstItem['rnSt' + n];
          if (amPop != null || pmPop != null) d.pop = Math.max(parseInt(amPop || 0), parseInt(pmPop || 0));
        }
      });
    } catch (e) { /* 중기예보 조회 실패 시 해당 날짜는 정보 없음으로 표시 */ }
  }

  const validDays = perDay.filter(d => d.tmin !== null && d.tmax !== null);
  if (!validDays.length) { el.textContent = '예보 자료가 아직 없습니다.'; return; }

  const tmin = Math.min(...validDays.map(d => d.tmin));
  const tmax = Math.max(...validDays.map(d => d.tmax));
  const pop  = Math.max(...validDays.map(d => d.pop || 0));
  let sky = 1, pty = 0;
  validDays.forEach(d => { if (d.pty > pty || (d.pty === pty && d.sky > sky)) { sky = d.sky; pty = d.pty; } });

  const dateRange = `${fShort(block.from)}~${fShort(block.to)}`;
  el.textContent = `${block.name}연휴(${dateRange}) 기간 전반적으로 ${holidaySkyPhrase(sky, pty)}, `
    + `강수확률 최대 ${Math.round(pop)}%, 기온은 ${Math.round(tmin)}~${Math.round(tmax)}℃ 분포를 보이겠습니다.`;
}

/* ===================== 예상강수량 범위 표현 ===================== */
function pcpRange(mm) {
  if (mm <= 0) return '없음';
  if (mm < 20) return `${Math.round(mm)}mm`;
  if (mm < 100) {
    const lo = Math.floor(mm / 10) * 10;
    return `${lo}~${lo + 10}mm`;
  } else {
    const lo = Math.floor(mm / 20) * 20;
    return `${lo}~${lo + 20}mm`;
  }
}

/* ===================== 집중강수시간대 구간 탐색 ===================== */
function findIntenseSegment(futureRows, expectedTotal) {
  // 총 예상강수량 50mm 초과: 시간당 5mm 미만 구간은 집중으로 보지 않음
  // (단, 양쪽에 5mm 이상 구간이 있고 공백이 6시간 미만이면 포함)
  // 5mm 이상 해당 시간이 2시간 미만이면 4mm까지 완화 (집중 의미 확보)
  let threshold = expectedTotal > 50 ? 5 : 1;
  const maxGapH = expectedTotal > 50 ? 6 : 3;

  if (threshold === 5 && futureRows.filter(r => r.pcp >= 5).length < 2) {
    threshold = 4;
  }

  const heavy = futureRows.filter(r => r.pcp >= threshold);
  if (heavy.length === 0) return null;

  // heavy 시간대 기준으로 구간 분리
  const segs = [];
  let segStart = heavy[0].time;
  let segLast  = heavy[0].time;

  for (let i = 1; i < heavy.length; i++) {
    const gapH = (heavy[i].time - segLast) / 3600000;
    if (gapH < maxGapH) {
      segLast = heavy[i].time;          // 공백 < 기준 → 같은 구간 (소강 포함)
    } else {
      segs.push({ start: segStart, end: segLast });
      segStart = heavy[i].time;
      segLast  = heavy[i].time;
    }
  }
  segs.push({ start: segStart, end: segLast });

  // 각 구간의 총 강수량: 스팬 내 모든 시간(소강 포함) 합산
  const segTotals = segs.map(seg => {
    const total = futureRows
      .filter(r => r.time >= seg.start && r.time <= seg.end)
      .reduce((s, r) => s + Math.max(0, r.pcp || 0), 0);
    return { ...seg, total };
  });

  return segTotals.reduce((best, s) => s.total > best.total ? s : best);
}

/* ===================== 강우 모드 요약 자동 채우기 ===================== */
function updateRainSummary(data) {
  const today    = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);

  const todayDow  = DAYS_KO[today.getDay()];

  // 날짜 표시 필드
  setText('v-rain-day', `${today.getDate()}일`);

  // 강우 기간: 미래 강수 예상 시간대의 실제 날짜 범위 (월 경계 고려)
  const rainyRows = (data.hourlyRows || []).filter(r => r.time > today && r.pcp > 0);
  let rainPeriodStr;
  if (rainyRows.length > 0) {
    const first = rainyRows[0].time;
    const last  = rainyRows[rainyRows.length - 1].time;
    const fmtD  = t => `${t.getMonth()+1}/${t.getDate()}`;
    rainPeriodStr = first.toDateString() === last.toDateString()
      ? `${first.getDate()}일`
      : `${fmtD(first)}~${fmtD(last)}`;
  } else {
    rainPeriodStr = `${today.getDate()}~${tomorrow.getDate()}일`;
  }
  setText('v-rain-period', rainPeriodStr);

  // 누적강수량: 오늘 0시 ~ 현재 시점까지 실제 경과 시간만 합산
  // (단기예보는 기준시각이 넘어가면 지난 시간대 값이 API 응답에서 사라지므로,
  //  hourlyRows 대신 매 호출마다 기록해둔 원장(getAccumPcpToday)을 사용)
  const accum = getAccumPcpToday();
  setText('v-accum', accum >= 1 ? `${Math.round(accum)}mm` : '없음');

  // 예상강수량: 현재 이후 미래 강수량 자동 합산
  const futureRows = data.hourlyRows.filter(r => r.time > today);
  const expectedTotal = futureRows.reduce((s, r) => s + Math.max(0, r.pcp || 0), 0);
  setText('v-expected', expectedTotal > 0 ? pcpRange(expectedTotal) : '없음');

  // 집중강수시간대
  const vIntense = document.getElementById('v-intense');
  if (vIntense) {
    const intense = findIntenseSegment(futureRows, expectedTotal);
    if (!intense) {
      vIntense.textContent = '해당없음';
    } else {
      const fmt     = t => `${t.getMonth()+1}/${t.getDate()}(${DAYS_KO[t.getDay()]}) ${pad2(t.getHours())}시`;
      const sameDay = intense.start.toDateString() === intense.end.toDateString();
      const fmtEnd  = sameDay
        ? `${pad2(intense.end.getHours())}시`
        : fmt(intense.end);
      vIntense.textContent = `${fmt(intense.start)} ~ ${fmtEnd}(${Math.round(intense.total)}mm)`;
    }
  }

  updateHolidayOverview(data);
}

/* ===================== 공통 유틸 ===================== */
function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

/* ===================== 조치사항 추가 ===================== */
function addMeasure() {
  const list = document.getElementById('measures-list');
  const div  = document.createElement('div');
  div.className = 'it-row';
  div.innerHTML = `<span class="it-bull">ㅇ</span><span class="it-val ce" contenteditable="true">내용을 입력하세요</span><button class="no-print add-row-btn rm" onclick="this.parentElement.remove()">×</button>`;
  list.appendChild(div);
  div.querySelector('[contenteditable]').focus();
}

/* ===================== 강우 모드 행 추가 ===================== */
function addRainRow(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const div = document.createElement('div');
  div.className = 'it-row extra-row';
  div.innerHTML =
    '<span class="it-val ce" contenteditable="true" style="flex:1;min-width:120px"></span>' +
    '<button class="no-print add-row-btn rm" onclick="this.parentElement.remove()">×</button>';
  container.appendChild(div);
  div.querySelector('[contenteditable]').focus();
}

/* ===================== 설정 패널 ===================== */
function toggleSettings() {
  const el = document.getElementById('settings-panel');
  el.style.display = el.style.display === 'none' ? '' : 'none';
}

function saveSettings() {
  const key = document.getElementById('inp-apikey').value.trim();
  const dam = document.getElementById('inp-dam').value;

  if (key) CONFIG.API_KEY = key;
  CONFIG.SHOW_DAM = (dam === 'show');

  // localStorage 저장
  if (key) localStorage.setItem('kma_api_key', key);
  localStorage.setItem('show_dam', dam);

  // 서버에 저장: saved_config.json + apikey.js 파일 자체 업데이트
  const payload = JSON.stringify({ api_key: key || CONFIG.API_KEY, show_dam: dam !== 'hide' });
  fetch('/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
  }).catch(() => {});

  toggleSettings();
  refreshData();
}

function loadSettings() {
  // localStorage 우선, 없으면 apikey.js의 기본 키(CONFIG.API_KEY)로 폴백
  const key = localStorage.getItem('kma_api_key') || CONFIG.API_KEY || '';
  const dam = localStorage.getItem('show_dam') || 'show';
  // localStorage에 키가 없으면 기본 키를 저장해 두어 다음에도 유지
  if (key && !localStorage.getItem('kma_api_key')) localStorage.setItem('kma_api_key', key);
  const el  = document.getElementById('inp-apikey');
  if (el) el.value = key;
  const ds  = document.getElementById('inp-dam');
  if (ds) ds.value = dam;
  // localStorage 키를 CONFIG에 반영 (서버 설정 부재 시에도 동작)
  if (key) CONFIG.API_KEY = key;
  CONFIG.SHOW_DAM = (dam !== 'hide');
}

/* ===================== 특보 표시 ===================== */
function updateWeatherWarnings(warnings) {
  const el      = document.getElementById('v-special');
  const elAlert = document.getElementById('v-alert');
  if (!warnings || warnings.length === 0) {
    if (el)      el.textContent = '해당없음';
    if (elAlert) elAlert.textContent = '해당없음';
    return;
  }

  function parseDT(s) {
    if (!s) return null;
    s = String(s).replace(/\D/g, '');   // 날짜 구분자(-, /, 공백 등) 제거
    if (s.length < 8) return null;
    return {
      y:   s.slice(2, 4),
      m:   parseInt(s.slice(4, 6)),
      d:   parseInt(s.slice(6, 8)),
      h:   s.length >= 10 ? parseInt(s.slice(8, 10)) : 0,
      min: s.length >= 12 ? parseInt(s.slice(10, 12)) : 0,
    };
  }

  function fmtWarning(w) {
    const title = w.wrnTitle || w.title || '';
    const area  = w.area || w.areaFc || '';

    const stDT = parseDT(w.tmSt) || parseDT(w.tmFc);
    const edDT = parseDT(w.tmEd);

    let timePart = '';
    if (stDT) {
      const dateStr = `'${stDT.y}.${stDT.m}.${stDT.d}`;
      const startT  = `${pad2(stDT.h)}:${pad2(stDT.min)}`;
      const endT    = edDT ? `~${pad2(edDT.h)}:${pad2(edDT.min)}` : '~';
      timePart = area
        ? `[${area}, ${dateStr} ${startT} ${endT}]`
        : `[${dateStr} ${startT} ${endT}]`;
    } else if (area) {
      timePart = `[${area}]`;
    }

    const prefix = w.isPreliminary ? '[예비특보] ' : '';
    return `${prefix}${title}${timePart}`;
  }

  const texts = warnings.map(fmtWarning).filter(Boolean).join(', ');

  if (el)      el.textContent = texts || '해당없음';
  if (elAlert) elAlert.textContent = texts || '해당없음';
}

/* ===================== QR 모달 ===================== */
function showQR() {
  const modal = document.getElementById('qr-modal');
  const box   = document.getElementById('qr-code');
  const urlEl = document.getElementById('qr-url-text');
  const url   = window.location.href.replace('localhost', location.hostname);

  box.innerHTML = '';
  if (typeof QRCode !== 'undefined') {
    new QRCode(box, { text: url, width: 200, height: 200, correctLevel: QRCode.CorrectLevel.M });
  } else {
    box.textContent = url;
  }
  urlEl.textContent = url;
  modal.style.display = 'flex';
}

/* ===================== 인쇄 — 화면 그대로 이미지로 출력 ===================== */
function printDoc() {
  const now    = new Date();
  const y      = String(now.getFullYear()).slice(2);
  const m      = now.getMonth() + 1;
  const d      = now.getDate();
  const h      = now.getHours();
  const suffix = currentMode === 'rain' ? '_강우' : '';
  const title  = `김해공항 기상정보('${y}.${m}.${d}. ${h}시)${suffix}`;

  if (typeof html2canvas === 'undefined') {
    // html2canvas 로드 실패 시 브라우저 기본 출력 폴백
    const orig = document.title;
    document.title = title;
    window.print();
    window.addEventListener('afterprint', function r() {
      document.title = orig;
      window.removeEventListener('afterprint', r);
    });
    return;
  }

  const target = document.getElementById('doc-page');
  html2canvas(target, { scale: 2, useCORS: true, logging: false }).then(function(canvas) {
    const imgUrl = canvas.toDataURL('image/png');
    const win = window.open('', '_blank');
    if (!win) { alert('팝업 차단을 해제해 주세요.'); return; }
    win.document.write(
      '<!DOCTYPE html><html><head>' +
      '<meta charset="UTF-8"><title>' + title + '</title>' +
      '<style>*{margin:0;padding:0}body{background:#fff}' +
      'img{width:100%;display:block}' +
      '@media print{img{width:100%}@page{margin:0}}' +
      '</style></head><body>' +
      '<img src="' + imgUrl + '" onload="window.print()">' +
      '</body></html>'
    );
    win.document.close();
  });
}

/* ===================== 공항 선택 ===================== */
function initAirportPanel() {
  const grid = document.getElementById('apt-grid');
  if (!grid) return;
  AIRPORTS.forEach(apt => {
    const btn = document.createElement('button');
    btn.className = 'apt-btn';
    btn.dataset.code = apt.code;
    btn.innerHTML =
      `<span class="apt-name">${apt.name}</span>` +
      `<span class="apt-city">${apt.code}</span>`;
    btn.addEventListener('click', () => setAirport(apt.code));
    grid.appendChild(btn);
  });
  const urlApt = new URLSearchParams(location.search).get('apt');
  const saved  = urlApt || localStorage.getItem('airport_code') || 'PUS';
  // 유효하지 않은 코드면 기본값으로 fallback
  const validCode = AIRPORTS.find(a => a.code === saved) ? saved : 'PUS';
  setAirport(validCode);
}

function setAirport(code) {
  const apt = AIRPORTS.find(a => a.code === code);
  if (!apt) return;
  CONFIG.NX = apt.nx;
  CONFIG.NY = apt.ny;
  localStorage.setItem('airport_code', code);

  document.querySelectorAll('.apt-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.code === code);
  });

  const deptText  = apt.dept ? `${apt.name}공항 ${apt.dept}` : `${apt.name}공항`;
  const titleText = `${apt.name}공항 기상정보`;
  setText('doc-dept',      deptText);
  setText('doc-title-el',  titleText);
  setText('doc-foot-dept', deptText);
  setText('ctrl-location', apt.location);
  const ctEl = document.getElementById('ctrl-title-el');
  if (ctEl) ctEl.textContent = `${apt.name}공항 기상정보 시스템`;

  modeManual = false;
  refreshData();

  const panel = document.getElementById('airport-panel');
  if (panel) panel.style.display = 'none';
}

function toggleAirportPanel() {
  const panel = document.getElementById('airport-panel');
  if (!panel) return;
  const isOpen = panel.style.display !== 'none';
  panel.style.display = isOpen ? 'none' : '';
}

/* ===================== 비밀 위치 ===================== */
function setSecretLocation(location, label, nx, ny, midFcst, midTa) {
  CONFIG.NX = nx;
  CONFIG.NY = ny;
  CONFIG.MID_FCST = midFcst;
  CONFIG.MID_TA   = midTa;

  document.querySelectorAll('.apt-btn').forEach(b => b.classList.remove('active'));

  setText('doc-dept',      label);
  setText('doc-title-el',  label + ' 기상정보');
  setText('doc-foot-dept', label);
  setText('ctrl-location', location);
  const ctEl = document.getElementById('ctrl-title-el');
  if (ctEl) ctEl.textContent = label + ' 기상정보';

  modeManual = false;
  refreshData();

  const panel = document.getElementById('airport-panel');
  if (panel) panel.style.display = 'none';
}

/* ===================== 유틸 ===================== */
function pad2(n) { return String(n).padStart(2, '0'); }
