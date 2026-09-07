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
  } catch {
    /* 읽기 실패하면 로그인 없음으로 본다 */
  }
  if (!hasSession) {
    set('EZ_ERROR', { message: 'ERP 로그인이 필요합니다 (브라우저에서 ERP에 로그인해 주세요)' });
    return;
  }

  // 2. 받는 화면의 응답을 기다린다.
  //
  // ⚠⚠ 2026-09-07 — **송장이 넉 달 동안 안 들어온 이유가 여기였다.**
  //   수집기는 송장을 제대로 읽어서 payload.invoices 에 담았다. 그런데 여기서는
  //   EZ_DATA 하나만 던졌고, 받는 화면의 EZ_DATA 처리기는 상품·재고·입출고·입고
  //   **넷만** 저장한다. 송장은 EZ_INVOICES 라는 별도 메시지로 와야 하는데
  //   그 메시지를 **아무도 보내지 않았다.**
  //   오류도 안 났다. "저장 완료" 라고 나왔고, 송장만 조용히 사라졌다.
  //   (ez_invoices 가 9/3 에 멈춰 있었던 것이 이 때문이다)
  //
  //   → EZ_DATA 가 저장된 뒤에 송장을 이어서 보낸다.
  //     한 번에 크게 보내면 시간초과가 나므로 받는 쪽 규칙대로 잘게 나누고,
  //     마지막 덩어리에만 last:true 를 붙인다 (그때 옵션코드↔SKU 를 배운다).
  var CHUNK = 100;
  var invRows = (payload && payload.invoices) || [];
  var invAt = 0;
  var invTotal = 0;
  var phase = 'data';        // data → invoices → done
  var done = false;

  function sendNextInvoiceChunk() {
    if (invAt >= invRows.length) {
      done = true;
      set('EZ_SAVED', { result: Object.assign({}, window.__ezRelayLast || {}, { invoices: invTotal }) });
      return;
    }
    var part = invRows.slice(invAt, invAt + CHUNK);
    var isLast = invAt + CHUNK >= invRows.length;
    invAt += CHUNK;
    window.postMessage(
      { type: 'EZ_INVOICES', rows: part, last: isLast }, window.location.origin);
  }

  window.addEventListener('message', function (e) {
    if (e.origin !== window.location.origin || !e.data) return;
    if (e.data.type === 'EZ_SAVED') {
      var r = e.data.result || {};
      if (phase === 'data') {
        window.__ezRelayLast = r;
        if (invRows.length) {
          phase = 'invoices';
          set('EZ_SAVING_INVOICES', { result: r, invoices: invRows.length });
          sendNextInvoiceChunk();
        } else {
          done = true;
          set('EZ_SAVED', { result: r });
        }
      } else {
        invTotal += (r.invoices || 0);
        // ⚠ 진행 표시를 남긴다. 확장은 "움직임이 있나" 로 기다리므로,
        //   여기서 안 남기면 송장이 잘 저장되는 중인데도 멈춘 줄 알고 끊는다.
        set('EZ_SAVING_INVOICES', { saved: invAt, total: invRows.length, invoices: invTotal });
        sendNextInvoiceChunk();
      }
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
    // ⚠ 송장 단계로 넘어갔으면 EZ_DATA 를 더 던지면 안 된다.
    //   계속 던지면 같은 자료를 다시 저장하고, 그 응답이 송장 진행과 섞인다.
    if (phase !== 'data') { clearInterval(timer); return; }
    if (done || tries > 60) {
      clearInterval(timer);
      if (!done && !window.__ezRelayResult) {
        set('EZ_ERROR', { message: 'ERP 화면이 응답하지 않습니다' });
      }
      return;
    }
    try {
      window.postMessage({ type: 'EZ_DATA', payload: payload }, window.location.origin);
    } catch {
      /* 다음 차례에 다시 던진다 */
    }
  }, 500);
})();
