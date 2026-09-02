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

  // ⚠ 한 발주모아 계정을 푸드시그널과 도반글로벌이 같이 쓴다 (사용료가 비싸서).
  //   그래서 판매사 이름만 보고 나누면 안 된다. 공급사를 같이 봐야 한다.
  //
  //   판매사 집먹·푸드            → 푸드시그널 일반 매출
  //   판매사 도반·위탁 + 공급사 도반- → 도반 내부 거래. 푸드와 무관 (안 가져온다)
  //   판매사 도반·위탁 + 공급사 도반- 아님 → 푸드가 물건을 댄 것.
  //                                  도반이 푸드에 갚아야 할 돈 = 공급가 → 미수금
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
    if (isDobanSp) return null;                 // 도반↔도반 = 우리와 무관
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

  function url(page, from, to) {
    var q = ['search=mo_allname', 'keyword=', 'daytype=' + DAYTYPE,
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
  function fetchPage(page, from, to) {
    return fetch(url(page, from, to), { credentials: 'include' })
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
        // 결제금액은 "줄별 실제 결제액"이다. 그래서 합친다.
        // (2026-08-20~22 실측: 다품목 주문 362건 중 결제금액이 같은 건 2건뿐이고,
        //  그 2건도 소비자가 대비 합산이 맞았다. 주문 전체금액 반복이 아니다)
        o.raw.amounts.payRule = 'SUM_OF_LINES';
        o.raw.amounts.payLines = pays;
        o.payAmount = pays.reduce(function (a, b) { return a + b; }, 0);
        // 배송비는 고객이 낸 것만 (배송비 칸의 "결제"가 0보다 큰 줄)
        o.shipFee = fees.reduce(function (a, b) { return a + b; }, 0);
        delete o.raw.amounts.pay; delete o.raw.shipFees.pay;
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
  function runRange(from, to) {
    window.__bjCurFrom = from; window.__bjCurTo = to;
    var all = [], total = null;
    function loop(page) {
      say(from + '~' + to + ' 읽는 중… ' + page + '쪽 (' + all.length + '줄)');
      return fetchPage(page, from, to).then(function (res) {
        if (total == null) total = res.total;
        all = all.concat(res.rows);
        if (res.rows.length >= PAGE_SIZE && page < MAX_PAGES) return loop(page + 1);
        return null;
      });
    }
    return loop(1).then(function () {
      var payloads = build(all);
      var stat = {
        rowsSeen: all.length, totalReported: total,
        orders: payloads.reduce(function (a, p) { return a + p.rows.length; }, 0),
        channels: payloads.map(function (p) { return p.channel + ':' + p.rows.length; }),
        receivableOrders: payloads.reduce(function (a, p) {
          return a + p.rows.filter(function (o) { return o.raw.settleType === 'doban_receivable'; }).length;
        }, 0),
        from: from, to: to, daytype: DAYTYPE, brand: BRAND,
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

  // ── 실행 ─────────────────────────────────────────────────────────────
  // ranges 가 있으면 여러 기간을 차례로 처리한다. 한 기간이 실패하면 거기서 멈춘다
  // (뒤에 것을 계속 넣어 어디까지 됐는지 모르게 만들지 않는다).
  var RANGES = opt.ranges && opt.ranges.length ? opt.ranges
             : (DATE_FROM && DATE_TO ? [[DATE_FROM, DATE_TO]] : null);
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
    runRange(r[0], r[1]).then(function (res) {
      window.__bjLog.push({ from: r[0], to: r[1], ok: res.ok,
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
