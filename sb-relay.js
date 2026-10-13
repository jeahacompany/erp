/* 사방넷 자료를 ERP 화면에 건네는 중계기 (2026-10-13)
 *
 * 확장(sb.js)이 ERP 탭을 조용히 열고 이 파일을 넣는다.
 * 이 파일은 ERP 화면과 같은 출처에서 돌기 때문에 화면의 저장 기능을 그대로 쓸 수 있다.
 *
 * 왜 확장이 아니라 여기에 두나 — 고칠 때 **확장을 다시 불러오지 않아도 되게** 하려고.
 *   (사방넷 화면 모양이 바뀌면 이 파일만 고쳐 배포하면 된다)
 *
 * 확장은 window.__sbPayloadIn 에 자료를 넣고 이 파일을 넣는다.
 * 결과는 window.__sbRelayResult 에 남긴다.
 */
(function () {
  'use strict';

  function set(type, extra) {
    window.__sbRelayResult = Object.assign({ type: type, at: new Date().toISOString() }, extra || {});
  }

  var payload = window.__sbPayloadIn;
  if (!payload || !Array.isArray(payload.items) || !payload.items.length) {
    set('SB_ERROR', { message: '건넬 자료가 없습니다' });
    return;
  }

  // 저장할 자격이 있는지 (사람 로그인 또는 저장 전용 토큰 — 둘 중 하나면 된다)
  var ok = false;
  try {
    var raw = localStorage.getItem('erp_session');
    if (raw) { var s = JSON.parse(raw); ok = !!(s && s.token); }
  } catch (e) { /* 무시 */ }
  if (!ok) { try { ok = !!localStorage.getItem('erp_collector'); } catch (e) { /* 무시 */ } }
  if (!ok) {
    set('SB_ERROR', { message: 'ERP 저장 권한이 없습니다 — 수집용 크롬에서 ERP 로그인 후 「다시 허용하기」 (사방넷 문제가 아닙니다)' });
    return;
  }

  window.addEventListener('message', function (e) {
    if (e.source !== window) return;
    var d = e.data || {};
    if (d.type === 'SB_SAVED') set('SB_SAVED', { result: d.result || {} });
    if (d.type === 'SB_ERROR') set('SB_ERROR', { message: d.message || '알 수 없는 오류' });
  });

  window.postMessage({ type: 'SB_DATA', payload: payload }, window.location.origin);
})();
