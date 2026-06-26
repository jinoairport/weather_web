/* ===================================================
   데이터 유틸리티 + 목업 데이터 생성
   =================================================== */

/* ---- 날씨누리 스타일 SVG 아이콘 ---- */
const WI_SVG = {
  sunny: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" width="26" height="26">
    <circle cx="14" cy="14" r="5.5" fill="#FFA726"/>
    <g stroke="#FFA726" stroke-width="1.8" stroke-linecap="round">
      <line x1="14" y1="2" x2="14" y2="5.5"/>
      <line x1="14" y1="22.5" x2="14" y2="26"/>
      <line x1="2" y1="14" x2="5.5" y2="14"/>
      <line x1="22.5" y1="14" x2="26" y2="14"/>
      <line x1="5.5" y1="5.5" x2="8" y2="8"/>
      <line x1="20" y1="20" x2="22.5" y2="22.5"/>
      <line x1="5.5" y1="22.5" x2="8" y2="20"/>
      <line x1="20" y1="8" x2="22.5" y2="5.5"/>
    </g>
  </svg>`,

  partlyCloudy: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" width="26" height="26">
    <circle cx="10" cy="10" r="4" fill="#FFA726"/>
    <g stroke="#FFA726" stroke-width="1.4" stroke-linecap="round">
      <line x1="10" y1="4" x2="10" y2="6"/>
      <line x1="4" y1="10" x2="6" y2="10"/>
      <line x1="5.8" y1="5.8" x2="7.3" y2="7.3"/>
      <line x1="13" y1="7.3" x2="14.5" y2="5.8"/>
      <line x1="10" y1="16" x2="10" y2="14"/>
      <line x1="16" y1="10" x2="14" y2="10"/>
    </g>
    <path d="M11 20 Q11 17 14.5 17 Q15.5 14.5 18.5 15.5 Q21.5 14.5 21.5 18 Q24 18 24 21 Q24 23.5 21.5 23.5 H12.5 Q10 23.5 11 20Z" fill="#90A4AE"/>
  </svg>`,

  mostlyCloudy: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" width="26" height="26">
    <circle cx="8.5" cy="9" r="3.5" fill="#FFA726" opacity="0.75"/>
    <g stroke="#FFA726" stroke-width="1.2" stroke-linecap="round" opacity="0.75">
      <line x1="8.5" y1="4" x2="8.5" y2="5.5"/>
      <line x1="4" y1="9" x2="5.5" y2="9"/>
      <line x1="5.3" y1="5.8" x2="6.4" y2="6.9"/>
      <line x1="11.3" y1="6.9" x2="12.4" y2="5.8"/>
    </g>
    <path d="M7 20 Q7 16 11.5 16 Q12.5 13 16.5 14 Q20 13 20 17 Q23 17 23 20.5 Q23 23.5 20 23.5 H9 Q6 23.5 7 20Z" fill="#78909C"/>
  </svg>`,

  overcast: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" width="26" height="26">
    <path d="M4 17 Q4 12 9.5 12 Q10.5 8 16 9.5 Q20 8 20 13 Q23.5 13 23.5 17.5 Q23.5 21 20 21 H7 Q3.5 21 4 17Z" fill="#607D8B"/>
  </svg>`,

  rainy: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" width="26" height="26">
    <path d="M4 15 Q4 10 9.5 10 Q10.5 6.5 16 8 Q20 6.5 20 11 Q23.5 11 23.5 15.5 Q23.5 19 20 19 H7 Q3.5 19 4 15Z" fill="#5C6BC0"/>
    <g stroke="#64B5F6" stroke-width="1.5" stroke-linecap="round">
      <line x1="9"  y1="21" x2="7.5"  y2="25.5"/>
      <line x1="14" y1="21" x2="12.5" y2="25.5"/>
      <line x1="19" y1="21" x2="17.5" y2="25.5"/>
    </g>
  </svg>`,

  sleet: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" width="26" height="26">
    <path d="M4 15 Q4 10 9.5 10 Q10.5 6.5 16 8 Q20 6.5 20 11 Q23.5 11 23.5 15.5 Q23.5 19 20 19 H7 Q3.5 19 4 15Z" fill="#5C6BC0"/>
    <line x1="9"  y1="21" x2="7.5"  y2="25.5" stroke="#64B5F6" stroke-width="1.5" stroke-linecap="round"/>
    <circle cx="14" cy="23.5" r="2" fill="#B0BEC5"/>
    <line x1="19" y1="21" x2="17.5" y2="25.5" stroke="#64B5F6" stroke-width="1.5" stroke-linecap="round"/>
  </svg>`,

  snowy: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" width="26" height="26">
    <path d="M4 15 Q4 10 9.5 10 Q10.5 6.5 16 8 Q20 6.5 20 11 Q23.5 11 23.5 15.5 Q23.5 19 20 19 H7 Q3.5 19 4 15Z" fill="#78909C"/>
    <g fill="#B0C4DE">
      <circle cx="9"  cy="23" r="2.2"/>
      <circle cx="14" cy="23" r="2.2"/>
      <circle cx="19" cy="23" r="2.2"/>
    </g>
  </svg>`,

  shower: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" width="26" height="26">
    <path d="M4 15 Q4 10 9.5 10 Q10.5 6.5 16 8 Q20 6.5 20 11 Q23.5 11 23.5 15.5 Q23.5 19 20 19 H7 Q3.5 19 4 15Z" fill="#3949AB"/>
    <g stroke="#64B5F6" stroke-width="1.5" stroke-linecap="round">
      <line x1="9"  y1="21" x2="7.5"  y2="25.5"/>
      <line x1="19" y1="21" x2="17.5" y2="25.5"/>
    </g>
    <path d="M14 20.5 L12 24.5 L16 24.5Z" fill="#FFD600"/>
  </svg>`,

  thunder: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" width="26" height="26">
    <path d="M3 15 Q3 10 9 10 Q10 6.5 16 8 Q20 6.5 20 11 Q24 11 24 15.5 Q24 19 20 19 H6 Q3 19 3 15Z" fill="#546E7A"/>
    <g stroke="#64B5F6" stroke-width="1.4" stroke-linecap="round">
      <line x1="8"  y1="21" x2="6.5"  y2="25"/>
      <line x1="18" y1="21" x2="16.5" y2="25"/>
    </g>
    <polyline points="15,18 12,23 16,23 13,28" stroke="#FFD600" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`,

  hail: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" width="26" height="26">
    <path d="M4 15 Q4 10 9.5 10 Q10.5 6.5 16 8 Q20 6.5 20 11 Q23.5 11 23.5 15.5 Q23.5 19 20 19 H7 Q3.5 19 4 15Z" fill="#607D8B"/>
    <g fill="#B0D8FF" stroke="#7aaed4" stroke-width="0.5">
      <circle cx="8.5"  cy="22.5" r="2.2"/>
      <circle cx="14"   cy="22.5" r="2.2"/>
      <circle cx="19.5" cy="22.5" r="2.2"/>
      <circle cx="11.5" cy="27"   r="2.2"/>
      <circle cx="17"   cy="27"   r="2.2"/>
    </g>
  </svg>`,

  fog: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" width="26" height="26">
    <g stroke="#90A4AE" stroke-width="2.5" stroke-linecap="round">
      <line x1="3"  y1="10" x2="25" y2="10"/>
      <line x1="5"  y1="15" x2="23" y2="15"/>
      <line x1="3"  y1="20" x2="25" y2="20"/>
      <line x1="7"  y1="25" x2="21" y2="25"/>
    </g>
  </svg>`,

  heavySnow: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" width="26" height="26">
    <path d="M4 14 Q4 9 9.5 9 Q10.5 5.5 16 7 Q20 5.5 20 10 Q23.5 10 23.5 14.5 Q23.5 18 20 18 H7 Q3.5 18 4 14Z" fill="#78909C"/>
    <g fill="#B0C4DE" stroke="#7090b0" stroke-width="0.4">
      <circle cx="7"  cy="22" r="2.5"/>
      <circle cx="14" cy="22" r="2.5"/>
      <circle cx="21" cy="22" r="2.5"/>
      <circle cx="10.5" cy="27" r="2.5"/>
      <circle cx="17.5" cy="27" r="2.5"/>
    </g>
  </svg>`,

  snowBlowing: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" width="26" height="26">
    <path d="M4 13 Q4 8.5 9 8.5 Q10 5.5 15 7 Q19 5.5 19 10 Q22.5 10 22.5 13.5 Q22.5 17 19 17 H7 Q3.5 17 4 13Z" fill="#90A4AE"/>
    <g fill="#B0C4DE">
      <circle cx="7.5"  cy="21" r="2"/>
      <circle cx="14"   cy="21" r="2"/>
      <circle cx="20.5" cy="21" r="2"/>
    </g>
    <g stroke="#9ab4cc" stroke-width="1.8" stroke-linecap="round">
      <line x1="3"  y1="25" x2="13" y2="25"/>
      <line x1="5"  y1="28" x2="17" y2="28"/>
    </g>
  </svg>`,

  rainDrop: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" width="26" height="26">
    <path d="M4 15 Q4 10 9.5 10 Q10.5 6.5 16 8 Q20 6.5 20 11 Q23.5 11 23.5 15.5 Q23.5 19 20 19 H7 Q3.5 19 4 15Z" fill="#7986CB"/>
    <g stroke="#90CAF9" stroke-width="1.2" stroke-linecap="round">
      <line x1="11" y1="21" x2="10" y2="24"/>
      <line x1="17" y1="21" x2="16" y2="24"/>
    </g>
  </svg>`,
};

/* ---- 날씨 코드 → 아이콘/라벨 ---- */
const WX = {
  icon(pty, sky) {
    // 단기예보 PTY: 0없음 1비 2비/눈 3눈 4소나기
    // 초단기실황 추가 PTY: 5빗방울 6빗방울/눈날림 7눈날림
    if (pty === 7) return { svg: WI_SVG.snowBlowing,  lbl: '눈날림' };
    if (pty === 6) return { svg: WI_SVG.sleet,        lbl: '빗방울/눈날림' };
    if (pty === 5) return { svg: WI_SVG.rainDrop,     lbl: '빗방울' };
    if (pty === 4) return { svg: WI_SVG.shower,       lbl: '소나기' };
    if (pty === 3) return { svg: WI_SVG.snowy,        lbl: '눈' };
    if (pty === 2) return { svg: WI_SVG.sleet,        lbl: '비/눈' };
    if (pty === 1) return { svg: WI_SVG.rainy,        lbl: '비' };
    if (sky === 4) return { svg: WI_SVG.overcast,     lbl: '흐림' };
    if (sky === 3) return { svg: WI_SVG.mostlyCloudy, lbl: '구름많음' };
    if (sky === 2) return { svg: WI_SVG.partlyCloudy, lbl: '구름조금' };
    return                { svg: WI_SVG.sunny,        lbl: '맑음' };
  },

  // 풍속(m/s) → 세기 문자
  windStr(wsd) {
    if (wsd < 4)  return '약';
    if (wsd < 9)  return '약간강';
    if (wsd < 14) return '강';
    return '매우강';
  },

  // API PCP 문자열 → 강수강도 (기상청 기준, step 나누기 안함 — API는 항상 1시간 기준)
  intFromPcp(pcpRaw) {
    if (!pcpRaw || pcpRaw === '강수없음') return { lbl: '-',       cls: 'int-none'  };
    if (pcpRaw === '1mm 미만')            return { lbl: '약한비',   cls: 'int-light' };

    // range 문자열 직접 매핑
    if (pcpRaw.includes('이상') || pcpRaw.startsWith('50'))
      return { lbl: '매우강한비', cls: 'int-ext' };
    if (pcpRaw.startsWith('30'))
      return { lbl: '강한비',    cls: 'int-heavy' };
    if (pcpRaw.includes('~'))
      return { lbl: '보통비',    cls: 'int-mod' };  // "1.0~29.9mm"

    // 숫자값 (목업 등 정확한 값)
    const val = parseFloat(pcpRaw) || 0;
    if (val < 4)  return { lbl: '약한비',    cls: 'int-light' };
    if (val < 15) return { lbl: '보통비',    cls: 'int-mod'   };
    if (val < 30) return { lbl: '강한비',    cls: 'int-heavy' };
    return              { lbl: '매우강한비', cls: 'int-ext'   };
  },

  // API PCP 문자열 → 화면 표시용 강수량
  pcpDisplay(pcpRaw) {
    if (!pcpRaw || pcpRaw === '강수없음') return '-';
    if (pcpRaw === '1mm 미만')            return '-1';
    // "1.0~29.9mm" → "1~30", "50mm 이상" → "50↑"
    return pcpRaw.replace('mm 이상', '↑').replace(/\.0/g, '').replace('mm', '').replace('~', '~');
  },

  // 풍향(degree) → 화살표 회전각 (바람이 가는 방향)
  vecRot(deg) { return (deg + 180) % 360; },
};

/* ---- 날짜 포맷 유틸 ---- */
const DAYS_KO = ['일','월','화','수','목','금','토'];

function fmtDocDate(d) {
  const y   = String(d.getFullYear()).slice(2);
  const m   = d.getMonth() + 1;
  const day = d.getDate();
  const dow = DAYS_KO[d.getDay()];
  return `'${y}. ${m}. ${day}. (${dow})`;
}
function fmtMDDow(d) {
  return `${d.getDate()}일(${DAYS_KO[d.getDay()]})`;
}
function fmtHour(d) { return `${d.getHours()}시`; }

/* ---- 다음 주말 날짜 범위 계산 ---- */
function getWeekendRange(today) {
  const dow = today.getDay();
  let satOffset = (6 - dow + 7) % 7;
  if (satOffset === 0) satOffset = 7;
  const sat = new Date(today); sat.setDate(today.getDate() + satOffset);
  const sun = new Date(sat);   sun.setDate(sat.getDate() + 1);
  return { sat, sun };
}

/* ---- 목업 데이터 생성 ---- */
function buildMockData(mode) {
  const today = new Date();
  today.setSeconds(0, 0);

  /* 시간별 예보 (48시간) */
  const hourlyRows = [];
  const base = new Date(today);
  base.setMinutes(0, 0, 0);

  for (let h = 0; h < 48; h++) {
    const t = new Date(base);
    t.setHours(base.getHours() + h);
    const hr = t.getHours();
    const isRainyH = mode === 'rain' && h >= 3 && h <= 28;

    const tmp = Math.round(22 + 5 * Math.sin((hr - 6) * Math.PI / 12));

    // pcpRaw: API 그대로 반환하는 형태 모방
    let pcpRaw = '강수없음';
    if (isRainyH) {
      const mmPerHour = [0,0,0,1,2,3,4,4,3,2,3,4,3,2,3,1,2,3,2,1,1,1,0,0,0][h % 25] || 1;
      if (mmPerHour < 1)       pcpRaw = '1mm 미만';
      else if (mmPerHour < 30) pcpRaw = `${mmPerHour}.0mm`;
      else                     pcpRaw = `${mmPerHour}mm 이상`;
    }

    hourlyRows.push({
      time:   t,
      tmp,
      feels:  tmp - 1,
      sky:    isRainyH ? 4 : (hr >= 6 && hr <= 18 ? 1 : 4),
      pty:    isRainyH ? 1 : 0,
      pop:    isRainyH ? 60 : 10,
      pcpRaw,
      pcp:    isRainyH ? parseFloat(pcpRaw) || 0 : 0,
      vec:    170 + Math.round(Math.sin(h * 0.3) * 30),
      wsd:    1.5 + Math.abs(Math.sin(h * 0.2)) * 2,
      reh:    isRainyH ? 90 : 45,
      dam:    '-',
    });
  }

  /* 날짜별 집계 (dailyRows) */
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

  // 48시간 목업이므로 오늘/내일만 실데이터, 나머지는 가상 날짜 채우기
  const dailyRows = Object.values(dailyMap);
  // 10일치가 되도록 이후 날짜 추가 (단순 가상 데이터)
  const lastDate = dailyRows.length > 0 ? new Date(dailyRows[dailyRows.length - 1].date) : new Date(today);
  for (let i = dailyRows.length; i < 10; i++) {
    const d = new Date(lastDate);
    d.setDate(lastDate.getDate() + (i - dailyRows.length + 1));
    const skyCycle = [1, 1, 3, 4, 1, 3, 1, 4][i % 8];
    dailyRows.push({
      date: d,
      amSky: skyCycle, amPty: 0, amPop: 10,
      pmSky: skyCycle, pmPty: 0, pmPop: 20,
      tmin: 20 + Math.round(Math.sin(i * 0.7) * 3),
      tmax: 28 + Math.round(Math.sin(i * 0.5) * 4),
    });
  }

  return { dailyRows, hourlyRows, generatedAt: today };
}

/* 전역 데이터 저장소 */
let APP_DATA = null;
