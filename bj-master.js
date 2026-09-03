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

  // ⚠ 로그인이 풀린 것을 "크기" 로 판단하면 안 된다.
  //   발주모아 로그인 화면은 29KB 라서 "작으면 로그인 화면" 규칙에 안 걸린다.
  //   실제로 2026-09-03 에 로그인이 풀렸는데도 "0건 수집 완료" 라고 보고했다.
  //   → **최종 주소**를 본다. /Login/ 으로 끌려갔으면 로그인이 풀린 것이다.
  function get(path) {
    return fetch(path, { credentials: 'include' }).then(function (r) {
      if (/\/Login\//i.test(r.url || '')) throw new Error('AUTH_REQUIRED');
      return r.text();
    }).then(function (h) {
      if (/id=["']?userId["']?/.test(h) && /type=["']?password/.test(h)) {
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
  // ⚠ 저장 결과를 안 보고 "몇 줄 보냈나" 만 세면, 한 줄도 안 들어갔는데 완료라고 한다.
  //   2026-09-03 에 정산 870줄이 그렇게 통째로 사라졌다 (ON CONFLICT 불일치로 전부 실패).
  //   저장이 실패하면 그 단계를 실패로 남긴다.
  function send(kind, rows) {
    return sendRaw(kind, rows).then(function (r) {
      if (!r || r.ok === false) {
        throw new Error('ERP 저장 실패: ' + ((r && r.message) || '이유 없음'));
      }
      if (r.result && r.result.error) throw new Error('ERP 저장 실패: ' + r.result.error);
      return r;
    });
  }

  function sendRaw(kind, rows) {
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
    // ⚠ 프레임(iframe)으로 하면 안 된다.
    //   크롬은 다른 사이트 안에 뜬 프레임에 **별도의 저장소**를 준다(storage partitioning).
    //   그래서 프레임 안의 ERP 는 로그인 정보를 못 보고 "불러오는 중…" 에서 멈춘다.
    //   창(window.open)은 독립된 최상위 화면이라 로그인이 그대로 보인다.
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
      // 준비 신호를 **놓칠 수도** 있다 (창이 우리보다 먼저 준비되는 경우).
      // 신호가 안 와도 그냥 보낸다. 안 그러면 아무 말 없이 몇 분을 기다린다.
      setTimeout(push, 2500);
      // 조용히 오래 기다리면 무엇이 잘못됐는지 아무도 모른다. 2분에 자르고 이유를 말한다.
      timer = setTimeout(function () {
        off();
        resolve({ ok: false, message: 'ERP 화면이 답하지 않습니다 (ERP 로그인 확인)' });
      }, 120000);
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
  //   실제 칸 배치 (2026-09-03 실측, 10칸)
  //     0 선택  1 No  2 이미지  3 [상품코드] 상품명  4 (공급사번호)공급사명
  //     5 옵션  6 배송비  7 사용여부  8 등록자  9 관리
  //   ⚠ 상품 고유번호는 화면 어디에도 글자로 없다. 관리 칸의 단추 안에 있다.
  //   ⚠ 옵션에는 **옵션코드가 없다**. 옵션명 + 값 세 개뿐이다.
  //        · 참기름 180ml 1병 (0 / 0 / 3,200)
  //      그래서 열쇠는 상품번호 + 옵션명 으로 잡는다 (121 참고).
  function grabGoods() {
    return get('/Good/goods_list?pagesize=1000').then(function (d) {
      var t = tableWith(d, ['상품코드', '공급사', '옵션명']);
      if (!t) throw new Error('상품 표를 찾지 못했습니다 (화면 구조 변경)');
      var goods = [], options = [];
      for (var i = 1; i < t.rows.length; i++) {
        var row = t.rows[i];
        var c = row.cells;
        if (!c || c.length < 8) continue;

        var nameCell = txt(c[3]);                        // "[SOFS11331662] 참담_참기름,들기름"
        var code = (nameCell.match(/\[([^\]]+)\]/) || [])[1] || null;
        var gname = nameCell.replace(/\[[^\]]*\]/, '').trim();
        if (!gname) continue;

        // 고유번호: 관리 단추 안 → 없으면 상품코드 뒤 숫자
        var gid = null;
        var btn = c[9] ? c[9].querySelector('button,a') : null;
        var oc = btn ? (btn.getAttribute('onclick') || btn.getAttribute('href') || '') : '';
        var m = String(oc).match(/(\d{5,})/);
        if (m) gid = m[1];
        if (!gid && code) { var m2 = code.match(/(\d{5,})/); if (m2) gid = m2[1]; }
        if (!gid) continue;                              // 번호 없이 담으면 다음에 중복된다

        var supCell = txt(c[4]);                         // "(42800)참담(참기름,들기름)"
        var supIdx = (supCell.match(/^\((\d+)\)/) || [])[1] || null;
        var supplier = clean(supCell.replace(/^\(\d+\)/, ''));
        var active = /사용/.test(txt(c[7])) && !/미사용|중지/.test(txt(c[7]));

        goods.push({ id: gid, code: code, name: gname,
                     supplyIdx: supIdx, supplier: supplier, active: active });

        // 옵션 줄: "· 옵션명 (판매가 / 판매사공급가 / 공급사공급가)"
        var ps = c[5] ? [].slice.call(c[5].querySelectorAll('p')) : [];
        ps.forEach(function (p) {
          var line = txt(p);
          if (line.indexOf('·') !== 0) return;           // "[과세]" 같은 머리줄은 건너뛴다
          line = line.replace(/^·\s*/, '');
          var pr = line.match(/\(([^)]*)\)\s*$/);
          var nums = pr ? pr[1].split('/').map(function (x) { return num(x); }) : [];
          var oname = (pr ? line.slice(0, pr.index) : line).trim();
          if (!oname) return;
          options.push({
            optionCode: null, goodsId: gid, goodsCode: code, name: oname,
            salePrice: nums[0] != null ? nums[0] : null,
            sellerPrice: nums[1] != null ? nums[1] : null,
            supplyPrice: nums[2] != null ? nums[2] : null,
            supplier: supplier, active: active,
          });
        });
      }
      return { goods: goods, options: options };
    });
  }
  // ── 3) 정산 ─────────────────────────────────────────────────────────
  //   ⚠ 이 표는 **머리글이 두 줄**이다 (2026-09-03 실측).
  //        1줄: 정산정보 | 건수 | 금액 | 관리      ← 묶음 제목
  //        2줄: No | 정산정보 | 공급사(정산그룹) | 정산상태 | 정산기간 | … | 총 합계
  //      첫 줄만 보고 칸을 세면 전부 어긋난다. **'정산기간' 이 있는 줄**을 머리글로 잡는다.
  //   ⚠ 그리고 모든 화면 맨 위에 "세금계산서가 발행되었습니다" 안내표가 하나 더 있다.
  function grabSettle(side, path) {
    return get(path + '?pagesize=1000').then(function (d) {
      var ts = [].slice.call(d.querySelectorAll('table'));
      var t = null, hi = -1, head = null;
      for (var k = 0; k < ts.length && !t; k++) {
        for (var j = 0; j < Math.min(3, ts[k].rows.length); j++) {
          var hh = [].map.call(ts[k].rows[j].cells, function (c) { return txt(c); });
          var line = hh.join(' ');
          // ⚠ '정산기간' 만 보면 **검색창**을 잡는다 (거기에도 그 낱말이 있다).
          //   '총 합계' 까지 있어야 진짜 목록표다.
          if (line.indexOf('정산기간') >= 0 && line.indexOf('총 합계') >= 0) {
            t = ts[k]; hi = j; head = hh; break;
          }
        }
      }
      // 표를 못 찾으면 조용히 0줄로 넘기지 않는다. 화면이 바뀐 것이므로 실패로 알린다.
      if (!t) throw new Error('정산 표를 찾지 못했습니다 (화면 구조 변경)');
      function ix(w) { for (var i = 0; i < head.length; i++) if (head[i].indexOf(w) >= 0) return i; return -1; }
      var iInfo = ix('정산정보'), iName = ix('정산그룹'), iState = ix('정산상태');
      var iPeriod = ix('정산기간'), iShip = ix('총 배송비'), iSum = ix('총 합계');
      if (iName < 0 || iSum < 0) throw new Error('정산 표의 칸 이름이 바뀌었습니다');

      var out = [];
      for (var i = hi + 1; i < t.rows.length; i++) {
        var c = t.rows[i].cells;
        if (!c || c.length <= iSum) continue;
        var partner = clean(txt(c[iName]));
        if (!partner) continue;
        // 정산 고유번호: "B_260902_260902_43629" 의 맨 뒤 숫자
        var info = iInfo >= 0 ? txt(c[iInfo]) : '';
        var bjId = (info.match(/_(\d+)\b/g) || []).pop();
        bjId = bjId ? bjId.replace('_', '') : null;
        var per = (iPeriod >= 0 ? txt(c[iPeriod]) : '').match(/20\d{2}[-.\/]\d{1,2}[-.\/]\d{1,2}/g) || [];
        // 총 합계 칸은 "합계 : 10,120 과세 : 10,120 면세 : 0" 처럼 생겼다
        var sum = txt(c[iSum]);
        var amount = num((sum.match(/합계\s*:\s*([\d,]+)/) || [])[1] || sum);
        out.push({
          side: side, bjId: bjId, partner: partner,
          settleDate: per[1] || per[0] || null,
          periodFrom: per[0] || null, periodTo: per[1] || per[0] || null,
          amount: amount,
          shipFee: iShip >= 0 ? num(txt(c[iShip])) : null,
          accState: iState >= 0
            ? ((txt(c[iState]).match(/(작업중|정산완료|정산대기|미정산|확정|대기)/) || [])[1] || null)
            : null,
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


  // ── 5) 배송비 ───────────────────────────────────────────────────────
  //   19,834줄이라 1000줄씩 나눠 읽고, 한 쪽 읽을 때마다 바로 보낸다.
  //   ⚠ 이 화면에는 **수령인**이 있다. 그 칸은 읽지 않는다.
  //   배송비가 셋(산출·수정·정산)이다. 손익에 쓸 값은 **정산 배송비**.
  function shipFeeRows(doc) {
    // ⚠ ['배송비'] 로 찾으면 **검색창**의 '배송비타입' 을 잡는다. 실제로 그랬다.
    var t = tableWith(doc, ['산출 배송비', '정산 배송비']);
    if (!t || !t.rows[0]) return null;              // 표 모양이 바뀌면 저장하지 않는다
    var head = [].map.call(t.rows[0].cells, function (c) { return txt(c); });
    function ix(want, not) {
      for (var i = 0; i < head.length; i++) {
        if (head[i].indexOf(want) >= 0 && (!not || head[i].indexOf(not) < 0)) return i;
      }
      return -1;
    }
    var iOrd = ix('주문번호'), iQty = ix('수량'), iPrice = ix('판매가');
    var iInv = ix('송장번호', '임시'), iParty = ix('판매사');
    var iCalc = ix('산출'), iFix = ix('수정'), iSettle = ix('정산');
    if (iOrd < 0 || iSettle < 0) return null;       // 최소한 이 둘은 있어야 한다
    var out = [];
    for (var i = 1; i < t.rows.length; i++) {
      var c = t.rows[i].cells;
      if (!c || c.length <= iSettle) continue;
      var ordCell = txt(c[iOrd]);
      var ordNo = (ordCell.match(/[A-Za-z0-9_-]{6,}/) || [])[0];
      if (!ordNo) continue;
      var d = ordCell.match(/(20\d{2})[.\-\/](\d{1,2})[.\-\/](\d{1,2})/);
      var party = iParty >= 0 ? txt(c[iParty]).split(/\s*[·\/|]\s*|\n/) : [];
      out.push({
        orderNo: ordNo,
        invoiceNo: iInv >= 0 ? ((txt(c[iInv]).match(/\d{8,}/) || [])[0] || null) : null,
        orderDate: d ? d[1] + '-' + ('0' + d[2]).slice(-2) + '-' + ('0' + d[3]).slice(-2) : null,
        seller: clean(party[0] || '') || null,
        supplier: clean(party[1] || '') || null,
        qty: iQty >= 0 ? num(txt(c[iQty])) : null,
        salePrice: iPrice >= 0 ? num(txt(c[iPrice])) : null,
        calcFee: iCalc >= 0 ? num(txt(c[iCalc])) : null,
        fixedFee: iFix >= 0 ? num(txt(c[iFix])) : null,
        settleFee: num(txt(c[iSettle])),
      });
    }
    return out;
  }

  function grabShipFee() {
    var MAX_PAGES = 40;                              // 19,834줄 ÷ 1000 = 20쪽. 두 배까지만.
    var seen = {}, total = 0, badShape = false;
    function page(p) {
      if (p > MAX_PAGES) return Promise.resolve();
      say(stepTag + ' 배송비 ' + p + '쪽 (' + total + '줄)…');
      return get('/Acc/deliveryPriceList?page=' + p + '&pagesize=1000').then(function (doc) {
        var rows = shipFeeRows(doc);
        if (rows === null) { badShape = true; return; }   // 표가 바뀌었다 → 멈춘다
        var fresh = rows.filter(function (r) {
          var k = r.orderNo + '|' + (r.invoiceNo || '');
          if (seen[k]) return false;
          seen[k] = 1; return true;
        });
        if (!fresh.length) return;                        // 다 봤다 → 끝
        total += fresh.length;
        return send('shipfee', fresh).then(function () {
          return rest().then(function () { return page(p + 1); });
        });
      });
    }
    return page(1).then(function () {
      if (badShape && total === 0) throw new Error('배송비 표 모양이 바뀌었습니다');
      return { rows: total, shapeChanged: badShape || undefined };
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
    ['배송비', function () {
      return grabShipFee();
    }],
  ];

  var stepTag = '';
  var log = [];
  function gotRows(g) {
    if (!g) return 0;
    return (g.sellers || 0) + (g.suppliers || 0) + (g.goods || 0) + (g.options || 0) + (g.rows || 0);
  }
  (function next(i) {
    if (i >= steps.length) {
      // ⚠ 한 줄도 못 가져왔는데 "완료" 라고 하면 안 된다.
      //   2026-09-03 에 로그인이 풀린 채로 돌아 "0건 완료" 라고 보고한 적이 있다.
      //   그건 성공이 아니라 조용한 실패다.
      var total = log.reduce(function (a, x) { return a + gotRows(x.got); }, 0);
      var failed = log.filter(function (x) { return !x.ok; }).length;
      if (total === 0) {
        finish('error', '한 줄도 가져오지 못했습니다 (로그인·화면 구조 확인)', { log: log });
        done('한 줄도 못 가져왔습니다. 발주모아 로그인을 확인해주세요.', true);
        return;
      }
      finish(failed ? 'partial' : 'ok',
             '기준정보 ' + total + '줄' + (failed ? ' · 실패 ' + failed + '개' : ''), { log: log });
      done('완료 · ' + total + '줄' + (failed ? ' (일부 실패 ' + failed + ')' : ''), !!failed);
      return;
    }
    stepTag = '[' + (i + 1) + '/' + steps.length + ']';
    say(stepTag + ' ' + steps[i][0] + ' 읽는 중…');
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
