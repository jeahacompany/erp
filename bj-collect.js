/* 발주모아 → 사내 ERP 수집기 (읽기 전용)
 *
 * 발주모아 화면에 로그인한 상태에서 불러 쓴다. 조회만 하고 아무것도 쓰지 않는다.
 * 비밀번호·쿠키·토큰을 저장하지 않는다. 로그인된 브라우저 세션을 그대로 쓴다.
 *
 * ⚠ 발주모아는 JSON API 가 아니라 HTML 표다.
 *   화면 구조가 바뀌면 엉뚱한 칸을 읽어 "조용히 틀린 값"이 들어갈 수 있다.
 *   그래서 표 머리글을 먼저 확인하고, 하나라도 다르면 **저장하지 않고 멈춘다.**
 *
 * 저장 경로는 새로 만들지 않는다. 기존 주문 업로드(importOrders)를 그대로 탄다.
 */
(function () {
  'use strict';

  // ── 발주모아 요청 문지기 (공용) ──────────────────────────────────────
  // 왜 필요한가
  //   2026-09-04, 같은 화면에 요청을 연달아 던졌더니 발주모아가 **응답을 아예 멈췄다.**
  //   수집기들은 각자 쉬는 시간을 갖고 있었지만, 서로를 몰라서 동시에 두드릴 수 있었다.
  //   남의 서버다. 한 번에 하나씩, 쉬면서, 막히면 물러난다.
  //
  //   · 한 줄로 세운다(single-flight) — 같은 탭의 수집기들이 이 문지기 하나를 같이 쓴다
  //   · 요청 사이에 무조건 쉰다 + 흔든다(jitter)
  //   · 429/5xx 면 물러난다(exponential backoff, 최대 2분)
  //   · 응답이 없으면 30초에 끊는다(timeout)
  //   · 네 번까지만 다시 해 보고 그 뒤엔 실패로 알린다
  if (!window.__bjNet) {
    window.__bjNet = (function () {
      var chain = Promise.resolve();
      var coolUntil = 0;      // 이 시각까지는 새 요청을 시작하지 않는다
      var lastFails = 0;
      var MIN = 450, JIT = 350, TIMEOUT = 30000, MAX_TRY = 4, COOL_MAX = 120000;

      function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
      function backoff(n) { return Math.min(COOL_MAX, 2000 * Math.pow(2, n)); }

      function once(url, tryNo) {
        var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        var timer = ctl ? setTimeout(function () { ctl.abort(); }, TIMEOUT) : null;
        var opt = { credentials: 'include' };
        if (ctl) opt.signal = ctl.signal;
        return fetch(url, opt).then(function (r) {
          if (timer) clearTimeout(timer);
          // 너무 많이 두드렸거나(429) 서버가 아플 때(5xx) 는 물러난다
          if (r.status === 429 || r.status >= 500) {
            lastFails++;
            var w = backoff(tryNo);
            coolUntil = Date.now() + w;
            if (tryNo >= MAX_TRY) {
              throw new Error('발주모아가 응답하지 않습니다 (' + r.status + '). 잠시 뒤 다시 합니다.');
            }
            return sleep(w).then(function () { return once(url, tryNo + 1); });
          }
          lastFails = 0;
          return r;
        }).catch(function (e) {
          if (timer) clearTimeout(timer);
          lastFails++;
          if (tryNo >= MAX_TRY) throw e;
          var w = backoff(tryNo);
          coolUntil = Date.now() + w;
          return sleep(w).then(function () { return once(url, tryNo + 1); });
        });
      }

      return {
        get: function (url) {
          var p = chain.then(function () {
            var wait = Math.max(0, coolUntil - Date.now()) +
                       MIN + Math.floor(Math.random() * (JIT + 1));
            return sleep(wait);
          }).then(function () { return once(url, 1); });
          // 하나가 실패해도 줄은 계속 이어진다
          chain = p.then(function () {}, function () {});
          return p;
        },
        state: function () { return { fails: lastFails, coolUntil: coolUntil }; },
      };
    })();
  }

  var ERP_ORIGIN = 'https://jeahacompany.github.io';
  var ERP_URL = ERP_ORIGIN + '/erp/data/ez/?receive=1';
  var LIST = '/Dist/order00';
  var MAX_PAGES = 400;
  var PAGE_SIZE = 1000;

  // 표 머리글이 이 낱말을 품고 있어야 한다. 하나라도 어긋나면 멈춘다.
  var EXPECT = [
    { i: 3, must: ['주문번호'] },
    { i: 4, must: ['주문자'] },
    { i: 5, must: ['주소'] },
    { i: 6, must: ['상품정보', '판매사'] },
    { i: 8, must: ['수량'] },
    { i: 9, must: ['택배사', '송장번호'] },
    { i: 10, must: ['배송비'] },
    { i: 11, must: ['주문상태'] },
  ];

  var opt = window.__bjOptions || {};
  var DATE_FROM = opt.from || null;   // 'YYYY-MM-DD'
  var DATE_TO = opt.to || null;
  // ⚠ 날짜 축을 하나만 돌면 반드시 빠진다.
  //    우리 매출 기준은 "송장 등록일" 인데, 주문일 축으로만 읽으면
  //    오래 전에 주문돼서 오늘 송장이 붙은 건을 영영 못 본다.
  //    (2026-09-02 실측: 9/1 송장분 710건 중 8건이 그렇게 빠져 있었다)
  //
  //      order_date              주문일       — 아직 송장 안 붙은 주문도 잡는다
  //      deliveryNum_updatedate  송장 등록일  — 매출 기준. 이게 빠지면 매출이 샌다
  var DAYTYPE = opt.daytype || 'order_date';
  var DAYTYPES = (opt.daytypes && opt.daytypes.length)
               ? opt.daytypes
               // 자동수집은 두 축을 반드시 다 돈다.
               // 송장일 축을 빼면 매출이 새고, 주문일 축을 빼면 아직 안 나간 주문을 놓친다.
               : (opt.sync ? ['deliveryNum_updatedate', 'order_date'] : [DAYTYPE]);
  var DRY = !!opt.dryRun;

  // ⚠ 한 발주모아 계정을 푸드시그널과 도반글로벌이 같이 쓴다 (사용료가 비싸서).
  //   그래서 판매사 이름만 보고 나누면 안 된다. 공급사를 같이 봐야 한다.
  //
  //   판매사 집먹·푸드            → 푸드시그널 일반 매출          normal
  //   판매사 도반·위탁 + 공급사 도반- → 도반 내부 거래              doban_internal
  //   판매사 도반·위탁 + 공급사 도반- 아님 → 도반이 갚을 돈(공급가)  doban_receivable
  //
  // ⚠ 도반 내부 거래도 **버리지 않고 담는다.**
  //   예전에는 아예 안 가져왔는데, 그러면 발주모아에 있는 주문이 우리 ERP 에 없어서
  //   "빠진 거냐 일부러 뺀 거냐" 를 아무도 증명할 수 없었다.
  //   발주모아가 원본이므로 원본에 있는 줄은 다 담고, 성격만 표시해 둔다.
  //   매출(bj_sales)·미수금(bj_receivables)은 stype 으로 걸러서 보므로 섞이지 않는다.
  var BRAND = opt.brand || 'foodsignal';
  function classify(channel, supplier) {
    var ch = String(channel || ''), sp = String(supplier || '');
    var isDobanCh = /^(도반|위탁)/.test(ch);
    var isDobanSp = /^도반-/.test(sp);
    if (BRAND === 'doban') {
      // 도반 장부: 도반이 팔고 도반이 댄 것만
      return (isDobanCh && isDobanSp) ? 'normal' : null;
    }
    if (!isDobanCh) return 'normal';           // 집먹·푸드 = 그냥 우리 매출
    if (isDobanSp) return 'doban_internal';     // 도반↔도반 = 우리 매출은 아니다. 그래도 담는다
    return 'doban_receivable';                  // 도반이 팔고 우리가 댐 = 미수금
  }

  window.__bjResult = { state: 'running', at: new Date().toISOString() };
  function finish(state, msg, extra) {
    window.__bjResult = Object.assign(
      { state: state, msg: msg, at: new Date().toISOString() }, extra || {});
  }

  // ── 화면 표시 ────────────────────────────────────────────────────────
  var box = document.createElement('div');
  box.style.cssText =
    'position:fixed;right:16px;bottom:16px;z-index:2147483647;width:340px;background:#fff;' +
    'border:1px solid #cbd5e1;border-radius:10px;padding:14px 16px;box-shadow:0 8px 24px rgba(0,0,0,.18);' +
    'font:13px/1.6 -apple-system,BlinkMacSystemFont,"Malgun Gothic",sans-serif;color:#0f172a';
  box.innerHTML = '<div style="font-weight:700;margin-bottom:6px">발주모아 → ERP</div><div id="bj-msg">준비 중…</div>';
  document.body.appendChild(box);
  var msgEl = box.querySelector('#bj-msg');
  function say(t) { msgEl.innerHTML = t; }
  function done(t, bad) {
    say('<span style="color:' + (bad ? '#dc2626' : '#15803d') + '">' + t + '</span>');
    if (bad) setTimeout(function () { if (box.parentNode) box.remove(); }, 20000);
  }

  var txt = function (el) { return el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : ''; };
  var num = function (s) { var m = String(s == null ? '' : s).replace(/[^0-9.-]/g, ''); return m === '' ? null : Number(m); };
  function pick(s, re) { var m = String(s || '').match(re); return m ? m[1] : null; }

  // 전화번호 찾기.
  // 국번 3자리까지 허용(0505·0507 안심번호), 숫자 한가운데서 시작하지 못하게 막는다.
  // 반환: { value, index } — index 는 번호가 시작하는 위치 (이름을 자르는 데 쓴다)
  function matchPhone(s) {
    var str = String(s || '');
    var re = /(^|[^0-9])(0\d{1,3}[-\s]?\d{3,4}[-\s]?\d{4})(?![0-9])/;
    var m = str.match(re);
    if (!m) return null;
    var lead = m[1] || '';
    var start = m.index + lead.length;
    return { value: m[2], index: start };
  }

  // 셀 안의 줄들을 나눈다 (<br> 이나 블록 요소 기준)
  function lines(cell) {
    if (!cell) return [];
    return (cell.innerHTML || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(div|p|li|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .split('\n')
      .map(function (x) { return x.replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim(); })
      .filter(Boolean);
  }

  function checkHeaders(table) {
    if (!table || !table.rows.length) return '주문 표를 찾지 못했습니다';
    var hs = [].map.call(table.rows[0].cells, function (c) { return txt(c); });
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

  // ⚠ 표를 "크기"로 고르면 안 된다.
  //    결과가 적은 날에는 화면 위쪽 검색필터 표(9줄)가 주문 표보다 커서
  //    그걸 집어 들고 "칸 수가 예상과 다릅니다" 로 멈춘다 = 그 날 자료가 통째로 빠진다.
  //    (2026-09-02 확인: 검색결과 2건일 때 실제로 필터 표가 선택됐다)
  //    그래서 머리글에 "주문번호" 가 있는 표만 고른다.
  function bigTable(doc) {
    var ts = [].slice.call(doc.querySelectorAll('table'));
    for (var i = 0; i < ts.length; i++) {
      var r0 = ts[i].rows[0];
      if (!r0) continue;
      for (var j = 0; j < r0.cells.length; j++) {
        if ((r0.cells[j].textContent || '').indexOf('주문번호') >= 0) return ts[i];
      }
    }
    return null;   // 못 찾으면 checkHeaders 가 멈춘다
  }

  function url(page, from, to, daytype) {
    var q = ['search=mo_allname', 'keyword=', 'daytype=' + (daytype || DAYTYPE),
             'pagesize=' + PAGE_SIZE, 'page=' + page];
    if (from) q.push('date_from=' + from);
    if (to) q.push('date_to=' + to);
    return LIST + '?' + q.join('&');
  }

  // ── 한 줄 읽기 ───────────────────────────────────────────────────────
  function readRow(tr) {
    var c = tr.cells;
    if (!c || c.length < 12) return null;
    var g = function (i) { return txt(c[i]); };

    var c3 = g(3);
    var hubNo = pick(c3, /\b(WFS\d{6}-\d+)\b/);
    var srcNo = pick(c3, /\(([^)]+)\)/);
    if (!srcNo && !hubNo) return null;

    var c6 = g(6), c8 = g(8), c9 = g(9), c10 = g(10);

    // 주문자 / 수령인 — 줄 단위로 나눠 읽는다
    //
    // ⚠ 전화번호를 잘못 자르면 이름이 망가진다.
    //   안심번호(0505-1234-5678, 0507-…)는 국번이 4자리다.
    //   예전 정규식이 \d{1,2} 까지만 봐서 "0505-1234-5678" 을
    //   "05" + "05-1234-5678" 로 잘랐고, 앞의 "05" 가 이름으로 들어갔다 (1,389건).
    //   그래서 국번을 3자리까지 허용하고, 숫자 한가운데서 시작하지 못하게 막는다.
    var L4 = lines(c[4]);
    var buyerName = L4[0] || '';
    var buyerPhone = '';
    var recvName = '';
    var recvPhone = '';
    var ph = [];
    for (var i = 0; i < L4.length; i++) {
      var p = matchPhone(L4[i]);
      if (p) ph.push({ i: i, v: p.value, at: p.index });
    }
    if (ph.length >= 1) { buyerPhone = ph[0].v; }
    if (ph.length >= 2) { recvPhone = ph[1].v; }
    // 이름은 전화번호 앞부분. 앞이 비면 그 위 줄을 쓴다.
    function nameNear(k, at) {
      if (k == null) return '';
      var s = L4[k] || '';
      var cut = (at > 0 ? s.slice(0, at) : '').trim();
      if (cut) return cut;
      return (L4[k - 1] || '').trim();
    }
    if (ph.length >= 1) buyerName = nameNear(ph[0].i, ph[0].at) || buyerName;
    if (ph.length >= 2) recvName = nameNear(ph[1].i, ph[1].at);
    if (!recvName && L4.length > 1) recvName = L4[L4.length - 1];

    var c5 = g(5);
    var zip = pick(c5, /\[(\d{5})\]/) || '';
    var addr = c5.replace(/\[\d{5}\]/, '').trim();

    var pname = null, popt = null;
    var L6 = lines(c[6]);
    // 상품명/옵션은 상품코드 줄 앞쪽에 있다
    for (var q = 0; q < L6.length; q++) {
      if (/상품코드:/.test(L6[q])) break;
      if (q === 1) pname = L6[q];
      if (q === 2) popt = L6[q];
    }

    return {
      bjId: (tr.querySelector('input[name=chk]') || {}).value || null,
      srcNo: srcNo || hubNo,
      hubNo: hubNo || null,
      channel: pick(c6, /판매사:\s*([^\[\n]+?)\s*(?:\[|$)/),
      supplier: pick(c6, /공급사:\s*([^\[\n]+?)\s*(?:\[|$)/),
      orderedAt: pick(c3, /주문일\s*([\d-]+\s[\d:]+)/),
      paidAt: pick(c3, /입금일\s*([\d-]+\s[\d:]+)/),
      uploadedAt: pick(c3, /업로드\s*([\d-]+\s[\d:]+)/),
      buyerName: buyerName, buyerPhone: buyerPhone,
      recvName: recvName || buyerName, recvPhone: recvPhone || buyerPhone,
      recvZip: zip, recvAddr: addr,
      pname: pname || (L6[1] || ''),
      popt: popt || '',
      goodsCode: pick(c6, /상품코드:\s*([A-Za-z0-9_-]+)/),
      optionCode: pick(c6, /옵션코드:\s*(\d+)/),
      chGoodsId: pick(g(7), /상품코드:\s*(\d+)/),
      qty: num(pick(c8, /수량\s*:\s*([\d,]+)/)) || 1,
      payAmount: num(pick(c8, /결제\s*:\s*([\d,]+)/)),
      consumerAmount: num(pick(c8, /소비자\s*:\s*([\d,]+)/)),
      sellerAmount: num(pick(c8, /판매사\s*:\s*([\d,]+)/)),
      supplyAmount: num(pick(c8, /공급사\s*:\s*([\d,]+)/)),
      payMethod: (lines(c[8])[0] || '').slice(0, 20),
      courier: (c9 ? c9.split(/\s+/)[0] : '') || null,
      invoiceNo: pick(c9, /\b(\d{9,14})\b/),
      invoiceAt: pick(c9, /\(([\d-]+\s[\d:]+)\)/),
      shipFee: num(pick(c10, /결제\s*:\s*([\d,]+)/)),
      shipFeeSeller: num(pick(c10, /판매사\s*:\s*([\d,]+)/)),
      shipFeeSupply: num(pick(c10, /공급사\s*:\s*([\d,]+)/)),
      orderState: g(11),
      csText: g(12),
    };
  }

  // ── 페이지 순회 ──────────────────────────────────────────────────────
  // 표를 아예 못 찾은 것과, 표는 있는데 머리글이 다른 것은 다르다.
  //   못 찾음   → 서버가 잠깐 엉뚱한 응답(오류/점검 화면)을 준 것일 수 있다 → 다시 시도
  //   머리글 다름 → 진짜 화면 구조가 바뀐 것 → 바로 멈춘다 (틀린 값을 넣지 않는다)
  var PAGE_RETRY = 3;

  // ── 남의 서버를 때리지 않는다 ────────────────────────────────────────
  // 발주모아는 우리 서버가 아니다. 쉬지 않고 연달아 부르면 그쪽에 부담이 되고,
  // 우리도 차단당하면 아무것도 못 하게 된다.
  //   pageDelayMs  페이지 사이에 무조건 쉰다
  //   jitterMs     기계처럼 정확히 같은 간격이 되지 않게 흔들어 준다
  //   백오프       실패하면 쉬는 시간을 배로 늘린다 (fetchPage 안에 이미 있다)
  //   차단기       연속으로 이만큼 실패하면 그냥 멈춘다
  var TUNE = {
    pageDelayMs: Number(opt.pageDelayMs) || 400,
    jitterMs: Number(opt.jitterMs) || 300,
    breakerFails: Number(opt.breakerFails) || 5,
  };
  var failStreak = 0;

  function rest() {
    var ms = TUNE.pageDelayMs + Math.floor(Math.random() * (TUNE.jitterMs + 1));
    return new Promise(function (r) { setTimeout(r, ms); });
  }
  function fetchPage(page, from, to, daytype, attempt) {
    attempt = attempt || 1;
    var lastUrl = '';
    return window.__bjNet.get(url(page, from, to, daytype))
      .then(function (r) {
        // ⚠ 로그인 풀림은 세 가지 모습으로 온다. 셋 다 봐야 한다.
        //   ① /Login/ 으로 끌려감  ② 로그인 화면 HTML  ③ 98바이트 <script> 조각(2026-09-04)
        //   크기로 판단하면 안 된다 — 로그인 화면은 29KB 다.
        lastUrl = r.url || '';
        return r.text();
      })
      .then(function (html) {
        if (/\/Login\//i.test(lastUrl)) throw new Error('AUTH_REQUIRED');
        if (/id=["']?userId["']?/.test(html) && /type=["']?password/.test(html)) {
          throw new Error('AUTH_REQUIRED');
        }
        if (/location[^;<]{0,60}\/Login\//i.test(html)) throw new Error('AUTH_REQUIRED');
        var doc = new DOMParser().parseFromString(html, 'text/html');
        var t = bigTable(doc);

        // 그 날 자료가 정말 0건이면 발주모아는 주문 표를 아예 안 그린다.
        // "주문이 없습니다" 라고 적어준다. 이건 오류가 아니라 정상이다.
        // (송장등록일 축에서는 휴일 등으로 0건인 날이 실제로 있다)
        // 이걸 구조 변경으로 오해하면 그 날에서 수집이 통째로 멈춘다.
        if (!t && /주문이\s*없습니다/.test(doc.body.innerText)) {
          return { rows: [], total: 0 };
        }

        if (!t && attempt < PAGE_RETRY) {
          say('응답이 이상해 다시 받는 중… (' + attempt + '/' + PAGE_RETRY + ')');
          return new Promise(function (res) { setTimeout(res, 2000 * attempt); })
            .then(function () { return fetchPage(page, from, to, daytype, attempt + 1); });
        }
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

  // ── 판매사별 · 판매처 주문번호별로 묶는다 ────────────────────────────
  // ⚠ WFS 번호는 합포장 키다. 서로 다른 판매처 주문 여러 건이 한 WFS 로 묶인다.
  //    그래서 주문 키는 반드시 "판매처 주문번호" 를 쓴다.
  function build(rows) {
    var byCh = {};
    var skipped = {};
    rows.forEach(function (r) {
      var ch = (r.channel || '미지정').trim();
      var kind = classify(ch, r.supplier);
      if (!kind) { skipped[ch] = (skipped[ch] || 0) + 1; return; }
      r.settleType = kind;
      byCh[ch] = byCh[ch] || {};
      var key = r.srcNo;
      var o = byCh[ch][key];
      if (!o) {
        o = byCh[ch][key] = {
          orderNo: key,
          orderedAt: r.orderedAt ? r.orderedAt.replace(' ', 'T') + '+09:00' : null,
          buyerName: r.buyerName, buyerPhone: r.buyerPhone,
          recvName: r.recvName, recvPhone: r.recvPhone,
          recvZip: r.recvZip, recvAddr: r.recvAddr,
          memo: '',
          payAmount: 0, shipFee: 0,
          items: [],
          raw: {
            src: 'baljumoa',
            hubOrderNo: r.hubNo, bjId: r.bjId,
            paidAt: r.paidAt, uploadedAt: r.uploadedAt,
            payMethod: r.payMethod, supplier: r.supplier,
            courier: r.courier, invoiceNo: r.invoiceNo, invoiceAt: r.invoiceAt,
            orderState: r.orderState, csText: r.csText,
            // 매출 인식은 "송장 등록일" 기준으로 본다 (대표 확정, 2026-09-02).
            revenueDate: r.invoiceAt ? String(r.invoiceAt).slice(0, 10) : null,
            // normal = 우리 매출 / doban_receivable = 도반이 우리에게 갚을 돈(공급가)
            settleType: r.settleType,
            amounts: { pay: [], consumer: 0, seller: 0, supply: 0 },
            shipFees: { pay: [], seller: 0, supply: 0 },
          },
        };
      }
      // ⚠ 공급사는 주문이 아니라 **주문상품마다** 다르다.
      //   한 주문에 공급사가 다른 상품이 섞일 수 있어서 주문 머리에만 두면 마지막 것만 남는다.
      //   공급사는 "우리가 재고를 대는 상품이냐(재고관리) / 위탁이냐" 를 가르는 기준이라
      //   줄마다 원문 그대로 보존한다. (대표 확정, 2026-09-03)
      o.items.push({
        lineNo: o.items.length + 1,
        itemNo: r.optionCode || r.goodsCode || null,
        pname: r.pname, popt: r.popt,
        qty: r.qty,
        amount: r.payAmount == null ? 0 : r.payAmount,
        supplier: r.supplier || null,     // 공급사 원문 (물류형태·정산의 기준)
        goodsCode: r.goodsCode || null,   // 발주모아 상품코드
        // 공급사별 지급 예정금액을 내려면 줄 단위 금액이 있어야 한다.
        // 주문 머리에만 합쳐 두면 한 주문에 공급사가 섞였을 때 나눌 수 없다.
        // (2026-09-03 실측: 공급사가 섞인 주문 784건 · 상품 2,436줄)
        supplyAmount: r.supplyAmount == null ? null : r.supplyAmount,
        sellerAmount: r.sellerAmount == null ? null : r.sellerAmount,
        consumerAmount: r.consumerAmount == null ? null : r.consumerAmount,
      });
      // ⚠ 같은 주문에 "같은 옵션·같은 수량·같은 금액" 줄이 두 번 나오는 경우가 있다.
      //   원본을 보면 송장번호가 서로 달라서, 같은 상품을 두 번 내보낸 것(분할출고·재배송)이다.
      //   고객은 한 번만 결제했으므로 결제금액을 두 번 더하면 매출이 부풀려진다.
      //   줄(출고 기록)은 그대로 남기고, 결제금액만 한 번 센다.
      var payKey = (r.optionCode || '') + '|' + r.qty + '|' + r.payAmount;
      if (!o.__paySeen) o.__paySeen = {};
      if (o.__paySeen[payKey]) {
        o.raw.dupPayLines = (o.raw.dupPayLines || 0) + 1;
      } else {
        o.__paySeen[payKey] = 1;
        o.raw.amounts.pay.push(r.payAmount);
      }
      o.raw.amounts.consumer += r.consumerAmount || 0;
      o.raw.amounts.seller += r.sellerAmount || 0;
      o.raw.amounts.supply += r.supplyAmount || 0;
      o.raw.shipFees.pay.push(r.shipFee);
      o.raw.shipFees.seller += r.shipFeeSeller || 0;
      o.raw.shipFees.supply += r.shipFeeSupply || 0;
      if (!o.raw.invoiceNo && r.invoiceNo) { o.raw.invoiceNo = r.invoiceNo; o.raw.courier = r.courier; }
    });

    var out = [];
    Object.keys(byCh).forEach(function (ch) {
      var arr = Object.keys(byCh[ch]).map(function (k) {
        var o = byCh[ch][k];
        var pays = o.raw.amounts.pay.filter(function (x) { return x != null; });
        var fees = o.raw.shipFees.pay.filter(function (x) { return x != null; });
        // 결제금액은 "줄별 실제 결제액"이다. 그래서 합친다.
        // (2026-08-20~22 실측: 다품목 주문 362건 중 결제금액이 같은 건 2건뿐이고,
        //  그 2건도 소비자가 대비 합산이 맞았다. 주문 전체금액 반복이 아니다)
        o.raw.amounts.payRule = 'SUM_OF_LINES';
        o.raw.amounts.payLines = pays;
        o.payAmount = pays.reduce(function (a, b) { return a + b; }, 0);
        // 배송비는 고객이 낸 것만 (배송비 칸의 "결제"가 0보다 큰 줄)
        o.shipFee = fees.reduce(function (a, b) { return a + b; }, 0);
        delete o.raw.amounts.pay; delete o.raw.shipFees.pay; delete o.__paySeen;
        return o;
      });
      out.push({ channel: ch, source: 'baljumoa',
                 filename: '발주모아 ' + (window.__bjCurFrom || '') + '~' + (window.__bjCurTo || ''),
                 rows: arr });
    });
    window.__bjSkipped = skipped;
    return out;
  }

  // ── ERP 로 보내기 ────────────────────────────────────────────────────
  // 창은 딱 하나만 쓴다. 처음 한 번만 열고(사람이 누른 그 순간),
  // 그 뒤로는 같은 창에 계속 건넨다. 그래야 여러 날짜를 이어서 넣을 수 있다.
  // (열려 있는 창에 보내는 것은 팝업 차단과 무관하다)
  function send(payloads, stat) {
    if (BRIDGE) {
      say('ERP 로 보내는 중… (' + payloads.length + '개 판매처)');
      return bridgeSend({ type: 'BJ_DATA', payloads: payloads, stat: stat },
                        'BJ_SAVED', 'BJ_ERROR', 1200000)
        .then(function (r) {
          if (!r.ok) {
            finish('error', 'ERP: ' + (r.message || ''));
            done('ERP 쪽에서 막혔습니다: ' + (r.message || ''), true);
            return { ok: false, reason: r.message };
          }
          var res = (r.data && r.data.result) || {};
          finish('ok', '저장 완료', { result: res, stat: stat });
          done('저장 · 신규 ' + (res.new || 0) + ' · 갱신 ' + (res.dup || 0));
          return { ok: true, result: res };
        });
    }
    return new Promise(function (resolve) {
      say('ERP 로 보내는 중… (' + payloads.length + '개 판매처)');
      var reuse = window.__bjWin && !window.__bjWin.closed;
      var w = reuse ? window.__bjWin : window.open(ERP_URL, 'erp_bj_receiver');
      if (!w) {
        finish('error', '팝업 차단됨');
        done('팝업이 막혔습니다. 허용 후 다시 눌러주세요.', true);
        return resolve({ ok: false, reason: 'POPUP_BLOCKED' });
      }
      window.__bjWin = w;
      var sent = false, timer = null;
      var off = function () { window.removeEventListener('message', onMsg); clearTimeout(timer); };
      function push() {
        if (sent) return;
        sent = true;
        w.postMessage({ type: 'BJ_DATA', payloads: payloads, stat: stat }, ERP_ORIGIN);
      }
      function onMsg(e) {
        if (e.origin !== ERP_ORIGIN || !e.data) return;
        if (e.data.type === 'EZ_READY') { push(); }
        else if (e.data.type === 'BJ_SAVED') {
          off();
          var r = e.data.result || {};
          finish('ok', '저장 완료', { result: r, stat: stat });
          done('저장 · 신규 ' + (r.new || 0) + ' · 갱신 ' + (r.dup || 0) + ' · 잠김 ' + (r.locked || 0));
          resolve({ ok: true, result: r });
        } else if (e.data.type === 'EZ_ERROR' || e.data.type === 'BJ_ERROR') {
          off();
          var m = e.data.message || '오류';
          finish('error', 'ERP: ' + m);
          done('ERP 쪽에서 막혔습니다: ' + m, true);
          resolve({ ok: false, reason: m });
        }
      }
      window.addEventListener('message', onMsg);
      // 이미 떠 있는 창이면 준비 신호를 기다리지 않고 바로 건넨다.
      if (reuse) setTimeout(push, 300);

      // 답이 한참 없으면 창이 죽은 것으로 보고 한 번 다시 열어 보낸다.
      // (예전에는 그냥 멈춰서 뒤 날짜를 통째로 못 넣었다)
      var retried = false;
      var watchdog = setInterval(function () {
        var dead = !window.__bjWin || window.__bjWin.closed;
        if (dead && !retried) {
          retried = true;
          say('ERP 창이 닫혔습니다. 다시 열어 보냅니다…');
          sent = false;
          try { w = window.open(ERP_URL, 'erp_bj_receiver_' + Date.now()); } catch { w = null; }
          if (w) { window.__bjWin = w; }
        }
      }, 20000);

      var origOff = off;
      off = function () { clearInterval(watchdog); origOff(); };

      timer = setTimeout(function () {
        off();
        finish('error', 'ERP 응답 없음 (ERP 로그인 확인)');
        done('ERP가 응답하지 않습니다. ERP에 로그인돼 있는지 확인해주세요.', true);
        resolve({ ok: false, reason: 'TIMEOUT' });
      }, 1200000);
    });
  }

  // ── 하루(또는 한 기간) 처리 ─────────────────────────────────────────
  function runRange(from, to, daytype) {
    window.__bjCurFrom = from; window.__bjCurTo = to;
    var AXIS = daytype || DAYTYPE;
    var axisName = AXIS === 'deliveryNum_updatedate' ? '송장일'
                 : AXIS === 'upload_date' ? '업로드일' : '주문일';
    var all = [], total = null;
    function loop(page) {
      say('[' + axisName + '] ' + from + '~' + to + ' 읽는 중… ' + page + '쪽 (' + all.length + '줄)');
      return fetchPage(page, from, to, AXIS).then(function (res) {
        if (total == null) total = res.total;
        all = all.concat(res.rows);
        if (res.rows.length >= PAGE_SIZE && page < MAX_PAGES) {
          return rest().then(function () { return loop(page + 1); });
        }
        return null;
      });
    }
    return loop(1).then(function () {
      // 저장 전 자기검사 — 값이 망가졌으면 넣지 않는다.
      // (안심번호를 잘못 잘라 이름이 "05" 로 들어간 적이 있다)
      var bad = all.filter(function (r) {
        return !r.buyerName || /^\d+$/.test(r.buyerName) || r.buyerName.length > 20;
      });
      if (all.length && bad.length / all.length > 0.02) {
        var e = new Error('이름이 이상한 줄이 ' + bad.length + '/' + all.length +
                          ' 입니다. 읽는 방식이 틀렸을 수 있어 저장하지 않았습니다.');
        e.code = 'HTML_STRUCTURE_CHANGED';
        throw e;
      }

      var payloads = build(all);
      var stat = {
        rowsSeen: all.length, totalReported: total,
        orders: payloads.reduce(function (a, p) { return a + p.rows.length; }, 0),
        channels: payloads.map(function (p) { return p.channel + ':' + p.rows.length; }),
        receivableOrders: payloads.reduce(function (a, p) {
          return a + p.rows.filter(function (o) { return o.raw.settleType === 'doban_receivable'; }).length;
        }, 0),
        from: from, to: to, daytype: AXIS, brand: BRAND,
        skippedOtherBrand: Object.keys(window.__bjSkipped || {}).reduce(
          function (a, k) { return a + window.__bjSkipped[k]; }, 0),
      };
      window.__bjStat = stat;
      if (DRY) {
        finish('preview', '미리보기 (저장 안 함)', { stat: stat });
        done('미리보기 · 줄 ' + stat.rowsSeen + ' · 주문 ' + stat.orders);
        return { ok: true, stat: stat, saved: null };
      }
      if (!payloads.length) { return { ok: true, stat: stat, saved: { new: 0, dup: 0 } }; }
      return send(payloads, stat).then(function (r) {
        return { ok: r.ok, stat: stat, saved: r.result || null, reason: r.reason };
      });
    });
  }

  // ── ERP 에 물어보기 (계획·체크포인트·작업종료) ───────────────────────
  // 수집기는 ERP 로그인 토큰을 갖지 않는다. 일부러 그렇게 뒀다.
  // 그래서 "무엇을 읽어야 하는지" 도 스스로 정하지 않고 ERP 화면에 물어본다.
  // ── 확장 프로그램이 대신 날라줄 때 ───────────────────────────────────
  // 확장에서 이 스크립트를 넣으면 사람이 누른 것이 아니라서 window.open 이 막힌다.
  // 그래서 창을 열지 않고 **우편함**만 쓴다.
  //   여기가 __bjMsgOut 에 넣어 두면 → 확장이 ERP 탭에 갖다 주고 → __bjMsgIn 에 답을 놓는다.
  // (EZSTORAGE 수집기가 쓰는 방식과 같다. 확장은 ERP 토큰을 여전히 갖지 않는다)
  var BRIDGE = !!window.__bjBridge;
  var bridgeSeq = 0;

  function bridgeSend(msg, okType, errType, waitMs) {
    return new Promise(function (resolve) {
      var id = ++bridgeSeq;
      window.__bjMsgIn = null;
      window.__bjMsgOut = { id: id, msg: msg };
      var t0 = Date.now();
      var timer = setInterval(function () {
        var got = window.__bjMsgIn;
        if (got && got.id === id) {
          clearInterval(timer);
          window.__bjMsgIn = null;
          var d = got.reply || {};
          if (d.type === okType) return resolve({ ok: true, data: d });
          return resolve({ ok: false, message: d.message || '알 수 없는 응답' });
        }
        if (Date.now() - t0 > (waitMs || 600000)) {
          clearInterval(timer);
          window.__bjMsgOut = null;
          resolve({ ok: false, message: 'ERP가 응답하지 않습니다' });
        }
      }, 300);
    });
  }

  function ask(msg, okType, errType, waitMs) {
    if (BRIDGE) return bridgeSend(msg, okType, errType, waitMs);
    return new Promise(function (resolve) {
      var reuse = window.__bjWin && !window.__bjWin.closed;
      var w = reuse ? window.__bjWin : window.open(ERP_URL, 'erp_bj_receiver');
      if (!w) { return resolve({ ok: false, message: '팝업이 막혔습니다' }); }
      window.__bjWin = w;
      var sent = false, timer = null;
      function push() { if (!sent) { sent = true; w.postMessage(msg, ERP_ORIGIN); } }
      function off() { window.removeEventListener('message', onMsg); clearTimeout(timer); }
      function onMsg(e) {
        if (e.origin !== ERP_ORIGIN || !e.data) return;
        if (e.data.type === 'EZ_READY') return push();
        if (e.data.type === okType) { off(); resolve({ ok: true, data: e.data }); }
        else if (e.data.type === errType) { off(); resolve({ ok: false, message: e.data.message }); }
      }
      window.addEventListener('message', onMsg);
      if (reuse) setTimeout(push, 300);
      timer = setTimeout(function () {
        off(); resolve({ ok: false, message: 'ERP가 응답하지 않습니다' });
      }, waitMs || 60000);
    });
  }

  // ── 자동수집 (3단계) ─────────────────────────────────────────────────
  //   fast       15분마다 · 최근 2일  — 오늘 들어온 것을 빨리 반영
  //   reconcile  1시간마다 · 최근 7일 — 뒤늦게 바뀐 것(송장·취소)을 맞춘다
  //   deep       하루 1번 · 최근 90일 — 통째로 다시 대조. 빠진 날을 찾는다
  //   backfill   처음 긁어오기. 체크포인트로 이어받는다
  // 주기는 코드에 박지 않는다. ERP 설정(bj_sync_config)에서 읽는다.
  if (opt.sync) {
    var KIND = opt.sync;
    say('자동수집 계획을 ERP에 물어보는 중… (' + KIND + ')');
    ask({ type: 'BJ_PLAN_REQ', kind: KIND, source: 'orders', daytypes: DAYTYPES },
        'BJ_PLAN', 'BJ_PLAN_ERROR')
      .then(function (r) {
        if (!r.ok) {
          finish('error', '계획을 받지 못했습니다: ' + (r.message || ''));
          done('자동수집을 시작하지 못했습니다: ' + (r.message || ''), true);
          return;
        }
        var p = r.data;
        var cfg = p.config || {};
        TUNE.pageDelayMs = Number(cfg.pageDelayMs) || TUNE.pageDelayMs;
        TUNE.jitterMs = Number(cfg.jitterMs) || TUNE.jitterMs;
        TUNE.breakerFails = Number(cfg.breakerFails) || TUNE.breakerFails;

        // 하루 단위로 편다. 한 번에 넓게 부르면 응답이 8MB 를 넘어 터진다.
        var jobs = [];
        (p.plan || []).forEach(function (g) {
          (g.days || []).forEach(function (d) { jobs.push([d, d, g.daytype]); });
        });
        if (!jobs.length) {
          say('새로 읽을 날이 없습니다.');
          ask({ type: 'BJ_SYNC_DONE', jobId: p.jobId, status: 'SUCCESS',
                stat: { pages: 0, rows: 0, errors: 0 } }, 'BJ_DONE_OK', null, 30000);
          finish('ok', '읽을 것이 없습니다');
          done('이미 최신입니다.');
          return;
        }

        var tot = { pages: 0, rows: 0, new: 0, changed: 0, same: 0, errors: 0, lastError: null };
        window.__bjLog = [];

        (function step(i) {
          if (i >= jobs.length) {
            var st = tot.errors ? (tot.rows ? 'PARTIAL' : 'FAILED') : 'SUCCESS';
            ask({ type: 'BJ_SYNC_DONE', jobId: p.jobId, status: st, stat: tot },
                'BJ_DONE_OK', null, 30000)
              .then(function () {
                finish(tot.errors ? 'error' : 'ok',
                       KIND + ' 수집 끝 · 날 ' + jobs.length + ' · 줄 ' + tot.rows +
                       (tot.lastError ? ' · 이유: ' + tot.lastError : '') +
                       (tot.errors ? ' · 실패 ' + tot.errors : ''), { log: window.__bjLog });
                done(KIND + ' 수집 완료 · ' + jobs.length + '일 · ' + tot.rows + '줄' +
                     (tot.errors ? ' · 실패 ' + tot.errors + '일' : ''), !!tot.errors);
              });
            return;
          }
          var j = jobs[i];
          say('[' + (i + 1) + '/' + jobs.length + '] ' + j[0] + ' (' + j[2] + ')');
          runRange(j[0], j[1], j[2]).then(function (res) {
            if (res.ok) {
              failStreak = 0;
              tot.rows += (res.stat && res.stat.rowsSeen) || 0;
              tot.new += (res.saved && res.saved.new) || 0;
              tot.changed += (res.saved && res.saved.dup) || 0;
              tot.same += (res.saved && res.saved.same) || 0;
              // 하루를 다 읽었으면 표시해 둔다. PC가 꺼져도 여기서부터 이어받는다.
              return ask({ type: 'BJ_CKPT', rows: [{
                source: 'orders', daytype: j[2], day: j[0], status: 'DONE',
                rows: (res.stat && res.stat.rowsSeen) || 0 }] }, 'BJ_CKPT_OK', null, 30000);
            }
            // ⚠ 실패했는데 이유를 안 남기면 "실패 4" 만 뜨고 왜인지 아무도 모른다.
            //   던지지 않고 { ok:false } 로 돌아오는 실패도 똑같이 적어 둔다.
            failStreak++; tot.errors++; tot.lastError = res.reason || '실패';
            window.__bjLog.push({ day: j[0], daytype: j[2], ok: false, reason: tot.lastError });
            return null;
          }).catch(function (e) {
            failStreak++; tot.errors++;
            tot.lastError = String((e && e.message) || e);
            window.__bjLog.push({ day: j[0], daytype: j[2], ok: false, reason: tot.lastError });
          }).then(function () {
            // 차단기 — 연달아 실패하면 더 두드리지 않고 멈춘다.
            if (failStreak >= TUNE.breakerFails) {
              ask({ type: 'BJ_SYNC_DONE', jobId: p.jobId, status: 'FAILED',
                    stat: tot }, 'BJ_DONE_OK', null, 30000);
              finish('error', '연속 ' + failStreak + '회 실패로 중단했습니다', { log: window.__bjLog });
              done('연속 ' + failStreak + '회 실패해서 멈췄습니다. 발주모아 상태를 확인해주세요.', true);
              return;
            }
            rest().then(function () { step(i + 1); });
          });
        })(0);
      });
    return;
  }

  // ── 실행 ─────────────────────────────────────────────────────────────
  // ranges 가 있으면 여러 기간을 차례로 처리한다. 한 기간이 실패하면 거기서 멈춘다
  // (뒤에 것을 계속 넣어 어디까지 됐는지 모르게 만들지 않는다).
  var BASE_RANGES = opt.ranges && opt.ranges.length ? opt.ranges
                  : (DATE_FROM && DATE_TO ? [[DATE_FROM, DATE_TO]] : null);
  // 날짜 축마다 같은 기간을 한 번씩 돈다. 같은 주문이 두 축에 다 잡혀도
  // (channel, 주문번호) 로 중복이 막혀 있어 안전하다.
  var RANGES = BASE_RANGES && [].concat.apply([], DAYTYPES.map(function (dt) {
    return BASE_RANGES.map(function (r) { return [r[0], r[1], dt]; });
  }));
  if (!RANGES) {
    finish('error', '조회 기간이 없습니다');
    done('조회 기간을 정해주세요.', true);
    return;
  }

  window.__bjLog = [];
  (function next(i) {
    if (i >= RANGES.length) {
      finish('ok', '전체 완료', { log: window.__bjLog });
      done('전체 완료 · ' + RANGES.length + '개 기간');
      return;
    }
    var r = RANGES[i];
    runRange(r[0], r[1], r[2]).then(function (res) {
      window.__bjLog.push({ from: r[0], to: r[1], daytype: r[2], ok: res.ok,
        rows: res.stat && res.stat.rowsSeen, orders: res.stat && res.stat.orders,
        saved: res.saved, reason: res.reason });
      if (!res.ok) {
        finish('error', r[0] + '~' + r[1] + ' 에서 멈춤: ' + (res.reason || ''), { log: window.__bjLog });
        done(r[0] + '~' + r[1] + ' 에서 멈췄습니다: ' + (res.reason || ''), true);
        return;
      }
      setTimeout(function () { next(i + 1); }, 1500);
    }).catch(function (e) {
      var m = String((e && e.message) || e);
      window.__bjLog.push({ from: r[0], to: r[1], ok: false, reason: m });
      if (m === 'AUTH_REQUIRED') {
        finish('error', '발주모아 로그인이 필요합니다', { log: window.__bjLog });
        done('발주모아 로그인이 풀렸습니다. 다시 로그인해주세요.', true);
      } else if (e && e.code === 'HTML_STRUCTURE_CHANGED') {
        finish('error', '화면 구조 변경: ' + m, { log: window.__bjLog });
        done('발주모아 화면 구조가 바뀌었습니다. <b>저장을 중단했습니다.</b><br>' + m, true);
      } else {
        finish('error', m, { log: window.__bjLog });
        done('읽지 못했습니다: ' + m, true);
      }
    });
  })(0);
})();
