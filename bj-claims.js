/* 발주모아 취소·반품(CS) → 사내 ERP 수집기 (읽기 전용)
 *
 * 조회만 한다. 발주모아에 아무것도 쓰지 않는다.
 * 비밀번호·쿠키·토큰을 저장하지 않는다.
 *
 * ⚠ HTML 표라서 화면이 바뀌면 엉뚱한 칸을 읽을 수 있다.
 *   머리글을 먼저 확인하고 하나라도 다르면 저장하지 않고 멈춘다.
 *
 * 저장은 기존 oms_claims 에 넣는다. 새 클레임 시스템을 만들지 않는다.
 */
(function () {
  'use strict';

  var ERP_ORIGIN = 'https://jeahacompany.github.io';
  var ERP_URL = ERP_ORIGIN + '/erp/data/ez/?receive=1';
  var LIST = '/CS/requestList';
  var PAGE_SIZE = 500;   // 이 화면은 500 이 최대
  var MAX_PAGES = 200;

  // 머리글에 이 낱말이 있어야 한다
  var EXPECT = [
    { i: 2, must: ['상태'] },
    { i: 4, must: ['주문번호'] },
    { i: 8, must: ['상품명'] },
    { i: 9, must: ['CS'] },
    { i: 10, must: ['수량'] },
  ];

  var opt = window.__bjcOptions || {};
  var FROM = opt.from || null;
  var TO = opt.to || null;
  var DRY = !!opt.dryRun;

  window.__bjcResult = { state: 'running', at: new Date().toISOString() };
  function finish(state, msg, extra) {
    window.__bjcResult = Object.assign({ state: state, msg: msg, at: new Date().toISOString() }, extra || {});
  }

  var box = document.createElement('div');
  box.style.cssText =
    'position:fixed;right:16px;bottom:16px;z-index:2147483647;width:340px;background:#fff;' +
    'border:1px solid #cbd5e1;border-radius:10px;padding:14px 16px;box-shadow:0 8px 24px rgba(0,0,0,.18);' +
    'font:13px/1.6 -apple-system,BlinkMacSystemFont,"Malgun Gothic",sans-serif;color:#0f172a';
  box.innerHTML = '<div style="font-weight:700;margin-bottom:6px">발주모아 취소·반품 → ERP</div><div id="bjc-msg">준비 중…</div>';
  document.body.appendChild(box);
  var msgEl = box.querySelector('#bjc-msg');
  function say(t) { msgEl.innerHTML = t; }
  function done(t, bad) {
    say('<span style="color:' + (bad ? '#dc2626' : '#15803d') + '">' + t + '</span>');
    if (bad) setTimeout(function () { if (box.parentNode) box.remove(); }, 20000);
  }

  var txt = function (el) { return el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : ''; };
  function pick(s, re) { var m = String(s || '').match(re); return m ? m[1] : null; }
  function num(s) { var v = String(s == null ? '' : s).replace(/[^0-9.-]/g, ''); return v === '' ? null : Number(v); }

  function bigTable(doc) {
    var ts = [].slice.call(doc.querySelectorAll('table'));
    ts.sort(function (a, b) { return b.rows.length - a.rows.length; });
    return ts[0] || null;
  }

  function checkHeaders(t) {
    if (!t || !t.rows.length) return 'CS 표를 찾지 못했습니다';
    var hs = [].map.call(t.rows[0].cells, function (c) { return txt(c); });
    if (hs.length < 12) return '표의 칸 수가 예상과 다릅니다 (' + hs.length + ')';
    for (var k = 0; k < EXPECT.length; k++) {
      var e = EXPECT[k], h = hs[e.i] || '';
      for (var j = 0; j < e.must.length; j++) {
        if (h.indexOf(e.must[j]) < 0) {
          return '표 머리글이 바뀌었습니다 — ' + (e.i + 1) + '번째 칸에 "' + e.must[j] + '" 가 없습니다 (본 값: "' + h + '")';
        }
      }
    }
    return null;
  }

  // CS 내용에서 종류를 뽑는다. 못 알아보면 '기타' 로 둔다 (추측하지 않는다)
  function kindOf(s) {
    var v = String(s || '');
    if (/출고전\s*취소|출고전취소/.test(v)) return '출고전취소';
    if (/취소/.test(v)) return '취소';
    if (/반품/.test(v)) return '반품';
    if (/교환/.test(v)) return '교환';
    if (/환불/.test(v)) return '환불';
    if (/누락|오배송|파손|불량/.test(v)) return '클레임';
    return '기타';
  }

  function readRow(tr) {
    var c = tr.cells;
    if (!c || c.length < 12) return null;
    var g = function (i) { return txt(c[i]); };

    var c4 = g(4);
    var hub = pick(c4, /\b(WFS\d{6}-\d+)\b/);
    var c8 = g(8);
    var extId = (tr.querySelector('input[name=chk]') || {}).value || null;
    if (!extId) {
      // 체크박스가 없으면 주문번호+상품코드로 대신 만든다 (중복 방지용 열쇠)
      extId = (hub || '') + '|' + (pick(c8, /상품코드:\s*([A-Za-z0-9_-]+)/) || '') + '|' + (pick(c8, /옵션코드:\s*(\d+)/) || '');
      if (extId === '||') return null;
    }

    var c3 = g(3);
    var c9 = g(9);
    var c2 = g(2);

    return {
      extId: String(extId),
      hubOrderNo: hub,
      status: c2,                                   // 예: 정산적용 [출고전 취소]
      kind: kindOf(c2 + ' ' + c9),
      reason: c9 || null,                           // CS 내용
      registeredAt: pick(c3, /등록일\s*:\s*([\d-]+)/),
      settleDate: pick(c3, /정산일\s*:\s*([\d-]+)/),
      channel: pick(g(5), /판매사\s*:\s*([^·\n]+?)\s*(?:·|$)/),
      supplier: pick(g(5), /공급사\s*:\s*([^·\n]+?)\s*(?:·|$)/),
      pname: c8.split('상품코드:')[0].trim().slice(0, 120),
      optionCode: pick(c8, /옵션코드:\s*(\d+)/),
      qty: num(g(10)),
      refundAmount: num((g(11).match(/\)\s*([\d,]+)/) || [])[1] || g(11)),
      shipFee: num(g(12)),
      memo: null,
      raw: { statusText: c2, dates: c3, amountText: g(11), shipText: g(12) },
    };
  }

  function url(page) {
    var q = ['pagesize=' + PAGE_SIZE, 'page=' + page, 'daytype=reg_date'];
    if (FROM) q.push('date_from=' + FROM);
    if (TO) q.push('date_to=' + TO);
    return LIST + '?' + q.join('&');
  }

  function fetchPage(page) {
    return fetch(url(page), { credentials: 'include' })
      .then(function (r) { return r.text(); })
      .then(function (html) {
        if (/name=["']?(userid|login)/i.test(html) && html.length < 5000) throw new Error('AUTH_REQUIRED');
        var doc = new DOMParser().parseFromString(html, 'text/html');
        var t = bigTable(doc);
        var bad = checkHeaders(t);
        if (bad) { var e = new Error(bad); e.code = 'HTML_STRUCTURE_CHANGED'; throw e; }
        var total = null;
        var m = doc.body.innerText.match(/전체\s*([\d,]+)\s*건/);
        if (m) total = Number(m[1].replace(/,/g, ''));
        var out = [];
        for (var i = 1; i < t.rows.length; i++) {
          var r = null;
          try { r = readRow(t.rows[i]); } catch { r = null; }
          if (r) out.push(r);
        }
        return { rows: out, total: total };
      });
  }

  function send(rows) {
    return new Promise(function (resolve) {
      say('ERP 로 보내는 중… (' + rows.length + '건)');
      var reuse = window.__bjcWin && !window.__bjcWin.closed;
      var w = reuse ? window.__bjcWin : window.open(ERP_URL, 'erp_bjc_receiver');
      if (!w) { finish('error', '팝업 차단됨'); done('팝업이 막혔습니다. 허용 후 다시 눌러주세요.', true); return resolve({ ok: false }); }
      window.__bjcWin = w;
      var sent = false, timer = null;
      function off() { window.removeEventListener('message', onMsg); clearTimeout(timer); }
      function push() { if (sent) return; sent = true; w.postMessage({ type: 'BJC_DATA', rows: rows }, ERP_ORIGIN); }
      function onMsg(e) {
        if (e.origin !== ERP_ORIGIN || !e.data) return;
        if (e.data.type === 'EZ_READY') push();
        else if (e.data.type === 'BJC_SAVED') {
          off(); finish('ok', '저장 완료', { result: e.data.result });
          var r = e.data.result || {};
          done('저장했습니다 · ' + (r.saved || 0) + '건 · 주문 미연결 ' + (r.unmatched || 0));
          resolve({ ok: true, result: r });
        } else if (e.data.type === 'BJC_ERROR' || e.data.type === 'EZ_ERROR') {
          off(); finish('error', 'ERP: ' + (e.data.message || '오류'));
          done('ERP 쪽에서 막혔습니다: ' + (e.data.message || '오류'), true);
          resolve({ ok: false });
        }
      }
      window.addEventListener('message', onMsg);
      if (reuse) setTimeout(push, 300);
      timer = setTimeout(function () {
        off(); finish('error', 'ERP 응답 없음');
        done('ERP가 응답하지 않습니다. ERP에 로그인돼 있는지 확인해주세요.', true);
        resolve({ ok: false });
      }, 600000);
    });
  }

  var all = [], total = null;
  function loop(page) {
    say('읽는 중… ' + page + '쪽 (' + all.length + '건)');
    return fetchPage(page).then(function (res) {
      if (total == null) total = res.total;
      all = all.concat(res.rows);
      if (res.rows.length >= PAGE_SIZE && page < MAX_PAGES) return loop(page + 1);
      return null;
    });
  }

  loop(1).then(function () {
    window.__bjcRows = all;
    if (DRY) {
      finish('preview', '미리보기 (저장 안 함)', { count: all.length, total: total, sample: all.slice(0, 2) });
      done('미리보기 · ' + all.length + '건 (표기 ' + total + ')');
      return;
    }
    say('읽기 완료 · ' + all.length + '건');
    // 한 번에 다 보내면 무거우니 나눠 보낸다
    var CH = 300, i = 0, agg = { saved: 0, unmatched: 0, rows: 0 };
    function next() {
      if (i >= all.length) {
        finish('ok', '전체 저장 완료', { result: agg, total: total });
        done('완료 · ' + agg.saved + '건 저장 · 미연결 ' + agg.unmatched);
        return;
      }
      var part = all.slice(i, i + CH); i += CH;
      send(part).then(function (r) {
        if (!r.ok) { finish('error', '중간에 멈췄습니다', { result: agg }); return; }
        agg.saved += (r.result.saved || 0);
        agg.unmatched += (r.result.unmatched || 0);
        agg.rows += (r.result.rows || 0);
        setTimeout(next, 800);
      });
    }
    next();
  }).catch(function (e) {
    var m = String((e && e.message) || e);
    if (m === 'AUTH_REQUIRED') { finish('error', '발주모아 로그인 필요'); done('발주모아 로그인이 풀렸습니다.', true); }
    else if (e && e.code === 'HTML_STRUCTURE_CHANGED') { finish('error', m); done('화면 구조가 바뀌었습니다. <b>저장을 중단했습니다.</b><br>' + m, true); }
    else { finish('error', m); done('읽지 못했습니다: ' + m, true); }
  });
})();
