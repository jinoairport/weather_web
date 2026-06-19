/* ===================================================
   설정 파일 — API 키 및 좌표 설정
   =================================================== */

const CONFIG = {
  API_KEY: '',
  NX: 96, NY: 76,
  LOCATION_NAME: '대저2동',
  AIRPORT_NAME:  '김해공항',
  DEPARTMENT:    '토목부',
  SHOW_DAM: true,
};

/* 로컬 서버(/config) → localStorage → 기본 내장키 순으로 로드 */
CONFIG.ready = fetch('/config')
  .then(r => { if (!r.ok) throw new Error(); return r.json(); })
  .then(data => {
    CONFIG.API_KEY = data.api_key || localStorage.getItem('kma_api_key') || _DEFAULT_KEY;
    const dam = data.show_dam;
    CONFIG.SHOW_DAM = (dam === undefined) ? localStorage.getItem('show_dam') !== 'hide' : dam;
  })
  .catch(() => {
    CONFIG.API_KEY  = localStorage.getItem('kma_api_key') || _DEFAULT_KEY;
    CONFIG.SHOW_DAM = localStorage.getItem('show_dam') !== 'hide';
  });
