/* 카페24(자사몰) → 사내 ERP 수집기 — 자사몰 일일 손익용 (2026-09-11)
 *
 * 카페24 관리자에 로그인한 상태에서 즐겨찾기를 누르면 이 파일이 불려온다.
 * 하는 일은 **읽기뿐**이다. 카페24 에 아무것도 쓰지 않는다 (주문 목록 검색만 한다).
 *
 * 왜 필요한가
 *   발주모아는 네이버페이 주문(카페24 결제수단 「선불금」)을 0원으로 받는다. 8월에만 1,866건 5,175만 원.
 *   그래서 자사몰 매출은 카페24 에서 직접 가져와야 맞다.
 *
 * 무엇을 가져오나 — 결제일 기준, 주문 한 건마다
 *   주문번호 · 상품구매금액 · 주문금액(상품+택배비) · 실결제금액 · 결제수단
 *   ⚠ 고객 이름·전화·주소는 **읽지도 보내지도 않는다.**
 *
 * 비밀번호·토큰을 저장하지 않는다. 로그인된 브라우저 세션을 그대로 쓴다.
 * 우리 ERP 로는 창을 하나 열어 postMessage 로 넘긴다 — 그래야 ERP 로그인 정보가 이 파일 안에 들어오지 않는다.
 *
 * 며칠치: window.__c24Days (기본 10일, 오늘 포함). 처음 한 번은 45 로 과거를 채운다.
 */
(function () {
  'use strict';

  var ERP_ORIGIN = 'https://jeahacompany.github.io';
  var ERP_URL = ERP_ORIGIN + '/erp/analysis/jasa/?receive=1';
  var LIST = '/admin/php/shop1/s_new/order_list.php';
  var DAYS = Math.max(1, Math.min(93, (window.__c24Days && Number(window.__c24Days)) || 10));
  var CHUNK = 2000;

  if (!/\.cafe24\.com$/.test(location.hostname) || location.pathname.indexOf('/admin/') !== 0) {
    alert('카페24 관리자 화면(fs6066.cafe24.com/admin)에서 눌러주세요.');
    return;
  }
  if (window.__c24CollectRunning) return;
  window.__c24CollectRunning = true;

  // ⚠ 클릭 권한이 살아 있을 때 **먼저** 창을 연다. 다 읽고 나서 열면 팝업 차단에 걸린다 (EZ 수집기에서 겪음).
  var win = window.open(ERP_URL, 'erp_c24_receiver');

  var box = document.createElement('div');
  box.style.cssText =
    'position:fixed;right:16px;bottom:16px;z-index:2147483647;width:330px;' +
    'background:#fff;border:1px solid #cbd5e1;border-radius:10px;padding:14px 16px;' +
    'box-shadow:0 8px 24px rgba(0,0,0,.18);font:13px/1.6 -apple-system,BlinkMacSystemFont,"Malgun Gothic",sans-serif;color:#0f172a';
  box.innerHTML = '<div style="font-weight:700;margin-bottom:6px">자사몰 주문 → ERP</div><div id="c24c-msg">준비 중…</div>';
  document.body.appendChild(box);
  var msgEl = box.querySelector('#c24c-msg');
  function say(t) { msgEl.innerHTML = t; }
  function done(t, bad) {
    say('<span style="color:' + (bad ? '#dc2626' : '#15803d') + '">' + t + '</span>');
    window.__c24CollectRunning = false;
    setTimeout(function () { box.remove(); }, bad ? 15000 : 8000);
  }
  if (!win) { done('팝업이 막혔습니다. 주소창 오른쪽에서 팝업을 허용한 뒤 다시 눌러주세요.', true); return; }

  function num(s) { return Number(String(s || '').replace(/[^\d-]/g, '')) || 0; }
  function ymd(d) {
    var z = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate());
  }

  // 검색 양식: 주문 목록 화면이면 그 양식을, 아니면 주문 목록을 한 번 불러와 양식만 빌린다
  function getForm() {
    if (document.forms.frm && location.pathname === LIST) return Promise.resolve(document.forms.frm);
    return fetch(LIST, { credentials: 'include' }).then(function (r) { return r.text(); }).then(function (h) {
      var f = new DOMParser().parseFromString(h, 'text/html').forms.frm;
      if (!f) throw new Error('카페24 주문 목록 양식을 못 찾았습니다 (로그인 확인)');
      return f;
    });
  }

  var METHOD = /(신용카드|휴대폰|계좌이체|가상계좌|무통장입금|선불금|적립금|예치금|카카오페이|네이버페이|토스페이|페이코)/g;

  function readDay(form, day, page) {
    var fd = new FormData(form);
    function setv(k, v) { fd.delete(k); fd.append(k, v); }
    var p = day.split('-');
    setv('date_type', 'pay_date'); setv('start_date', day); setv('end_date', day);
    setv('year1', p[0]); setv('month1', p[1]); setv('day1', p[2]);
    setv('year2', p[0]); setv('month2', p[1]); setv('day2', p[2]);
    setv('btnDate', ''); setv('date_range_mode', 'custom'); setv('rows', '500'); setv('realclick', 'T');
    if (page > 1) setv('page', String(page));
    fd.delete('shop_no_order[]');
    ['all', '1', '4', '5', '6'].forEach(function (v) { fd.append('shop_no_order[]', v); });
    return fetch(LIST, { method: 'POST', body: fd, credentials: 'include' })
      .then(function (r) { return r.text(); })
      .then(function (h) {
        var doc = new DOMParser().parseFromString(h, 'text/html');
        var out = [];
        [].slice.call(doc.querySelectorAll('table')).forEach(function (t) {
          var tx = t.innerText || t.textContent || '';
          if (!/\d{8}-\d{7}/.test(tx) || !/KRW/.test(tx) || t.querySelectorAll('tr').length > 3) return;
          tx = tx.replace(/\s+/g, ' ');
          var no = (tx.match(/(20\d{6}-\d{7})/) || [])[1];
          var k = []; tx.replace(/KRW\s*([\d,]+)/g, function (_, v) { k.push(num(v)); });
          if (!no || k.length < 3) return;
          var m = tx.match(METHOD) || [];
          var uniq = m.filter(function (x, i) { return m.indexOf(x) === i; });
          // 고객 정보는 담지 않는다 — 주문번호 · 금액 · 결제수단만
          out.push({ no: no, payDate: day, product: k[0], order: k[1], paid: k[2], method: uniq.join('+') });
        });
        return out;
      });
  }

  var today = new Date();
  var days = [];
  for (var i = DAYS - 1; i >= 0; i--) days.push(ymd(new Date(today.getFullYear(), today.getMonth(), today.getDate() - i)));

  var rows = [], dayStat = [];
  // ⚠ 다 읽었는데 ERP 로그인이 만료돼 저장만 못 했으면(2026-09-11 첫 시험에서 겪음),
  //   30분 안에 다시 누르면 카페24 를 또 읽지 않고 읽어 둔 것을 그대로 보낸다.
  var pend = window.__c24Pending;
  if (pend && pend.days === DAYS && Date.now() - pend.at < 30 * 60 * 1000) {
    rows = pend.rows; dayStat = pend.dayStat;
    say('아까 읽어 둔 주문 ' + rows.length + '건을 다시 보냅니다…');
    send();
    return;
  }
  getForm().then(function (form) {
    var di = 0;
    function nextDay() {
      if (di >= days.length) return Promise.resolve();
      var day = days[di++];
      say('카페24 주문 읽는 중… ' + day + ' (' + di + '/' + days.length + '일) · 지금까지 ' + rows.length + '건');
      var seen = {}, got = [];
      function page(pn) {
        return readDay(form, day, pn).then(function (list) {
          var fresh = list.filter(function (r) { return !seen[r.no] && (seen[r.no] = 1); });
          got = got.concat(fresh);
          // 500건이 꽉 차면 다음 쪽. 같은 주문만 또 오면(쪽 넘김이 안 먹으면) 멈추고 알린다.
          if (list.length >= 500 && fresh.length > 0 && pn < 20) return page(pn + 1);
          if (list.length >= 500 && fresh.length === 0) throw new Error(day + ' 주문이 500건을 넘는데 다음 쪽을 못 읽었습니다');
        });
      }
      return page(1).then(function () {
        rows = rows.concat(got);
        dayStat.push({ day: day, orders: got.length });
        return nextDay();
      });
    }
    return nextDay();
  }).then(function () {
    send();
  }).catch(function (e) {
    done('읽지 못했습니다: ' + (e && e.message ? e.message : e), true);
  });

  function send() {
    say('ERP로 보내는 중… 주문 ' + rows.length + '건');
    window.__c24Pending = { rows: rows, dayStat: dayStat, days: DAYS, at: Date.now() };
    var parts = [];
    for (var s = 0; s < rows.length; s += CHUNK) parts.push(rows.slice(s, s + CHUNK));
    if (!parts.length) parts.push([]);
    var at = 0, saved = 0, started = false, timer = null;
    function arm() { clearTimeout(timer); timer = setTimeout(function () { stop('ERP가 응답하지 않습니다. ERP에 로그인돼 있는지 확인해주세요.', true); }, 120000); }
    function stop(t, bad) { clearTimeout(timer); window.removeEventListener('message', onMsg); done(t, bad); }
    function post(target) {
      var last = at === parts.length - 1;
      // 날짜 목록은 마지막 조각에만 싣는다 — 다 받은 뒤에야 「그날 다 읽었다」고 적는다
      target.postMessage({ type: 'C24_ORDERS', rows: parts[at], days: last ? dayStat : [], last: last }, ERP_ORIGIN);
      arm();
    }
    function onMsg(e) {
      if (e.origin !== ERP_ORIGIN || !e.data) return;
      var target = e.source || win;
      if (e.data.type === 'C24_READY' && !started) { started = true; post(target); }
      else if (e.data.type === 'C24_SAVED') {
        saved += (e.data.result && e.data.result.rows) || 0;
        at++;
        if (at < parts.length) { say('ERP 저장 ' + at + '/' + parts.length); post(target); return; }
        window.__c24Pending = null;
        stop('보냈습니다 · ' + days[0] + ' ~ ' + days[days.length - 1] + ' · 주문 ' + saved + '건');
      } else if (e.data.type === 'C24_ERROR') {
        stop('ERP 쪽에서 막혔습니다: ' + (e.data.message || '알 수 없는 오류'), true);
      }
    }
    window.addEventListener('message', onMsg);
    arm();
    // 창이 이미 준비돼 있을 수도 있다 — 한 번 물어본다
    try { win.postMessage({ type: 'C24_PING' }, ERP_ORIGIN); } catch { /* 아직 로딩 중 */ }
  }
})();
