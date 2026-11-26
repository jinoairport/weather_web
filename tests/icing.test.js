/* ===================================================
   js/icing.js의 judge 포팅을 실제 과거 METAR 사례(tests/icing_fixtures.json,
   Python icing_rules.judge() 기준값)와 비교 검증한다.
   생성: tools/make_icing_fixtures.py
   실행: node tests/icing.test.js
   =================================================== */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'js', 'icing.js'), 'utf8');
eval(src);

const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, 'icing_fixtures.json'), 'utf8'));

/* 파이썬 datetime.isoformat() 문자열("YYYY-MM-DDTHH:MM:SS") -> icing.js KST epoch */
function parseIso(s) {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
  return icingKstMs(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
}

function arrEq(a, b) {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

const NOT_RISK_DATES = ['2025-01-28', '2025-02-13', '2025-03-17', '2026-02-07'];
const EARLY_RECOVERY_DATE = '2024-03-13';
const EVAP_COOLING_DATES = ['2023-03-13', '2024-03-01', '2025-02-02', '2025-12-14', '2026-02-11'];

const rows = [];
let allPass = true;
let allRulesPass = true;

for (const ds of Object.keys(fixtures)) {
  const fx = fixtures[ds];
  const [ty, tm, td] = fx.target.split('-').map(Number);
  const target = { y: ty, mo: tm - 1, d: td };
  const hours = fx.hours.map(h => Object.assign({}, h, { dt: parseIso(h.dt) }));

  const res = icingJudge(hours, target);
  const exp = fx.expected;

  const levelMatch = res.level === exp.level;
  const nameMatch = res.level_name === exp.level_name;
  const typesMatch = arrEq(res.types, exp.types);
  const downsMatch = arrEq(res.downgrades, exp.downgrades);
  const missingMatch = res.missing_hours === exp.missing_hours;
  const pass = levelMatch && nameMatch && typesMatch && downsMatch && missingMatch;
  if (!pass) allPass = false;

  rows.push({
    date: ds,
    py: exp.level_name,
    js: res.level_name,
    match: pass,
    detail: pass ? '' : JSON.stringify({
      level: [exp.level, res.level], types: [exp.types, res.types],
      downgrades: [exp.downgrades, res.downgrades], missing: [exp.missing_hours, res.missing_hours],
    }),
  });

  // 사용자가 지정한 날짜별 기대값(파이썬 기준) 자체도 다시 확인
  if (ds === EARLY_RECOVERY_DATE) {
    const ok = exp.level_name === '주의' && exp.downgrades.some(d => d.includes('조기 회복'));
    if (!ok) { allRulesPass = false; console.log(`!! 규칙 위반: ${ds} 는 "주의"(조기 회복 하향)여야 하는데 파이썬 결과가 다릅니다:`, exp); }
  } else if (EVAP_COOLING_DATES.includes(ds)) {
    const ok = exp.level_name === '주의' && exp.types.includes('증발냉각');
    if (!ok) { allRulesPass = false; console.log(`!! 규칙 위반: ${ds} 는 "주의"(증발냉각)여야 하는데 파이썬 결과가 다릅니다:`, exp); }
  } else if (NOT_RISK_DATES.includes(ds)) {
    const ok = exp.level_name !== '위험';
    if (!ok) { allRulesPass = false; console.log(`!! 규칙 위반: ${ds} 는 "위험"이 아니어야 하는데 파이썬 결과가 "위험"입니다.`); }
  } else {
    const ok = exp.level_name === '위험';
    if (!ok) { allRulesPass = false; console.log(`!! 규칙 위반: ${ds} 는 "위험"이어야 하는데 파이썬 결과는 "${exp.level_name}"입니다.`); }
  }
}

console.log('날짜         | Python 단계 | JS 단계 | 일치');
console.log('-------------|------------|---------|------');
for (const r of rows) {
  console.log(`${r.date}   | ${r.py.padEnd(10)} | ${r.js.padEnd(7)} | ${r.match ? 'O' : 'X'}`);
  if (!r.match) console.log('   차이:', r.detail);
}

console.log();
console.log('JS 포팅 vs Python 전부 일치:', allPass ? 'PASS' : 'FAIL');
console.log('사용자 지정 기대값(파이썬 기준) 전부 충족:', allRulesPass ? 'PASS' : 'FAIL');

if (!allPass || !allRulesPass) process.exit(1);
