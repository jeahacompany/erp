/* 발주모아 기준정보·정산 수집기 (읽기 전용)
 *
 * 주문은 bj-collect.js 가 가져온다. 이 파일은 **잘 안 바뀌는 것들**을 가져온다.
 *
 *   판매처   주문 화면 선택칸(sl_idx)
 *   공급사   /Setting/center       사업자번호·발주코드까지
 *   상품     /Good/goods_list
 *   옵션     상품 화면 안의 옵션 칸
 *   정산     /Acc/dist_seller_calclist · /Acc/dist_supply_calclist
 *   미수·미지급  /Acc/receivable_seller · /Acc/receivable_supply
 *   배송비   /Acc/deliveryPriceList
 *
 * 원칙
 *   · 발주모아에는 **읽기만** 한다
 *   · 원본 고유번호(sl_idx · supply_idx · 상품ID · 옵션코드)를 반드시 같이 담는다
 *   · 담당자 이름·휴대폰·계좌번호·이메일은 **읽지도 않는다**
 *   · 표 머리글이 예상과 다르면 저장하지 않고 멈춘다 (조용히 틀린 값 방지)
 *   · 페이지 사이에 쉰다 (남의 서버를 때리지 않는다)
 *
 * 확장 프로그램이 부를 때는 window.__bjBridge 로 우편함을 쓴다 (창을 열지 않는다).
 */
(function () {
  'use strict';

  var ERP_ORIGIN = 'https://jeahacompany.github.io';
  var ERP_URL = ERP_ORIGIN + '/erp/data/ez/?receive=1';
  var opt = window.__bjmOptions || {};
  var BRIDGE = !!window.__bjBridge;
  var DELAY = Number(opt.pageDelayMs) || 500;
  var JITTER = Number(opt.jitterMs) || 300;

  window.__bjmResult = { state: 'running', at: new Date().toISOString() };
  function finish(state, msg, extra) {
    window.__bjmResult = Object.assign(
      { state: state, msg: msg, at: new Date().toISOString() }, extra || {});
  }

  var box = document.createElement('div');
  box.style.cssText =
    'position:fixed;right:16px;bottom:16px;z-index:2147483647;width:340px;background:#fff;' +
    'border:1px solid #cbd5e1;border-radius:10px;padding:14px 16px;box-shadow:0 8px 24px rgba(0,0,0,.18);' +
    'font:13px/1.6 -apple-system,BlinkMacSystemFont,"Malgun Gothic",sans-serif;color:#0f172a';
  box.innerHTML = '<div style="font-weight:700;margin-bottom:6px">발주모아 기준정보 → ERP</div>' +
                  '<div id="bjm-msg">준비 중…</div>';
  document.body.appendChild(box);
  var msgEl = box.querySelector('#bjm-msg');
  function say(t) { msgEl.innerHTML = t; }
  function done(t, bad) {
    say('<span style="color:' + (bad ? '#dc2626' : '#15803d') + '">' + t + '</span>');
    if (bad) setTimeout(function () { if (box.parentNode) box.remove(); }, 20000);
  }

  function rest() {
    var ms = DELAY + Math.floor(Math.random() * (JITTER + 1));
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  var txt = function (el) { return el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : ''; };
  function num(s) {
    var m = String(s == null ? '' : s).replace(/[^0-9.-]/g, '');
    return m === '' || m === '-' ? null : Number(m);
  }
  // 이름 뒤에 붙은 담당자 전화번호는 여기서 떼어낸다 (담지 않는다)
  function clean(s) {
    return String(s || '')
      .replace(/\([\s]*0[0-9]{1,2}[0-9 .-]{6,}\)/g, '')
      .replace(/0[0-9]{1,2}[-. ][0-9]{3,4}[-. ][0-9]{4}/g, '')
      .replace(/\s+/g, ' ').trim();
  }

  function get(path) {
    return fetch(path, { credentials: 'include' }).then(function (r) { return r.text(); })
      .then(function (h) {
        if (/name=["']?(userId|password)/.test(h) && h.length < 40000) {
          throw new Error('AUTH_REQUIRED');
        }
        return new DOMParser().parseFromString(h, 'text/html');
      });
  }

  // 머리글에 이 낱말이 있는 표를 고른다. 크기로 고르면 엉뚱한 걸 잡는다.
  function tableWith(doc, words) {
    var ts = [].slice.call(doc.querySelectorAll('table'));
    for (var i = 0; i < ts.length; i++) {
      var r0 = ts[i].rows[0];
      if (!r0) continue;
      var head = [].map.call(r0.cells, function (c) { return txt(c); }).join(' ');
      var all = true;
      for (var j = 0; j < words.length; j++) if (head.indexOf(words[j]) < 0) all = false;
      if (all) return ts[i];
    }
    return null;
  }

  // ── ERP 로 보내기 ────────────────────────────────────────────────────
  var seq = 0;
  function send(kind, rows) {
    if (!rows.length) return Promise.resolve({ ok: true, skipped: true });
    var msg = { type: 'BJM_DATA', kind: kind, rows: rows };
    if (BRIDGE) {
      return new Promise(function (resolve) {
        var id = ++seq;
        window.__bjMsgIn = null;
        window.__bjMsgOut = { id: id, msg: msg };
        var t0 = Date.now();
        var timer = setInterval(function () {
          var got = window.__bjMsgIn;
          if (got && got.id === id) {
            clearInterval(timer); window.__bjMsgIn = null;
            var d = got.reply || {};
            resolve(d.type === 'BJM_SAVED' ? { ok: true, result: d.result }
                                           : { ok: false, message: d.message });
          } else if (Date.now() - t0 > 300000) {
            clearInterval(timer); window.__bjMsgOut = null;
            resolve({ ok: false, message: 'ERP가 응답하지 않습니다' });
          }
        }, 300);
      });
    }
    return new Promise(function (resolve) {
      var reuse = window.__bjWin && !window.__bjWin.closed;
      var w = reuse ? window.__bjWin : window.open(ERP_URL, 'erp_bj_receiver');
      if (!w) return resolve({ ok: false, message: '팝업이 막혔습니다' });
      window.__bjWin = w;
      var sent = false, timer = null;
      function push() { if (!sent) { sent = true; w.postMessage(msg, ERP_ORIGIN); } }
      function off() { window.removeEventListener('message', onMsg); clearTimeout(timer); }
      function onMsg(e) {
        if (e.origin !== ERP_ORIGIN || !e.data) return;
        if (e.data.type === 'EZ_READY') return push();
        if (e.data.type === 'BJM_SAVED') { off(); resolve({ ok: true, result: e.data.result }); }
        else if (e.data.type === 'BJM_ERROR') { off(); resolve({ ok: false, message: e.data.message }); }
      }
      window.addEventListener('message', onMsg);
      if (reuse) setTimeout(push, 300);
      timer = setTimeout(function () { off(); resolve({ ok: false, message: 'ERP 응답 없음' }); }, 300000);
    });
  }

  // ── 1) 판매처 · 공급사 (선택칸에서) ─────────────────────────────────
  function grabParties() {
    return get('/Dist/supplyList').then(function (d) {
      function opts(name) {
        var sel = d.querySelector('select[name=' + name + ']') || d.querySelector('#' + name);
        if (!sel) return [];
        return [].slice.call(sel.options)
          .filter(function (o) { return o.value && o.value !== '0'; })
          .map(function (o) { return { id: o.value, name: clean(o.textContent) }; })
          .filter(function (x) { return x.name; });
      }
      return { sellers: opts('sl_idx'), suppliers: opts('s_idx') };
    });
  }

  // ── 2) 상품 · 옵션 ──────────────────────────────────────────────────
  function grabGoods() {
    return get('/Good/goods_list?pagesize=1000').then(function (d) {
      var t = tableWith(d, ['상품명', '공급사']);
      if (!t) throw new Error('상품 표를 찾지 못했습니다 (화면 구조 변경)');
      var goods = [], options = [];
      for (var i = 1; i < t.rows.length; i++) {
        var c = t.rows[i].cells;
        if (!c || c.length < 5) continue;
        // 상품 고유번호는 행 안의 입력칸/링크에서 찾는다
        var idEl = t.rows[i].querySelector('[name^="g_idx"],[value][name*="idx"],a[href*="idx="]');
        var gid = null;
        if (idEl) {
          var v = idEl.getAttribute('value') || idEl.getAttribute('href') || '';
          var m = String(v).match(/(\d{4,})/);
          if (m) gid = m[1];
        }
        var nameCell = txt(c[2]);
        var code = (nameCell.match(/\(([^)]+)\)/) || [])[1] || null;
        var gname = nameCell.replace(/\([^)]*\)/, '').trim();
        var supplier = clean(txt(c[3]));
        if (!gname) continue;
        if (gid) goods.push({ id: gid, code: code, name: gname, supplier: supplier, active: null });

        // 옵션 칸: "옵션명 (판매가 / 판매사공급가 / 공급사공급가)" 가 줄마다 들어 있다
        var optLines = (c[4] ? (c[4].innerHTML || '') : '')
          .replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '\n')
          .split('\n').map(function (x) { return x.replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim(); })
          .filter(Boolean);
        optLines.forEach(function (line) {
          var oc = (line.match(/\b(\d{6,})\b/) || [])[1];
          var prices = (line.match(/[\d,]+/g) || []).map(function (x) { return num(x); });
          if (!oc) return;
          options.push({
            optionCode: oc, goodsId: gid, goodsCode: code,
            name: line.replace(/\b\d{6,}\b/, '').trim() || null,
            salePrice: prices[1] != null ? prices[1] : null,
            sellerPrice: prices[2] != null ? prices[2] : null,
            supplyPrice: prices[3] != null ? prices[3] : null,
            supplier: supplier, active: null,
          });
        });
      }
      return { goods: goods, options: options };
    });
  }

  // ── 3) 정산 ─────────────────────────────────────────────────────────
  function grabSettle(side, path) {
    return get(path + '?pagesize=1000').then(function (d) {
      var t = tableWith(d, ['정산']);
      if (!t) return [];
      var out = [];
      for (var i = 1; i < t.rows.length; i++) {
        var c = t.rows[i].cells;
        if (!c || c.length < 3) continue;
        var info = txt(c[0]);
        if (!info) continue;
        var dt = (info.match(/(20\d{2})[.\-\/](\d{1,2})[.\-\/](\d{1,2})/) || []);
        out.push({
          side: side,
          partner: clean((info.split(/\s{2,}|\|/)[0] || info).slice(0, 60)),
          settleDate: dt.length ? dt[1] + '-' + ('0' + dt[2]).slice(-2) + '-' + ('0' + dt[3]).slice(-2) : null,
          cnt: num(txt(c[1])), amount: num(txt(c[2])),
          accState: (info.match(/(정산완료|정산대기|미정산|완료|대기)/) || [])[1] || null,
        });
      }
      return out;
    });
  }

  // ── 4) 미수금 · 미지급금 ────────────────────────────────────────────
  //   ⚠ 이 화면에는 계좌번호·담당자·이메일이 있다. **읽지 않는다.**
  //      업체명 · 최종기준일 · 정산금액 · 지급(입금)금액 · 잔액만 가져온다.
  function grabBalance(side, path) {
    return get(path).then(function (d) {
      var t = tableWith(d, ['최종기준일']);
      if (!t) return [];
      var head = [].map.call(t.rows[0].cells, function (c) { return txt(c); });
      var iName = head.findIndex(function (h) { return /명$/.test(h) || /업체|판매사|공급사/.test(h); });
      var iLast = head.findIndex(function (h) { return h.indexOf('최종기준일') >= 0; });
      var out = [];
      for (var i = 1; i < t.rows.length; i++) {
        var c = t.rows[i].cells;
        if (!c || c.length <= iLast + 3) continue;
        var nm = clean(txt(c[iName < 0 ? 1 : iName]));
        if (!nm) continue;
        out.push({
          side: side, partner: nm,
          lastDate: (txt(c[iLast]).match(/20\d{2}[-.\/]\d{1,2}[-.\/]\d{1,2}/) || [null])[0],
          settled: num(txt(c[iLast + 1])),
          paid: num(txt(c[iLast + 2])),
          balance: num(txt(c[iLast + 3])),
        });
      }
      return out;
    });
  }

  // ── 실행 ────────────────────────────────────────────────────────────
  var steps = [
    ['판매처·공급사', function () {
      return grabParties().then(function (p) {
        return send('sellers', p.sellers).then(function () {
          return { sellers: p.sellers.length, suppliers: p.suppliers.length, parties: p };
        });
      });
    }],
    ['상품·옵션', function () {
      return grabGoods().then(function (g) {
        return send('goods', g.goods)
          .then(function () { return send('options', g.options); })
          .then(function () { return { goods: g.goods.length, options: g.options.length }; });
      });
    }],
    ['판매사 정산', function () {
      return grabSettle('seller', '/Acc/dist_seller_calclist')
        .then(function (r) { return send('settlement', r).then(function () { return { rows: r.length }; }); });
    }],
    ['공급사 정산', function () {
      return grabSettle('supply', '/Acc/dist_supply_calclist')
        .then(function (r) { return send('settlement', r).then(function () { return { rows: r.length }; }); });
    }],
    ['미수금', function () {
      return grabBalance('seller', '/Acc/receivable_seller')
        .then(function (r) { return send('balance', r).then(function () { return { rows: r.length }; }); });
    }],
    ['미지급금', function () {
      return grabBalance('supply', '/Acc/receivable_supply')
        .then(function (r) { return send('balance', r).then(function () { return { rows: r.length }; }); });
    }],
  ];

  var log = [];
  (function next(i) {
    if (i >= steps.length) {
      finish('ok', '기준정보 수집 완료', { log: log });
      done('완료 · ' + log.map(function (x) { return x.name; }).join(' · '));
      return;
    }
    say('[' + (i + 1) + '/' + steps.length + '] ' + steps[i][0] + ' 읽는 중…');
    steps[i][1]().then(function (r) {
      log.push({ name: steps[i][0], ok: true, got: r });
      rest().then(function () { next(i + 1); });
    }).catch(function (e) {
      var m = String((e && e.message) || e);
      log.push({ name: steps[i][0], ok: false, reason: m });
      if (m === 'AUTH_REQUIRED') {
        finish('error', '발주모아 로그인이 필요합니다', { log: log });
        done('발주모아 로그인이 풀렸습니다.', true);
        return;
      }
      // 한 가지가 실패해도 나머지는 계속한다 (전부 못 가져오는 것보다 낫다)
      rest().then(function () { next(i + 1); });
    });
  })(0);
})();
