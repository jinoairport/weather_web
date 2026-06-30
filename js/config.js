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

/* 로컬 서버(/config) → localStorage → 기본 내장키 순으로 로드
   GitHub Pages 등 정적 호스팅(localhost·192.168.x.x 외)에서는 서버 조회 생략 */
const _isLocalServer = ['localhost', '127.0.0.1'].includes(location.hostname)
  || /^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./.test(location.hostname);

CONFIG.ready = _isLocalServer
  ? fetch('/config')
      .then(r => { if (!r.ok) throw new Error(); return r.json(); })
      .then(data => {
        CONFIG.API_KEY = data.api_key || localStorage.getItem('kma_api_key') || _DEFAULT_KEY;
        const dam = data.show_dam;
        CONFIG.SHOW_DAM = (dam === undefined) ? localStorage.getItem('show_dam') !== 'hide' : dam;
      })
      .catch(() => {
        CONFIG.API_KEY  = localStorage.getItem('kma_api_key') || _DEFAULT_KEY;
        CONFIG.SHOW_DAM = localStorage.getItem('show_dam') !== 'hide';
      })
  : Promise.resolve().then(() => {
      CONFIG.API_KEY  = localStorage.getItem('kma_api_key') || _DEFAULT_KEY;
      CONFIG.SHOW_DAM = localStorage.getItem('show_dam') !== 'hide';
    });
