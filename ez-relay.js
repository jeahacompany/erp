/* EZSTORAGE 수집 자료를 ERP 화면에 건네는 중계기
 *
 * 확장프로그램이 ERP 탭을 조용히 열고 이 파일을 넣는다.
 * 이 파일은 ERP 화면과 같은 출처에서 돌기 때문에
 *  - 로그인 여부를 바로 확인할 수 있고
 *  - 화면이 준비될 때까지 기다렸다가 건넬 수 있다
 *
 * 이 로직을 확장 안에 두지 않고 여기에 둔 이유:
 * 고칠 때마다 대표님이 확장을 다시 불러오지 않아도 되게 하려고.
 *
 * 확장은 window.__ezPayloadIn 에 자료를 넣어두고 이 파일을 넣는다.
 * 결과는 window.__ezRelayResult 에 남긴다.
 */
(function () {
  'use strict';

  function set(type, extra) {
    window.__ezRelayResult = Object.assign({ type: type, at: new Date().toISOString() }, extra || {});
  }

  var payload = window.__ezPayloadIn;
  if (!payload) {
    set('EZ_ERROR', { message: '건넬 자료가 없습니다' });
    return;
  }

  // 1. 로그인부터 본다. 같은 출처라 바로 읽을 수 있다.
  var hasSession = false;
  try {
    var raw = localStorage.getItem('erp_session') || localStorage.getItem('doban_session');
    if (raw) {
      var s = JSON.parse(raw);
      hasSession = !!(s && s.token);
    }
  } catch (e) {
    /* 읽기 실패하면 아래에서 응답 없음으로 처리된다 */
  }
  if (!hasSession) {
    set('EZ_ERROR', { message: 'ERP 로그인이 필요합니다 (브라우저에서 ERP에 로그인해 주세요)' });
    return;
  }

  // 2. 받는 화면의 응답을 기다린다.
  var done = false;
  window.addEventListener('message', function (e) {
    if (e.origin !== window.location.origin || !e.data) return;
    if (e.data.type === 'EZ_SAVED') {
      done = true;
      set('EZ_SAVED', { result: e.data.result || {} });
    } else if (e.data.type === 'EZ_ERROR') {
      done = true;
      set('EZ_ERROR', { message: e.data.message || '알 수 없는 오류' });
    }
  });

  // 3. 화면(React)이 준비될 때까지 기다렸다가 건넨다.
  //    한 번만 던지면 화면이 아직 안 붙어 있을 때 그냥 사라진다. 그래서 될 때까지 다시 던진다.
  //    받는 쪽은 한 번만 저장하도록 막혀 있어서 여러 번 던져도 중복 저장되지 않는다.
  var tries = 0;
  var timer = setInterval(function () {
    tries++;
    if (done || tries > 60) {
      clearInterval(timer);
      if (!done && !window.__ezRelayResult) {
        set('EZ_ERROR', { message: 'ERP 화면이 응답하지 않습니다' });
      }
      return;
    }
    try {
      window.postMessage({ type: 'EZ_DATA', payload: payload }, window.location.origin);
    } catch (e) {
      /* 다음 차례에 다시 던진다 */
    }
  }, 500);
})();
