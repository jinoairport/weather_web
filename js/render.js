/* ===================================================
   렌더링 모듈 — 일별/시간별 예보 테이블 생성
   =================================================== */

let currentStep = 3;

/* ===================== 날짜별 10일 예보 ===================== */
function renderDailyTable(dailyRows) {
  const tbl = document.getElementById('daily-tbl');
  if (!tbl || !dailyRows || dailyRows.length === 0) return;

  const today    = new Date();
  const todayStr = today.toDateString();
  const tomDate  = new Date(today); tomDate.setDate(today.getDate() + 1);
  const morDate  = new Date(today); morDate.setDate(today.getDate() + 2);
  const tomStr   = tomDate.toDateString();
  const morStr   = morDate.toDateString();

  const rows = dailyRows.slice(0, 10);
  const N    = rows.length;

  // colgroup: 헤더col(52px) + 오늘/내일/모레는 36px×2 + 나머지는 44px
  let html = '<colgroup>';
  html += '<col style="width:52px">';
  rows.forEach((r, i) => {
    const ds = r.date.toDateString();
    if (ds === todayStr || ds === tomStr || ds === morStr) {
      html += '<col style="width:36px"><col style="width:36px">';
    } else {
      html += '<col style="width:44px">';
    }
  });
  html += '</colgroup>';

  // ---- 날짜 헤더 행 ----
  html += '<tr><td class="rh">날짜</td>';
  rows.forEach((r, i) => {
    const ds  = r.date.toDateString();
    const dow = r.date.getDay();
    const dayNum = r.date.getDate();
    const dayKo  = DAYS_KO[dow];
    const label  = `${dayNum}일(${dayKo})`;

    let cls = 'dtbl-date';
    let style = '';
    if (ds === todayStr) {
      cls += ' today'; style = 'colspan="2"';
    } else if (ds === tomStr) {
      cls += ' tomorrow'; style = 'colspan="2"';
    } else if (ds === morStr) {
      cls += ' morae'; style = 'colspan="2"';
    } else {
      if (dow === 6) cls += ' sat';
      else if (dow === 0) cls += ' sun';
      else if (isHoliday(r.date)) cls += ' hol';
    }

    const isFirstThree = (ds === todayStr || ds === tomStr || ds === morStr);
    if (isFirstThree) {
      html += `<td class="${cls}" colspan="2">${label}</td>`;
    } else {
      html += `<td class="${cls}">${label}</td>`;
    }
  });
  html += '</tr>';

  // ---- 시각 행 ----
  html += '<tr><td class="rh">시각</td>';
  rows.forEach(r => {
    const ds = r.date.toDateString();
    if (ds === todayStr || ds === tomStr || ds === morStr) {
      html += '<td class="dtbl-sess">오전</td><td class="dtbl-sess">오후</td>';
    } else {
      html += '<td class="dtbl-sess">종일</td>';
    }
  });
  html += '</tr>';

  // ---- 날씨 아이콘 행 ----
  html += '<tr><td class="rh">날씨</td>';
  rows.forEach((r, i) => {
    const ds = r.date.toDateString();
    if (ds === todayStr || ds === tomStr || ds === morStr) {
      // 오늘 오전은 "-" (이미 지난 시간)
      const amCell = (ds === todayStr)
        ? '<td>-</td>'
        : `<td title="${WX.icon(r.amPty, r.amSky).lbl}">${WX.icon(r.amPty, r.amSky).svg}</td>`;
      const pmIc = WX.icon(r.pmPty, r.pmSky);
      html += amCell + `<td title="${pmIc.lbl}">${pmIc.svg}</td>`;
    } else {
      const ic = WX.icon(r.pmPty, r.pmSky);
      html += `<td title="${ic.lbl}">${ic.svg}</td>`;
    }
  });
  html += '</tr>';

  // ---- 기온 행 ----
  html += '<tr><td class="rh">기온</td>';
  rows.forEach(r => {
    const ds = r.date.toDateString();
    const tminStr = r.tmin < 99  ? r.tmin + '℃' : '-';
    const tmaxStr = r.tmax > -99 ? r.tmax + '℃' : '-';
    const inner = `<span class="t-min">${tminStr}</span>&nbsp;<span class="t-max">${tmaxStr}</span>`;
    if (ds === todayStr || ds === tomStr || ds === morStr) {
      html += `<td class="tmp-minmax" colspan="2">${inner}</td>`;
    } else {
      html += `<td class="tmp-minmax">${inner}</td>`;
    }
  });
  html += '</tr>';

  // ---- 강수확률 행 ----
  html += '<tr><td class="rh">강수<br>확률</td>';
  rows.forEach(r => {
    const ds = r.date.toDateString();
    if (ds === todayStr || ds === tomStr || ds === morStr) {
      // 오늘 오전은 "-"
      const amPop = (ds === todayStr)
        ? '<td class="pop-none">-</td>'
        : `<td class="${r.amPop > 0 ? 'pop-cell' : 'pop-none'}">${r.amPop > 0 ? r.amPop + '%' : '-'}</td>`;
      const pmCls = r.pmPop > 0 ? 'pop-cell' : 'pop-none';
      html += amPop + `<td class="${pmCls}">${r.pmPop > 0 ? r.pmPop + '%' : '-'}</td>`;
    } else {
      const pop  = Math.max(r.amPop || 0, r.pmPop || 0);
      const cls  = pop > 0 ? 'pop-cell' : 'pop-none';
      html += `<td class="${cls}">${pop > 0 ? pop + '%' : '-'}</td>`;
    }
  });
  html += '</tr>';

  tbl.innerHTML = html;
}

/* ===================== 시간별 예보 ===================== */
function renderHourlyTable(hourlyRows, step, mode) {
  currentStep = step;
  const tbl = document.getElementById('hourly-tbl');
  if (!tbl) return;

  // step 간격으로 필터, 최대 72시간 분량 — 원본 인덱스 추적
  const displayIdxs = [];
  for (let i = 0; i < hourlyRows.length && displayIdxs.length < Math.ceil(72 / step); i += step) {
    displayIdxs.push(i);
  }
  const rows = displayIdxs.map(i => hourlyRows[i]);

  // 날짜 그룹
  const groups = buildDateGroups(rows);
  renderDateTabs(groups.map(g => g.date));

  const N       = rows.length;
  const showPcp = mode === 'rain' || rows.some(r => r.pcp > 0);
  const showDam = CONFIG.SHOW_DAM && mode === 'normal';
  const colW    = step === 1 ? 34 : 46;

  const today = new Date();
  const todayStr = today.toDateString();

  let html = '<colgroup>';
  html += '<col style="width:52px">';
  for (let i = 0; i < N; i++) html += `<col style="width:${colW}px">`;
  html += '</colgroup>';

  /* 날짜별 최저/최고 헤더 행 (day-stat-row) */
  html += '<tr class="day-stat-row">';
  html += '<td class="rh" style="border-bottom:none;border-right:none"></td>';
  for (const g of groups) {
    // 해당 날짜의 rows에서 최저/최고 계산
    const gRows = rows.filter(r => r.time.toDateString() === g.date.toDateString());
    const temps  = gRows.map(r => r.tmp);
    const gMin   = temps.length > 0 ? Math.min(...temps) : null;
    const gMax   = temps.length > 0 ? Math.max(...temps) : null;
    // 오늘 최저는 야간을 지나지 않았으므로 '-'
    const minStr = (g.date.toDateString() === todayStr) ? '-' : (gMin !== null ? gMin + '℃' : '-');
    const maxStr = gMax !== null ? gMax + '℃' : '-';
    html += `<td class="day-stat-cell" colspan="${g.count}">`;
    const bdow = g.date.getDay();
    const bCls = isHoliday(g.date) ? ' hol' : (bdow===6?' sat':(bdow===0?' sun':''));
    html += `<span class="day-stat-badge${bCls}">${fmtMDDow(g.date)}</span>`;
    html += `<span class="day-stat-text">최저 ${minStr} / 최고 ${maxStr}</span>`;
    html += '</td>';
  }
  html += '</tr>';

  /* 시각 행 */
  html += '<tr><td class="rh">시각</td>';
  rows.forEach(r => { html += `<td class="time-cell">${fmtHour(r.time)}</td>`; });
  html += '</tr>';

  /* 날씨 아이콘 행 */
  html += '<tr><td class="rh">날씨</td>';
  rows.forEach(r => {
    const ic = WX.icon(r.pty, r.sky);
    html += `<td title="${ic.lbl}">${ic.svg}</td>`;
  });
  html += '</tr>';

  /* 온도 그래프 행 (기온 라벨 + SVG 그래프 + 수치) */
  html += buildTempGraphRow(rows, N, colW);

  /* 기온 수치 행 */
  html += '<tr><td class="rh" style="border-top:none;font-size:9px"></td>';
  rows.forEach(r => {
    html += `<td style="font-size:10px;font-weight:700;border-top:none;padding-bottom:3px">${r.tmp}℃</td>`;
  });
  html += '</tr>';

  /* 체감온도 행 */
  html += '<tr><td class="rh">체감<br>온도</td>';
  rows.forEach(r => { html += `<td style="font-size:9px">${r.feels}℃</td>`; });
  html += '</tr>';

  /* 강수량(mm) 행 — 강우 모드 */
  if (showPcp) {
    html += '<tr><td class="rh">강수량<br>(mm)</td>';
    rows.forEach((r, rIdx) => {
      if (step === 3) {
        // 3시간 구간 → 1시간별 강수량 3칸으로 좌우 분할
        html += '<td class="pcp-sub-cell">';
        for (let si = 0; si < 3; si++) {
          const ai = displayIdxs[rIdx] + si;
          if (ai < hourlyRows.length) {
            const sr = hourlyRows[ai];
            const disp = WX.pcpDisplay(sr.pcpRaw);
            const cls = sr.pcp > 0 ? 'pcp-pos' : 'pcp-none';
            html += `<span class="pcp-sub-val ${cls}">${disp}</span>`;
          }
        }
        html += '</td>';
      } else {
        const disp = WX.pcpDisplay(r.pcpRaw);
        const cls  = r.pcp > 0 ? 'pcp-pos' : 'pcp-none';
        html += `<td class="${cls}">${disp}</td>`;
      }
    });
    html += '</tr>';

    /* 강수강도 행 — 3시간 간격이면 해당 구간 중 최대 강도 사용 */
    html += '<tr><td class="rh">강수<br>강도</td>';
    rows.forEach((r, rIdx) => {
      if (step === 3) {
        let maxPcp = 0; let maxPcpRaw = '강수없음';
        for (let si = 0; si < 3; si++) {
          const ai = displayIdxs[rIdx] + si;
          if (ai < hourlyRows.length) {
            const sr = hourlyRows[ai];
            if (sr.pcp > maxPcp) { maxPcp = sr.pcp; maxPcpRaw = sr.pcpRaw; }
          }
        }
        const it = WX.intFromPcp(maxPcpRaw);
        html += `<td class="${it.cls}">${it.lbl}</td>`;
      } else {
        const it = WX.intFromPcp(r.pcpRaw);
        html += `<td class="${it.cls}">${it.lbl}</td>`;
      }
    });
    html += '</tr>';
  }

  /* 강수확률 행 */
  html += '<tr><td class="rh">강수<br>확률</td>';
  rows.forEach(r => {
    const cls = r.pop > 0 ? 'pop-cell' : 'pop-none';
    html += `<td class="${cls}">${r.pop > 0 ? r.pop + '%' : '-'}</td>`;
  });
  html += '</tr>';

  /* 바람 행 */
  html += '<tr><td class="rh">바람<br>(m/s)</td>';
  rows.forEach(r => {
    const rot = WX.vecRot(r.vec);
    const str = WX.windStr(r.wsd);
    const spd = r.wsd.toFixed(1);
    html += `<td><span class="wind-arrow" style="display:inline-block;transform:rotate(${rot}deg)">↑</span><br>
      <span class="wstr">${str}</span><br><span class="wstr">${spd}</span></td>`;
  });
  html += '</tr>';

  /* 습도 행 */
  html += '<tr><td class="rh">습도</td>';
  rows.forEach(r => { html += `<td style="font-size:10px">${r.reh}%</td>`; });
  html += '</tr>';

  /* 폭염영향 행 (일반 모드 + 설정 ON) — 연속 동일값 colspan 처리 */
  if (showDam) {
    html += '<tr><td class="rh">폭염<br>영향</td>';
    // 연속 동일값 병합
    const damVals = rows.map(r => r.dam || '-');
    let i = 0;
    while (i < damVals.length) {
      const val = damVals[i];
      let span = 1;
      while (i + span < damVals.length && damVals[i + span] === val) span++;
      let cls = 'heat-none';
      if      (val === '관심') cls = 'heat-concern';
      else if (val === '주의') cls = 'heat-caution';
      else if (val === '경보' || val === '심각') cls = 'heat-warning';
      const colspanAttr = span > 1 ? ` colspan="${span}"` : '';
      const content = val === '-' ? '' : val;
      html += `<td class="${cls}"${colspanAttr}>${content}</td>`;
      i += span;
    }
    html += '</tr>';
  }

  tbl.innerHTML = html;
}

/* 온도 그래프 행 (날씨누리 스타일 — 파랑 + 부드러운 베지어 곡선) */
function buildTempGraphRow(rows, N, colW) {
  const temps = rows.map(r => r.tmp);
  const tMax  = Math.max(...temps) + 2;
  const tMin  = Math.min(...temps) - 2;
  const range = tMax - tMin || 1;
  const W = 100, H = 52, PAD = 7;
  const COLOR = '#1976D2';

  const xs = rows.map((_, i) => +((i + 0.5) / N * W).toFixed(2));
  const ys = temps.map(t => +(((tMax - t) / range) * (H - PAD * 2) + PAD).toFixed(2));

  // 부드러운 베지어 곡선
  let path = `M ${xs[0]},${ys[0]}`;
  for (let i = 1; i < xs.length; i++) {
    const dx  = (xs[i] - xs[i-1]) * 0.4;
    const cp1 = `${(xs[i-1] + dx).toFixed(2)},${ys[i-1].toFixed(2)}`;
    const cp2 = `${(xs[i]   - dx).toFixed(2)},${ys[i].toFixed(2)}`;
    path += ` C ${cp1} ${cp2} ${xs[i]},${ys[i]}`;
  }

  // 원형 점: preserveAspectRatio="none" 으로 X가 늘어나므로
  // ellipse로 보정 — rx는 가로 픽셀 비율에 맞춰 역보정
  const approxW = N * (colW || 46); // 컨테이너 추정 px 폭
  const dotPx   = 3;                // 실제 원 반지름 (px)
  const rx_vb   = +(dotPx * W / approxW).toFixed(3); // viewBox X 단위로 환산
  const ry_vb   = dotPx;                              // Y 스케일≈1 (H=52px)

  let svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"
    xmlns="http://www.w3.org/2000/svg" style="width:100%;height:${H}px;display:block;overflow:visible">`;
  svg += `<path d="${path}" fill="none" stroke="${COLOR}" stroke-width="1.8" vector-effect="non-scaling-stroke"/>`;
  xs.forEach((x, i) => {
    svg += `<ellipse cx="${x}" cy="${ys[i]}" rx="${rx_vb}" ry="${ry_vb}" fill="${COLOR}"/>`;
  });
  svg += '</svg>';

  return `<tr class="tmp-graph-row">
    <td class="rh" style="border-bottom:none;font-size:10px;font-weight:700">기온</td>
    <td colspan="${N}" style="padding:0;border-left:none;border-bottom:none"><div style="width:100%;overflow:hidden">${svg}</div></td>
  </tr>`;
}

/* 날짜 그룹 계산 */
function buildDateGroups(rows) {
  const groups = [];
  let cur = null;
  for (const r of rows) {
    const key = r.time.toDateString();
    if (!cur || cur.key !== key) {
      cur = { key, date: r.time, count: 0 };
      groups.push(cur);
    }
    cur.count++;
  }
  return groups;
}

/* 날짜 탭 렌더 */
function renderDateTabs(dates) {
  const el = document.getElementById('date-tabs');
  if (!el) return;
  el.innerHTML = dates.map((d, i) => {
    const dow = d.getDay();
    const extra = isHoliday(d) ? ' hol' : (dow===6?' sat':(dow===0?' sun':''));
    return `<div class="dtab no-print${i===0?' active':''}${extra}" onclick="scrollToDate(${i})">${fmtMDDow(d)}</div>`;
  }).join('');
}

function scrollToDate(idx) {
  const tabs = document.querySelectorAll('.dtab');
  tabs.forEach((t, i) => t.classList.toggle('active', i === idx));
  const hdrs = document.querySelectorAll('#hourly-tbl .day-stat-cell');
  if (hdrs[idx]) hdrs[idx].scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'start' });
}
