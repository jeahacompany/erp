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

  // ⚠ 인증 헤더를 우리가 만들지 않는다. (2026-09-03)
  //
  //   예전에는 쿠키에서 csrf 토큰을 꺼내 x-xsrf-token 을 직접 만들었다.
  //   그런데 EZSTORAGE 가 방식을 바꿔 그 쿠키가 더 이상 없다.
  //   토큰 없이 보내면 서버가 401 을 주고, **그 401 을 받은 EZSTORAGE 앱이
  //   사용자를 로그아웃시켜 버린다.** (로그인할 때마다 튕기는 원인이었다)
  //
  //   그래서 이제는 **앱이 스스로 보내는 요청의 헤더를 그대로 빌려 쓴다.**
  //   토큰 값을 우리가 읽지도, 저장하지도, 만들지도 않는다.
  //   헤더를 못 구하면 **요청을 아예 보내지 않고 멈춘다.** (로그아웃시키지 않기 위해)
  var HDR = null;

  function captureHeaders(waitMs) {
    if (HDR) return Promise.resolve(HDR);
    return new Promise(function (resolve) {
      var orig = window.fetch;
      var done = false;
      function finish(h) {
        if (done) return;
        done = true;
        window.fetch = orig;
        HDR = h;
        resolve(h);
      }
      window.fetch = function (i, init) {
        try {
          var u = typeof i === 'string' ? i : (i && i.url) || '';
          if (/api\.ezstorage\.io/.test(u)) {
            var h = (init && init.headers) || (i && i.headers);
            if (h) {
              var o = {};
              if (typeof h.forEach === 'function') h.forEach(function (v, k) { o[k] = v; });
              else Object.keys(h).forEach(function (k) { o[k] = h[k]; });
              if (o['x-xsrf-token']) finish(o);
            }
          }
        } catch (e) { /* 관찰만 한다. 앱 동작을 막지 않는다 */ }
        return orig.apply(this, arguments);
      };
      // 앱이 스스로 요청을 내도록 살짝 건드린다 (화면 이동 없이)
      try { window.dispatchEvent(new Event('focus')); } catch (e) {}
      try {
        var ac = window.__APOLLO_CLIENT__;
        if (ac && typeof ac.getObservableQueries === 'function') {
          ac.getObservableQueries().forEach(function (q) {
            try { q.refetch(); } catch (e) {}
          });
        }
      } catch (e) {}
      setTimeout(function () { finish(null); }, waitMs || 15000);
    });
  }

  function gql(query, variables) {
    if (!HDR) {
      return Promise.reject(new Error('EZ_NO_HEADERS'));
    }
    var headers = { 'content-type': 'application/json' };
    Object.keys(HDR).forEach(function (k) { headers[k] = HDR[k]; });
    return fetch(API, {
      method: 'POST',
      credentials: 'include',
      headers: headers,
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

  // ── 4-2. 송장 (실제로 무엇이 나갔나) ──────────────────────────────────
  //
  // 이게 발주모아 옵션코드 ↔ 우리 SKU 를 잇는 유일한 근거다.
  //   발주모아 주문 → 송장번호 → 이 송장 → 실제 출고 SKU → products.sku
  // 발주모아는 옵션명만 알려주고 우리 SKU 를 모른다. EZ 만 실제로 나간 것을 안다.
  function fetchInvoices() {
    say('송장 읽는 중…');
    var q =
      'query CI($l:ID!,$s:ID!,$d:DateRange,$t:GetCourierInvoices_InquiryType,$skip:Int,$take:Int){' +
      ' getCourierInvoices(logisticId:$l, sellerId:$s, inquiryDate:$d, inquiryType:$t, skip:$skip, take:$take){' +
      '  totalCount' +
      '  courierInvoices{ num courierName shippingStatus invoiceStatus createdAt' +
      '   finalPackages{ amount productMatch{ productOption{ customerProductCode systemProductCode } } } } } }';
    var range = { from: iso(DAYS), to: new Date().toISOString() };
    var out = [], skip = 0, total = null;

    function loop() {
      return gql(q, {
        l: ids.logisticId, s: ids.sellerId, d: range, t: 'CREATED', skip: skip, take: 200,
      }).then(function (d) {
        var r = d.getCourierInvoices;
        if (total === null) total = r.totalCount;
        var list = r.courierInvoices || [];
        list.forEach(function (x) {
          out.push({
            invoiceNo: x.num,
            courier: x.courierName,
            shippingStatus: x.shippingStatus,
            invoiceStatus: x.invoiceStatus,
            createdAt: x.createdAt,
            items: (x.finalPackages || []).map(function (p) {
              var po = p.productMatch && p.productMatch.productOption;
              return {
                sku: po ? po.customerProductCode : null,
                sysCode: po ? po.systemProductCode : null,
                qty: p.amount,
              };
            }),
          });
        });
        skip += list.length;
        say('송장 ' + out.length + '/' + total);
        if (list.length && skip < total) return loop();
        return out;
      });
    }
    return loop();
  }

  // ── 5. 우리 ERP 창을 열어 넘긴다 ──────────────────────────────────────
  // 사람이 즐겨찾기를 눌러서 온 경우에만 쓴다.
  // 클릭이 있으므로 창을 열어도 팝업 차단에 걸리지 않는다.
  function send(payload) {
    say('ERP 창으로 보내는 중…');
    var w = window.open(ERP_URL, 'erp_ez_receiver');
    if (!w) {
      finish(false, '팝업 차단됨');
      done('팝업이 막혔습니다. 주소창 오른쪽에서 팝업을 허용한 뒤 다시 눌러주세요.', true);
      return;
    }
    var sent = false;
    var timer = null;
    function cleanup() {
      window.removeEventListener('message', onMsg);
      clearTimeout(timer);
    }

    function onMsg(e) {
      if (e.origin !== ERP_ORIGIN || !e.data) return;
      if (e.data.type === 'EZ_READY' && !sent) {
        sent = true;
        (e.source || w).postMessage({ type: 'EZ_DATA', payload: payload }, ERP_ORIGIN);
      } else if (e.data.type === 'EZ_SAVED') {
        var r = e.data.result || {};
        cleanup();
        finish(true, '저장 완료', r);
        done(
          '보냈습니다 · 재고 ' + (r.stock || 0) + '건 · 입출고 ' + (r.moves || 0) +
            '건 · 입고 ' + (r.inbound || 0) + '건'
        );
      } else if (e.data.type === 'EZ_ERROR') {
        var m = e.data.message || '알 수 없는 오류';
        cleanup();
        finish(false, 'ERP: ' + m);
        done('ERP 쪽에서 막혔습니다: ' + m, true);
      }
    }
    window.addEventListener('message', onMsg);

    timer = setTimeout(function () {
      cleanup();
      finish(false, 'ERP 가 응답하지 않음 (ERP 로그인 확인 필요)');
      done('ERP가 응답하지 않습니다. ERP에 로그인돼 있는지 확인해주세요.', true);
    }, 90000);
  }

  // ── 실행 ──────────────────────────────────────────────────────────────
  var payload = { collectedAt: new Date().toISOString(), days: DAYS };
  say('EZSTORAGE 화면이 쓰는 인증을 확인하는 중…');
  captureHeaders(15000)
    .then(function (h) {
      if (!h) {
        // 헤더를 못 구했으면 **아무 요청도 보내지 않는다.**
        // 잘못 보내면 서버가 401 을 주고 EZSTORAGE 가 사용자를 로그아웃시킨다.
        var e = new Error('EZSTORAGE 화면에서 조회를 한 번 해주세요 (인증을 확인하지 못했습니다)');
        e.code = 'EZ_NO_HEADERS';
        throw e;
      }
    })
    .then(findIds)
    .then(fetchStock)
    .then(function (r) { payload.products = r.products; payload.stock = r.stock; })
    .then(fetchMoves)
    .then(function (r) { payload.moves = r; })
    .then(fetchInbound)
    .then(function (r) { payload.inbound = r; })
    .then(fetchInvoices)
    .then(function (r) { payload.invoices = r; })
    .then(function () {
      say(
        '읽기 완료 · 상품 ' + payload.products.length + ' · 재고 ' + payload.stock.length +
          ' · 입출고 ' + payload.moves.length + ' · 입고 ' + payload.inbound.length +
          ' · 송장 ' + payload.invoices.length
      );
      window.__ezPayload = payload;
      if (window.__ezAuto) {
        // 확장프로그램이 돌린 경우엔 여기서 멈춘다.
        //
        // 왜 페이지가 직접 못 보내나:
        //  - window.open → 클릭이 없어 팝업 차단에 걸린다
        //  - 숨은 iframe → 크롬이 다른 사이트 안의 프레임에 로그인 정보를 안 준다
        //    (저장소 분리). 그래서 프레임 속 ERP 는 로그인이 풀린 상태가 된다
        //
        // 그래서 ERP 로 넘기는 일은 확장프로그램이 자기 탭을 만들어서 한다.
        finish(true, '읽기 완료 (ERP 전달은 확장프로그램이 함)');
        window.__ezLastResult.state = 'collected';
        done('읽었습니다. ERP로 넘깁니다…');
        return;
      }
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
