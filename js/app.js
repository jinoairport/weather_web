/* ===================================================
   앱 진입점 — 모드 관리, 초기화, 이벤트 처리
   =================================================== */

let currentMode  = 'normal';
let hourlyStep   = 3;   // 항상 3시간 간격이 기본값
let modeManual   = false; // 사용자가 직접 모드를 바꾼 경우 자동감지 안함

/* ===================== 초기화 ===================== */
window.addEventListener('DOMContentLoaded', async () => {
  await CONFIG.ready;   // 서버 설정 로드 완료 후 진행
  loadSettings();
  updateDocDate();
  refreshData();

  // 5분마다 자동 새로고침 (초단기실황은 매시 갱신, 특보 변화 빠르게 반영)
  setInterval(refreshData, 5 * 60 * 1000);
});

/* ===================== 데이터 로드 ===================== */
async function refreshData() {
  document.getElementById('last-update').textContent = '로딩 중...';
  try {
    APP_DATA = await fetchWeatherData(currentMode);
    renderAll();
    const t   = APP_DATA.generatedAt;
    const src = APP_DATA.isReal ? '✓ 기상청' : '⚠ 목업';

    // 초단기실황 정보 상태바 표시 (매 10분 갱신)
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
      // 금요일: 이번 주말 예보
      prefix = '주말'; from = sat; to = sun;
    } else if (dow === 6 || dow === 0) {
      // 토·일: 금주 주말 (오늘~일요일)
      prefix = '금주 주말'; from = today;
      to = dow === 6 ? sun : today; // 토→일, 일→오늘
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
    // 금요일: 토~일
    periodFrom = sat; periodTo = sun;
  } else if (dow === 6) {
    // 토요일: 오늘~일
    periodFrom = todayStart; periodTo = sun;
  } else if (dow === 0) {
    // 일요일: 오늘만
    periodFrom = todayStart; periodTo = today;
  } else {
    // 월~목: 오늘 0시 ~ 이번 주 금요일 (기온 범위 누락 방지)
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

  // 강수량 — 실측 pcp 합계 기준으로만 표시, 수치 없으면 '없음'
  const hasTrace = rows.some(r => r.pcpRaw === '1mm 미만');
  const totalPcp = rows.reduce((s, r) => s + Math.max(0, r.pcp || 0), 0);
  const vRain    = document.getElementById('v-rainfall');
  if (vRain) {
    if      (totalPcp >= 1)  vRain.textContent = `약 ${Math.round(totalPcp)}mm`;
    else if (hasTrace)       vRain.textContent = '1mm 미만';
    else                     vRain.textContent = '없음';
  }
}

/* ===================== 예상강수량 범위 표현 ===================== */
function pcpRange(mm) {
  if (mm <= 0) return '없음';
  if (mm < 100) {
    // 10mm 단위 반올림 후 ±10mm 범위
    const center = Math.round(mm / 10) * 10;
    return `${Math.max(0, center - 10)}~${center + 10}mm`;
  } else {
    // 100mm 이상: 아래 10mm 내림-10, 위 10mm 올림+10 (약 30mm 폭)
    const lo = Math.floor(mm / 10) * 10 - 10;
    const hi = Math.ceil(mm  / 10) * 10 + 10;
    return `${lo}~${hi}mm`;
  }
}

/* ===================== 집중강수시간대 구간 탐색 ===================== */
function findIntenseSegment(futureRows, expectedTotal) {
  // 총 예상강수량 50mm 초과: 시간당 5mm 미만 구간은 집중으로 보지 않음
  // (단, 양쪽에 5mm 이상 구간이 있고 공백이 6시간 미만이면 포함)
  const threshold = expectedTotal > 50 ? 5 : 1;
  const maxGapH   = expectedTotal > 50 ? 6 : 3;

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

  const todayD    = today.getDate();
  const tomorrowD = tomorrow.getDate();
  const todayDow  = DAYS_KO[today.getDay()];

  // 날짜 표시 필드
  setText('v-rain-day', `${todayD}일`);
  setText('v-rain-period', `${todayD}~${tomorrowD}일`);

  // 누적강수량: 오늘 0시 ~ 현재 시점까지 실제 경과 시간만 합산
  const pastRows = data.hourlyRows.filter(r =>
    r.time.toDateString() === today.toDateString() && r.time <= today
  );
  const accum = pastRows.reduce((s, r) => s + Math.max(0, r.pcp || 0), 0);
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
      const fmt = t => `${t.getDate()}일(${DAYS_KO[t.getDay()]}) ${t.getHours()}시`;
      vIntense.textContent = `${fmt(intense.start)} ~ ${fmt(intense.end)}(${Math.round(intense.total)}mm)`;
    }
  }
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
  div.innerHTML = `<span class="it-bull">ㅇ</span><span class="it-val ce" contenteditable="true">내용을 입력하세요</span>`;
  list.appendChild(div);
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

  // localStorage 폴백 저장
  if (key) localStorage.setItem('kma_api_key', key);
  localStorage.setItem('show_dam', dam);

  // 서버 파일에 저장 (주소 무관하게 유지)
  fetch('/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: key || CONFIG.API_KEY, show_dam: dam !== 'hide' })
  }).catch(() => {});

  toggleSettings();
  refreshData();
}

function loadSettings() {
  const key = localStorage.getItem('kma_api_key') || '';
  const dam = localStorage.getItem('show_dam') || 'show';
  const el  = document.getElementById('inp-apikey');
  if (el) el.value = key;
  const ds  = document.getElementById('inp-dam');
  if (ds) ds.value = dam;
  CONFIG.SHOW_DAM = (dam !== 'hide');
}

/* ===================== 특보 표시 ===================== */
function updateWeatherWarnings(warnings) {
  const el = document.getElementById('v-special');
  if (!el) return;
  if (!warnings || warnings.length === 0) {
    el.textContent = '해당없음';
    return;
  }

  function parseDT(s) {
    if (!s) return null;
    s = String(s);
    return { m: parseInt(s.slice(4,6)), d: parseInt(s.slice(6,8)), h: parseInt(s.slice(8,10)) };
  }

  const texts = warnings.map(w => {
    const title = w.wrnTitle || w.title || '';
    const area  = w.area || w.areaFc || '';
    const st    = w.wrnSt || '';

    const stDT = parseDT(w.tmSt) || parseDT(w.tmFc);
    const edDT = parseDT(w.tmEd);

    let timePart = '';
    if (stDT) {
      const dateStr = `${stDT.m}.${stDT.d}.`;
      const startH  = `${stDT.h}`;
      const endH    = edDT ? `~${edDT.h}시` : '시';
      timePart = `(${dateStr} ${startH}${endH}`;
      if (area) timePart += `, ${area} ${st}`;
      timePart += ')';
    } else if (area) {
      timePart = `(${area} ${st})`;
    }

    return `${title}${timePart}`;
  }).filter(Boolean).join(', ');

  el.textContent = texts || '해당없음';
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

/* ===================== 유틸 ===================== */
function pad2(n) { return String(n).padStart(2, '0'); }
