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
  var DAYTYPE = opt.daytype || 'order_date';
  var DRY = !!opt.dryRun;

  // ⚠ 한 발주모아 계정에 푸드시그널(집먹·푸드)과 도반글로벌(도반·위탁) 판매처가 같이 있다.
  //   우리 ERP 는 erp / doban 스키마가 완전히 분리돼 있으므로 섞어 넣으면 안 된다.
  //   기본값은 푸드시그널 것만 가져온다. 도반은 doban 쪽에서 따로 받는다.
  var BRANDS = {
    foodsignal: /^(집먹|푸드)/,
    doban: /^(도반|위탁-도반)/,
  };
  var BRAND = opt.brand || 'foodsignal';
  var KEEP = BRANDS[BRAND] || BRANDS.foodsignal;

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
    setTimeout(function () { if (box.parentNode) box.remove(); }, bad ? 15000 : 8000);
  }

  var txt = function (el) { return el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : ''; };
  var num = function (s) { var m = String(s == null ? '' : s).replace(/[^0-9.-]/g, ''); return m === '' ? null : Number(m); };
  function pick(s, re) { var m = String(s || '').match(re); return m ? m[1] : null; }

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

  function bigTable(doc) {
    var ts = [].slice.call(doc.querySelectorAll('table'));
    ts.sort(function (a, b) { return b.rows.length - a.rows.length; });
    return ts[0] || null;
  }

  function url(page) {
    var q = ['search=mo_allname', 'keyword=', 'daytype=' + DAYTYPE,
             'pagesize=' + PAGE_SIZE, 'page=' + page];
    if (DATE_FROM) q.push('date_from=' + DATE_FROM);
    if (DATE_TO) q.push('date_to=' + DATE_TO);
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
    var L4 = lines(c[4]);
    var buyerName = L4[0] || '';
    var buyerPhone = '';
    var recvName = '';
    var recvPhone = '';
    var ph = [];
    for (var i = 0; i < L4.length; i++) {
      var p = L4[i].match(/0\d{1,2}[- ]?\d{3,4}[- ]?\d{4}/);
      if (p) ph.push({ i: i, v: p[0] });
    }
    if (ph.length >= 1) { buyerPhone = ph[0].v; }
    if (ph.length >= 2) { recvPhone = ph[1].v; }
    // 이름은 전화번호 줄 바로 앞(또는 같은 줄 앞부분)
    function nameNear(k) {
      if (k == null) return '';
      var s = L4[k] || '';
      var cut = s.split(/0\d{1,2}[- ]?\d{3,4}[- ]?\d{4}/)[0].trim();
      if (cut) return cut;
      return (L4[k - 1] || '').trim();
    }
    if (ph.length >= 1) buyerName = nameNear(ph[0].i) || buyerName;
    if (ph.length >= 2) recvName = nameNear(ph[1].i);
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
  function fetchPage(page) {
    return fetch(url(page), { credentials: 'include' })
      .then(function (r) { return r.text(); })
      .then(function (html) {
        if (/name=["']?(userid|login)/i.test(html) && html.length < 5000) {
          throw new Error('AUTH_REQUIRED');
        }
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

  // ── 판매사별 · 판매처 주문번호별로 묶는다 ────────────────────────────
  // ⚠ WFS 번호는 합포장 키다. 서로 다른 판매처 주문 여러 건이 한 WFS 로 묶인다.
  //    그래서 주문 키는 반드시 "판매처 주문번호" 를 쓴다.
  function build(rows) {
    var byCh = {};
    var skipped = {};
    rows.forEach(function (r) {
      var ch = (r.channel || '미지정').trim();
      // 다른 회사(브랜드) 판매처는 아예 담지 않는다.
      if (!KEEP.test(ch)) { skipped[ch] = (skipped[ch] || 0) + 1; return; }
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
            amounts: { pay: [], consumer: 0, seller: 0, supply: 0 },
            shipFees: { pay: [], seller: 0, supply: 0 },
          },
        };
      }
      o.items.push({
        lineNo: o.items.length + 1,
        itemNo: r.optionCode || r.goodsCode || null,
        pname: r.pname, popt: r.popt,
        qty: r.qty,
        amount: r.payAmount == null ? 0 : r.payAmount,
      });
      // 금액은 줄별로 그대로 보존한다 (합산 규칙은 아래에서 판단)
      o.raw.amounts.pay.push(r.payAmount);
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
        var uniq = pays.filter(function (v, i, a) { return a.indexOf(v) === i; });
        // 줄이 여러 개인데 결제금액이 전부 같으면 "주문 전체 금액이 반복된 것"일 수 있다.
        // 확정 전까지는 합치지 않고 표시만 남긴다.
        o.raw.amounts.payRule = (pays.length > 1 && uniq.length === 1) ? 'AMBIGUOUS_IDENTICAL' : 'SUM_OF_LINES';
        o.raw.amounts.payLines = pays;
        o.payAmount = (o.raw.amounts.payRule === 'AMBIGUOUS_IDENTICAL')
          ? uniq[0] : pays.reduce(function (a, b) { return a + b; }, 0);
        o.shipFee = fees.reduce(function (a, b) { return a + b; }, 0);
        delete o.raw.amounts.pay; delete o.raw.shipFees.pay;
        return o;
      });
      out.push({ channel: ch, source: 'baljumoa',
                 filename: '발주모아 ' + (DATE_FROM || '') + '~' + (DATE_TO || ''),
                 rows: arr });
    });
    window.__bjSkipped = skipped;
    return out;
  }

  // ── ERP 로 보내기 ────────────────────────────────────────────────────
  function send(payloads, stat) {
    say('ERP 창으로 보내는 중… (' + payloads.length + '개 판매처)');
    // 여러 기간을 잇달아 넣을 때를 위해 창 이름을 매번 다르게 한다.
    // 같은 이름이면 창이 다시 뜨지 않아 "준비됐다" 신호가 안 온다.
    var w = window.open(ERP_URL, opt.winName || 'erp_bj_receiver');
    if (!w) { finish('error', '팝업 차단됨'); done('팝업이 막혔습니다. 허용 후 다시 눌러주세요.', true); return; }
    var sent = false, timer = null;
    function off() {
      window.removeEventListener('message', onMsg);
      clearTimeout(timer);
      try { if (opt.winName) w.close(); } catch { /* 이미 닫혔으면 넘어간다 */ }
    }
    function onMsg(e) {
      if (e.origin !== ERP_ORIGIN || !e.data) return;
      if (e.data.type === 'EZ_READY' && !sent) {
        sent = true;
        (e.source || w).postMessage({ type: 'BJ_DATA', payloads: payloads, stat: stat }, ERP_ORIGIN);
      } else if (e.data.type === 'BJ_SAVED') {
        off(); finish('ok', '저장 완료', { result: e.data.result, stat: stat });
        var r = e.data.result || {};
        if (typeof window.__bjNext === 'function') { try { window.__bjNext(); } catch { /* 무시 */ } }
        done('저장했습니다 · 신규 ' + (r.new || 0) + ' · 갱신 ' + (r.dup || 0) + ' · 잠김 ' + (r.locked || 0));
      } else if (e.data.type === 'EZ_ERROR' || e.data.type === 'BJ_ERROR') {
        off(); finish('error', 'ERP: ' + (e.data.message || '오류'));
        done('ERP 쪽에서 막혔습니다: ' + (e.data.message || '오류'), true);
      }
    }
    window.addEventListener('message', onMsg);
    timer = setTimeout(function () {
      off(); finish('error', 'ERP 응답 없음 (ERP 로그인 확인)');
      done('ERP가 응답하지 않습니다. ERP에 로그인돼 있는지 확인해주세요.', true);
    }, 180000);
  }

  // ── 실행 ─────────────────────────────────────────────────────────────
  if (!DATE_FROM || !DATE_TO) {
    finish('error', '조회 기간이 없습니다');
    done('조회 기간을 정해주세요.', true);
    return;
  }

  var all = [];
  var total = null;
  function loop(page) {
    say('읽는 중… ' + page + '페이지 (' + all.length + '줄)');
    return fetchPage(page).then(function (res) {
      if (total == null) total = res.total;
      all = all.concat(res.rows);
      if (res.rows.length >= PAGE_SIZE && page < MAX_PAGES) return loop(page + 1);
      return null;
    });
  }

  loop(1).then(function () {
    var payloads = build(all);
    var stat = {
      rowsSeen: all.length, totalReported: total,
      orders: payloads.reduce(function (a, p) { return a + p.rows.length; }, 0),
      channels: payloads.map(function (p) { return p.channel + ':' + p.rows.length; }),
      ambiguousAmount: payloads.reduce(function (a, p) {
        return a + p.rows.filter(function (o) { return o.raw.amounts.payRule === 'AMBIGUOUS_IDENTICAL'; }).length;
      }, 0),
      from: DATE_FROM, to: DATE_TO, daytype: DAYTYPE,
      brand: BRAND,
      skippedOtherBrand: Object.keys(window.__bjSkipped || {}).reduce(
        function (a, k) { return a + window.__bjSkipped[k]; }, 0),
      skippedChannels: Object.keys(window.__bjSkipped || {}).map(
        function (k) { return k + ':' + window.__bjSkipped[k]; }),
    };
    window.__bjStat = stat;
    if (DRY) {
      finish('preview', '미리보기 (저장 안 함)', { stat: stat });
      done('미리보기 완료 · 줄 ' + stat.rowsSeen + ' · 주문 ' + stat.orders);
      return;
    }
    say('읽기 완료 · 줄 ' + stat.rowsSeen + ' · 주문 ' + stat.orders);
    send(payloads, stat);
  }).catch(function (e) {
    var m = String((e && e.message) || e);
    if (m === 'AUTH_REQUIRED') {
      finish('error', '발주모아 로그인이 필요합니다');
      done('발주모아 로그인이 풀렸습니다. 다시 로그인해주세요.', true);
    } else if (e && e.code === 'HTML_STRUCTURE_CHANGED') {
      finish('error', '화면 구조 변경: ' + m);
      done('발주모아 화면 구조가 바뀌었습니다. <b>저장을 중단했습니다.</b><br>' + m, true);
    } else {
      finish('error', m);
      done('읽지 못했습니다: ' + m, true);
    }
  });
})();
