/* подписатьэцп.рф — ЕГАИС: входящие накладные (только просмотр).
 * Читает из УТМ: список /opt/out, документы WayBill_v4 (ТТН), FORM2REGINFO (справка о регистрации
 * ТТН в ЕГАИС, там WBRegId) и Ticket (квитанции). Ничего не отправляет и ничего не удаляет из УТМ.
 * Разбор XML — по локальным именам элементов, без привязки к префиксам пространств имён.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var PARALLEL = 6;
  var st = { origin: null, docs: [], waybills: [], open: {} };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  // ---------------------------------------------------------------- XML
  function kids(el, name) {
    var out = [];
    if (!el) return out;
    for (var c = el.firstElementChild; c; c = c.nextElementSibling) if (c.localName === name) out.push(c);
    return out;
  }
  function kid(el, name) { return kids(el, name)[0] || null; }
  function deep(el, name) {
    if (!el) return null;
    var all = el.getElementsByTagNameNS('*', name);
    return all.length ? all[0] : null;
  }
  function deepAll(el, name) { return el ? Array.prototype.slice.call(el.getElementsByTagNameNS('*', name)) : []; }
  function text(el) { return el ? el.textContent.trim() : ''; }
  function ktext(el, name) { return text(kid(el, name)); }

  function parseXml(s) {
    var d = new DOMParser().parseFromString(s, 'application/xml');
    if (d.getElementsByTagName('parsererror').length) throw new Error('XML не разобран');
    return d;
  }

  // Организация: Shipper/Consignee → UL | FL | FO | TS → ShortName, FullName, INN, KPP, ClientRegId
  function org(node) {
    if (!node) return {};
    var x = node.firstElementChild && /^(UL|FL|FO|TS)$/.test(node.firstElementChild.localName) ? node.firstElementChild : node;
    return {
      name: ktext(x, 'ShortName') || ktext(x, 'FullName') || text(deep(x, 'ShortName')) || text(deep(x, 'FullName')),
      inn: ktext(x, 'INN') || text(deep(x, 'INN')),
      kpp: ktext(x, 'KPP'),
      id: ktext(x, 'ClientRegId') || text(deep(x, 'ClientRegId'))
    };
  }

  function num(s) { var v = parseFloat(String(s || '').replace(',', '.')); return isNaN(v) ? 0 : v; }
  function money(v) { return v.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ₽'; }
  function qty(v) { return v.toLocaleString('ru-RU', { maximumFractionDigits: 4 }); }
  function fmtDate(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
    return m ? m[3] + '.' + m[2] + '.' + m[1] : String(s || '');
  }

  function parseWaybill(doc) {
    var wb = deep(doc, 'WayBill_v4') || deep(doc, 'WayBill_v3') || deep(doc, 'WayBill');
    if (!wb) return null;
    var h = kid(wb, 'Header'), c = kid(wb, 'Content');
    var positions = kids(c, 'Position').map(function (p) {
      var prod = kid(p, 'Product');
      var q = num(ktext(p, 'Quantity')), price = num(ktext(p, 'Price'));
      return {
        id: ktext(p, 'Identity'),
        name: ktext(prod, 'FullName') || ktext(prod, 'ShortName'),
        alccode: ktext(prod, 'AlcCode'),
        capacity: ktext(prod, 'Capacity'),
        unit: ktext(prod, 'UnitType'),
        qty: q, price: price, sum: q * price,
        marks: deepAll(p, 'amc').length
      };
    });
    return {
      identity: ktext(wb, 'Identity'),
      number: ktext(h, 'NUMBER'),
      date: ktext(h, 'Date'),
      shipDate: ktext(h, 'ShippingDate'),
      type: ktext(h, 'Type'),
      shipper: org(kid(h, 'Shipper')),
      consignee: org(kid(h, 'Consignee')),
      note: ktext(h, 'Note'),
      positions: positions,
      total: positions.reduce(function (s, p) { return s + p.sum; }, 0),
      marks: positions.reduce(function (s, p) { return s + p.marks; }, 0)
    };
  }

  function parseRegInfo(doc) {
    var h = deep(doc, 'Header');
    if (!h) return null;
    return {
      identity: ktext(h, 'Identity'),
      wbRegId: ktext(h, 'WBRegId'),
      fixNumber: ktext(h, 'EGAISFixNumber'),
      fixDate: ktext(h, 'EGAISFixDate'),
      number: ktext(h, 'WBNUMBER'),
      date: ktext(h, 'WBDate'),
      shipper: org(kid(h, 'Shipper'))
    };
  }

  function parseTicket(doc) {
    var t = deep(doc, 'Ticket');
    if (!t) return null;
    var res = kid(t, 'Result'), op = kid(t, 'OperationResult');
    return {
      regId: ktext(t, 'RegID'),
      docType: ktext(t, 'DocType'),
      date: ktext(t, 'TicketDate'),
      conclusion: ktext(res, 'Conclusion') || ktext(op, 'OperationResult'),
      operation: ktext(op, 'OperationName'),
      comment: ktext(res, 'Comments') || ktext(op, 'OperationComment')
    };
  }

  // ---------------------------------------------------------------- загрузка
  function get(path) {
    var url = st.origin + path;
    return Utm.fetch(url, Utm.fetchOpts(st.origin)).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    });
  }

  function listOut() {
    return get('/opt/out').then(function (xml) {
      var d = parseXml(xml);
      return Array.prototype.slice.call(d.getElementsByTagName('url')).map(function (u) {
        var href = u.textContent.trim(), path;
        try { path = new URL(href).pathname; } catch (e) { path = href.replace(/^https?:\/\/[^/]+/, ''); }
        var parts = path.split('/').filter(Boolean);
        return { path: path, type: parts[parts.length - 2] || '', id: parts[parts.length - 1] || '', replyId: u.getAttribute('replyId') || '' };
      });
    });
  }

  // Ограниченная параллельность, чтобы не заваливать УТМ запросами
  function pool(items, fn, onStep) {
    var i = 0, done = 0, out = new Array(items.length);
    return new Promise(function (resolve) {
      if (!items.length) { resolve(out); return; }
      function next() {
        if (i >= items.length) return;
        var k = i++;
        fn(items[k]).then(function (v) { out[k] = v; }, function (e) { out[k] = { error: e }; }).then(function () {
          done++;
          if (onStep) onStep(done, items.length);
          if (done === items.length) resolve(out); else next();
        });
      }
      for (var p = 0; p < Math.min(PARALLEL, items.length); p++) next();
    });
  }

  function load() {
    st.origin = Utm.origin();
    if (!st.origin) { status('err', 'Сначала укажите адрес УТМ в проверке выше.'); return; }
    $('wb-load').disabled = true;
    status('wait', 'Читаем список документов из УТМ…');
    $('wb-list').innerHTML = '';
    listOut().then(function (docs) {
      st.docs = docs;
      var need = docs.filter(function (d) { return /^(WayBill_v4|WayBill_v3|FORM2REGINFO|Ticket)$/i.test(d.type); });
      status('wait', 'Документов в УТМ: ' + docs.length + '. Читаем накладные, справки и квитанции: 0 из ' + need.length + '…');
      return pool(need, function (d) {
        return get(d.path).then(function (xml) { d.xml = xml; d.dom = parseXml(xml); return d; });
      }, function (n, total) {
        status('wait', 'Документов в УТМ: ' + docs.length + '. Читаем накладные, справки и квитанции: ' + n + ' из ' + total + '…');
      }).then(function () { return need; });
    }).then(function (need) {
      var waybills = [], regs = [], tickets = [], failed = 0;
      need.forEach(function (d) {
        if (!d.dom) { failed++; return; }
        try {
          if (/^WayBill/i.test(d.type)) { var w = parseWaybill(d.dom); if (w) { w.doc = d; waybills.push(w); } }
          else if (/^FORM2REGINFO$/i.test(d.type)) { var r = parseRegInfo(d.dom); if (r) { r.doc = d; regs.push(r); } }
          else { var t = parseTicket(d.dom); if (t) { t.doc = d; tickets.push(t); } }
        } catch (e) { failed++; }
      });
      // связываем накладную со справкой: по Identity, иначе по номеру+дате+отправителю
      waybills.forEach(function (w) {
        w.reg = regs.find(function (r) { return r.identity && r.identity === w.identity; }) ||
          regs.find(function (r) { return r.number === w.number && r.date === w.date && (!r.shipper.id || r.shipper.id === w.shipper.id); }) || null;
        w.tickets = w.reg ? tickets.filter(function (t) { return t.regId && t.regId === w.reg.wbRegId; }) : [];
      });
      waybills.sort(function (a, b) { return (b.date || '').localeCompare(a.date || '') || (b.number || '').localeCompare(a.number || ''); });
      st.waybills = waybills;
      st.counts = countTypes(st.docs);
      st.failed = failed;
      render();
      status();
    }).catch(function (e) {
      status('err', 'Не удалось прочитать документы из УТМ: ' + esc(e && e.message || e) + '. Сначала выполните «Проверить» выше.');
    }).finally(function () { $('wb-load').disabled = false; });
  }

  function countTypes(docs) {
    var c = {};
    docs.forEach(function (d) { c[d.type] = (c[d.type] || 0) + 1; });
    return c;
  }

  function status(kind, html) { $('wb-status').innerHTML = html ? '<div class="note ' + kind + '">' + html + '</div>' : ''; }

  // ---------------------------------------------------------------- вывод
  function stateOf(w) {
    if (!w.reg) return { cls: 'soon', text: 'Нет справки о регистрации' };
    var t = w.tickets.filter(function (x) { return /act|waybill|confirm|reject/i.test(x.docType + ' ' + x.operation); });
    if (t.length) {
      var last = t[t.length - 1];
      return { cls: /reject|отказ|error|ошиб/i.test(last.conclusion + last.operation + last.comment) ? 'bad' : 'live', text: 'Есть квитанция' };
    }
    return { cls: 'wait', text: 'Ждёт решения' };
  }

  function render() {
    var q = ($('wb-q').value || '').toLowerCase().trim();
    var list = st.waybills.filter(function (w) {
      if (!q) return true;
      return [w.number, w.shipper.name, w.shipper.inn, w.reg && w.reg.wbRegId].join(' ').toLowerCase().indexOf(q) >= 0;
    });
    var counts = Object.keys(st.counts || {}).sort().map(function (k) { return esc(k) + ': ' + st.counts[k]; }).join(' · ');
    var html = '<p class="small muted" style="margin:10px 0">Накладных: <b>' + st.waybills.length + '</b>' +
      (st.failed ? ' · не удалось прочитать: ' + st.failed : '') + '. Всего документов в УТМ — ' + counts + '.</p>';
    if (!list.length) {
      html += '<div class="note info">' + (st.waybills.length ? 'Ничего не найдено.' : 'Входящих накладных в УТМ нет.') + '</div>';
    }
    html += list.map(function (w, i) {
      var s = stateOf(w), key = w.doc.path, open = !!st.open[key];
      return '<div class="wb' + (open ? ' open' : '') + '" data-key="' + esc(key) + '">' +
        '<button type="button" class="wb-row">' +
          '<span class="wb-date">' + esc(fmtDate(w.date)) + '</span>' +
          '<span class="wb-main"><b>№ ' + esc(w.number || '—') + '</b> · ' + esc(w.shipper.name || 'Поставщик не указан') +
            (w.shipper.inn ? ' <span class="muted small">ИНН ' + esc(w.shipper.inn) + '</span>' : '') + '</span>' +
          '<span class="wb-sum">' + money(w.total) + '</span>' +
          '<span class="tag ' + s.cls + '">' + s.text + '</span>' +
        '</button>' +
        (open ? details(w) : '') +
      '</div>';
    }).join('');
    $('wb-list').innerHTML = html;
    Array.prototype.forEach.call(document.querySelectorAll('.wb-row'), function (b) {
      b.addEventListener('click', function () {
        var key = b.parentNode.getAttribute('data-key');
        st.open[key] = !st.open[key];
        render();
      });
    });
  }

  function details(w) {
    var rows = w.positions.map(function (p) {
      return '<tr><td>' + esc(p.id) + '</td><td>' + esc(p.name) + '<div class="muted small">' + esc(p.alccode) +
        (p.capacity ? ' · ' + esc(p.capacity) + ' л' : '') + '</div></td><td class="r">' + qty(p.qty) + '</td><td class="r">' +
        money(p.price) + '</td><td class="r">' + money(p.sum) + '</td><td class="r">' + (p.marks || '') + '</td></tr>';
    }).join('');
    var t = w.tickets.map(function (x) {
      return '<li>' + esc(fmtDate(x.date)) + ' — ' + esc([x.docType, x.operation, x.conclusion].filter(Boolean).join(', ')) +
        (x.comment ? '<div class="muted small">' + esc(x.comment) + '</div>' : '') + '</li>';
    }).join('');
    return '<div class="wb-body">' +
      '<dl class="kv small">' +
        '<dt>Поставщик</dt><dd>' + esc(w.shipper.name) + (w.shipper.inn ? ', ИНН ' + esc(w.shipper.inn) : '') + (w.shipper.id ? ', ФСРАР ID ' + esc(w.shipper.id) : '') + '</dd>' +
        '<dt>Получатель</dt><dd>' + esc(w.consignee.name) + (w.consignee.id ? ', ФСРАР ID ' + esc(w.consignee.id) : '') + '</dd>' +
        (w.shipDate ? '<dt>Отгружена</dt><dd>' + esc(fmtDate(w.shipDate)) + '</dd>' : '') +
        '<dt>Регистрация в ЕГАИС</dt><dd>' + (w.reg ? esc(w.reg.wbRegId) + (w.reg.fixDate ? ' от ' + esc(fmtDate(w.reg.fixDate)) : '') : 'справки нет в УТМ') + '</dd>' +
        (w.note ? '<dt>Примечание</dt><dd>' + esc(w.note) + '</dd>' : '') +
      '</dl>' +
      '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>№</th><th>Продукция</th><th class="r">Кол-во</th><th class="r">Цена</th><th class="r">Сумма</th><th class="r">Марок</th></tr></thead><tbody>' +
        rows + '</tbody><tfoot><tr><td></td><td>Итого: позиций ' + w.positions.length + '</td><td></td><td></td><td class="r"><b>' + money(w.total) + '</b></td><td class="r">' + (w.marks || '') + '</td></tr></tfoot></table></div>' +
      (t ? '<p class="small" style="margin:10px 0 4px"><b>Квитанции</b></p><ul class="small" style="margin:0;padding-left:18px">' + t + '</ul>' : '') +
      '<details class="more-opts" style="margin-top:10px"><summary>Показать XML накладной</summary><pre class="diag">' + esc(w.doc.xml.slice(0, 200000)) + '</pre></details>' +
    '</div>';
  }

  document.addEventListener('DOMContentLoaded', function () {
    $('wb-load').addEventListener('click', load);
    $('wb-q').addEventListener('input', function () { if (st.waybills.length) render(); });
  });
})();
