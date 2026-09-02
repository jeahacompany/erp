/* EZSTORAGE → 사내 ERP 수집기
 *
 * EZSTORAGE 화면에 로그인한 상태에서 북마크를 누르면 이 파일이 불려온다.
 * 하는 일은 읽기뿐이다. EZSTORAGE 에 아무것도 쓰지 않는다.
 *
 * 비밀번호·토큰을 저장하지 않는다. 로그인된 브라우저 세션을 그대로 쓴다.
 * 우리 ERP 로는 창을 하나 열어 postMessage 로 넘긴다 —
 * 그래야 우리 ERP 로그인 정보가 이 파일 안에 들어오지 않는다.
 */
(function () {
  'use strict';

  var ERP_ORIGIN = 'https://jeahacompany.github.io';
  var ERP_URL = ERP_ORIGIN + '/erp/data/ez/?receive=1';
  var API = 'https://api.ezstorage.io/';
  var DAYS = 30; // 입출고·입고를 며칠치 가져올지

  if (window.__ezCollectRunning) return;
  window.__ezCollectRunning = true;
  // 확장프로그램이 결과를 읽어갈 수 있게 남긴다.
  window.__ezLastResult = { state: 'running', at: new Date().toISOString() };
  function finish(ok, msg, counts) {
    window.__ezLastResult = {
      state: ok ? 'ok' : 'error',
      msg: msg,
      counts: counts || null,
      at: new Date().toISOString(),
    };
  }

  // ── 화면에 진행 상황을 띄운다 ──────────────────────────────────────────
  var box = document.createElement('div');
  box.style.cssText =
    'position:fixed;right:16px;bottom:16px;z-index:2147483647;width:320px;' +
    'background:#fff;border:1px solid #cbd5e1;border-radius:10px;padding:14px 16px;' +
    'box-shadow:0 8px 24px rgba(0,0,0,.18);font:13px/1.6 -apple-system,BlinkMacSystemFont,"Malgun Gothic",sans-serif;color:#0f172a';
  box.innerHTML =
    '<div style="font-weight:700;margin-bottom:6px">ERP로 보내기</div><div id="ezc-msg">준비 중…</div>';
  document.body.appendChild(box);
  var msgEl = box.querySelector('#ezc-msg');
  function say(t) { msgEl.innerHTML = t; }
  function done(t, bad) {
    say('<span style="color:' + (bad ? '#dc2626' : '#15803d') + '">' + t + '</span>');
    setTimeout(function () { box.remove(); window.__ezCollectRunning = false; }, bad ? 12000 : 6000);
  }

  function csrf() {
    var m = document.cookie.match(/production-csrfToken=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  }

  function gql(query, variables) {
    return fetch(API, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'content-type': 'application/json',
        accept: '*/*',
        'apollo-require-preflight': 'true',
        'x-xsrf-token': csrf(),
      },
      body: JSON.stringify({ query: query, variables: variables || {} }),
    })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j.errors && j.errors.length) throw new Error(j.errors[0].message);
        return j.data;
      });
  }

  // 서울 날짜 (EZSTORAGE 도 한국 기준으로 본다)
  function kstDate(d) {
    return new Date((d ? d.getTime() : Date.now()) + 9 * 3600e3).toISOString().slice(0, 10);
  }
  function iso(daysAgo) {
    return new Date(Date.now() - daysAgo * 864e5).toISOString();
  }

  var ids = {};

  // ── 1. 어느 창고·어느 판매자인지 스스로 찾는다 (하드코딩하지 않는다) ──
  function findIds() {
    say('계정 확인 중…');
    return gql('query{ logistics { id } }')
      .then(function (d) {
        if (!d.logistics || !d.logistics.length) throw new Error('창고 정보를 찾지 못했습니다');
        ids.logisticId = d.logistics[0].id;
        return gql('query S($l:ID!){ sellers(logisticId:$l){ id } }', { l: ids.logisticId });
      })
      .then(function (d) {
        if (!d.sellers || !d.sellers.length) throw new Error('판매자 정보를 찾지 못했습니다');
        ids.sellerId = d.sellers[0].id;
      });
  }

  // ── 2. 재고 (상품표도 여기서 같이 만든다) ──────────────────────────────
  // 입출고 조회에는 고객사 상품코드가 안 내려온다. 재고 조회에는 내려온다.
  // 그래서 여기서 code ↔ sku 를 이어두고, 입출고는 code 로 붙인다.
  function fetchStock() {
    say('재고 읽는 중…');
    return gql(
      'query INV($i: GetProductInventoriesInput!){ getProductInventories(input:$i){ totalCount' +
        ' productOptions { totalUsable totalBroken stockAmountStatus' +
        ' productOption { systemProductCode customerProductCode barcode levelOne levelTwo isActive' +
        ' product { name } } } } }',
      {
        i: {
          inventoryArgsWithPagination: {
            logisticId: ids.logisticId,
            sellerId: ids.sellerId,
            endDate: new Date().toISOString(),
            take: 1000,
            skip: 0,
          },
        },
      }
    ).then(function (d) {
      var snap = kstDate();
      var products = [];
      var stock = [];
      (d.getProductInventories.productOptions || []).forEach(function (o) {
        var po = o.productOption || {};
        var code = po.systemProductCode;
        if (!code) return;
        var opt = [po.levelOne, po.levelTwo].filter(Boolean).join(' / ');
        products.push({
          code: code,
          sku: po.customerProductCode || null,
          name: (po.product && po.product.name) || '',
          optionName: opt,
          barcode: po.barcode || null,
          active: po.isActive !== false,
        });
        stock.push({
          snapDate: snap,
          code: code,
          sku: po.customerProductCode || null,
          usable: o.totalUsable || 0,
          broken: o.totalBroken || 0,
          status: o.stockAmountStatus || null,
        });
      });
      return { products: products, stock: stock };
    });
  }

  // ── 3. 입출고 (상품 × 날짜 × 방향) ────────────────────────────────────
  function fetchMoves() {
    var range = { from: iso(DAYS), to: new Date().toISOString() };
    var q =
      'query IO($l:NonEmptyId!,$s:NonEmptyId!,$d:DateRange!,$t:InboundOutboundType!){' +
      ' inboundOutboundByProduct(logisticId:$l, sellerId:$s, inquiryDate:$d,' +
      ' inboundOutboundType:$t, take:1000, skip:0){ totalCount' +
      ' data { systemProductCode customerProductCode' +
      ' quantityDataByDate { date usable broken } } } }';
    var rows = [];
    function one(dir) {
      say('입출고 읽는 중… (' + (dir === 'IN' ? '입고' : '출고') + ')');
      return gql(q, { l: ids.logisticId, s: ids.sellerId, d: range, t: dir }).then(function (d) {
        (d.inboundOutboundByProduct.data || []).forEach(function (r) {
          if (!r.systemProductCode) return;
          (r.quantityDataByDate || []).forEach(function (q2) {
            if (!q2 || !q2.date) return;
            rows.push({
              moveDate: kstDate(new Date(q2.date)),
              code: r.systemProductCode,
              sku: r.customerProductCode || null,
              direction: dir,
              usable: q2.usable || 0,
              broken: q2.broken || 0,
            });
          });
        });
      });
    }
    return one('IN').then(function () { return one('OUT'); }).then(function () {
      // 같은 날·같은 상품·같은 방향이 여러 줄로 오면 합친다 (DB 기본키가 그 셋이다)
      var m = {};
      rows.forEach(function (r) {
        var k = r.moveDate + '|' + r.code + '|' + r.direction;
        if (!m[k]) m[k] = r;
        else { m[k].usable += r.usable; m[k].broken += r.broken; }
      });
      return Object.keys(m).map(function (k) { return m[k]; });
    });
  }

  // ── 4. 입고 상세 (공급사·유통기한) ────────────────────────────────────
  function fetchInbound() {
    say('입고 내역 읽는 중…');
    return gql(
      'query PS($l:ID!,$s:ID!,$d:DateRange,$t:PreStocksInquiryType){' +
        ' preStocksForConfirm(logisticId:$l, sellerId:$s, inquiryDate:$d, inquiryType:$t,' +
        ' take:1000, skip:0){ totalCount preStocks { id amount scheduledDate confirmedDate' +
        ' supplier note expiryDate canceledAt productLotNumber { lotNumber }' +
        ' productOption { systemProductCode customerProductCode } } } }',
      {
        l: ids.logisticId,
        s: ids.sellerId,
        d: { from: iso(DAYS), to: new Date().toISOString() },
        t: 'CREATED',
      }
    ).then(function (d) {
      return (d.preStocksForConfirm.preStocks || [])
        .filter(function (p) { return p.id && !p.canceledAt; })
        .map(function (p) {
          var po = p.productOption || {};
          return {
            ezId: p.id,
            code: po.systemProductCode || null,
            sku: po.customerProductCode || null,
            amount: p.amount || 0,
            scheduledDate: p.scheduledDate ? kstDate(new Date(p.scheduledDate)) : null,
            confirmedDate: p.confirmedDate ? kstDate(new Date(p.confirmedDate)) : null,
            confirmed: !!p.confirmedDate,
            supplier: p.supplier || null,
            lot: (p.productLotNumber && p.productLotNumber.lotNumber) || null,
            expiryDate: p.expiryDate ? kstDate(new Date(p.expiryDate)) : null,
            note: p.note || null,
          };
        });
    });
  }

  // ── 5. 우리 ERP 창을 열어 넘긴다 ──────────────────────────────────────
  function send(payload) {
    say('ERP 창으로 보내는 중…');
    // 확장프로그램이 돌린 경우엔 창을 자동으로 닫게 표시한다.
    var url = ERP_URL + (window.__ezAuto ? '&auto=1' : '');
    var w = window.open(url, 'erp_ez_receiver');
    if (!w) {
      finish(false, '팝업 차단됨');
      done('팝업이 막혔습니다. 주소창 오른쪽에서 팝업을 허용한 뒤 다시 눌러주세요.', true);
      return;
    }
    var sent = false;
    var timer = null;

    function onMsg(e) {
      if (e.origin !== ERP_ORIGIN || !e.data) return;
      if (e.data.type === 'EZ_READY' && !sent) {
        sent = true;
        w.postMessage({ type: 'EZ_DATA', payload: payload }, ERP_ORIGIN);
      } else if (e.data.type === 'EZ_SAVED') {
        window.removeEventListener('message', onMsg);
        clearTimeout(timer);
        var r = e.data.result || {};
        finish(true, '저장 완료', r);
        done(
          '보냈습니다 · 재고 ' + (r.stock || 0) + '건 · 입출고 ' + (r.moves || 0) +
            '건 · 입고 ' + (r.inbound || 0) + '건'
        );
      } else if (e.data.type === 'EZ_ERROR') {
        window.removeEventListener('message', onMsg);
        clearTimeout(timer);
        finish(false, 'ERP: ' + (e.data.message || '알 수 없는 오류'));
        done('ERP 쪽에서 막혔습니다: ' + (e.data.message || '알 수 없는 오류'), true);
      }
    }
    window.addEventListener('message', onMsg);

    timer = setTimeout(function () {
      window.removeEventListener('message', onMsg);
      finish(false, 'ERP 창이 응답하지 않음 (ERP 로그인 확인 필요)');
      done('ERP 창이 응답하지 않습니다. ERP에 로그인돼 있는지 확인해주세요.', true);
    }, 90000);
  }

  // ── 실행 ──────────────────────────────────────────────────────────────
  var payload = { collectedAt: new Date().toISOString(), days: DAYS };
  findIds()
    .then(fetchStock)
    .then(function (r) { payload.products = r.products; payload.stock = r.stock; })
    .then(fetchMoves)
    .then(function (r) { payload.moves = r; })
    .then(fetchInbound)
    .then(function (r) { payload.inbound = r; })
    .then(function () {
      say(
        '읽기 완료 · 상품 ' + payload.products.length + ' · 재고 ' + payload.stock.length +
          ' · 입출고 ' + payload.moves.length + ' · 입고 ' + payload.inbound.length
      );
      send(payload);
    })
    .catch(function (e) {
      var m = String((e && e.message) || e);
      if (/승인되지|Unauthorized|401/i.test(m)) {
        finish(false, 'EZSTORAGE 로그인 풀림');
        done('EZSTORAGE 로그인이 풀렸습니다. 다시 로그인한 뒤 눌러주세요.', true);
      } else {
        finish(false, m);
        done('읽지 못했습니다: ' + m, true);
      }
    });
})();
