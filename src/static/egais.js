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

  // Ответ ЕГАИС на запрос неподтверждённых накладных
  function parseNattn(doc) {
    var r = deep(doc, 'ReplyNATTN') || deep(doc, 'ReplyNoAnswerTTN');
    if (!r) return null;
    return {
      date: text(deep(r, 'ReplyDate')),
      list: deepAll(r, 'NoAnswer').map(function (n) {
        return {
          wbRegId: ktext(n, 'WbRegID') || ktext(n, 'WBRegId'),
          number: ktext(n, 'ttnNumber'),
          date: ktext(n, 'ttnDate'),
          shipper: ktext(n, 'Shipper')
        };
      })
    };
  }

  // Остатки на складе (регистр 1)
  function parseRests(doc) {
    var r = deep(doc, 'ReplyRests_v2') || deep(doc, 'ReplyRests');
    if (!r) return null;
    var groups = {}, order = [];
    deepAll(r, 'StockPosition').forEach(function (sp) {
      var prod = kid(sp, 'Product');
      var key = ktext(prod, 'AlcCode') + '|' + (ktext(prod, 'FullName') || ktext(prod, 'ShortName'));
      if (!groups[key]) {
        groups[key] = { name: ktext(prod, 'FullName') || ktext(prod, 'ShortName'), alccode: ktext(prod, 'AlcCode'),
          capacity: ktext(prod, 'Capacity'), qty: 0, regs: 0 };
        order.push(key);
      }
      groups[key].qty += num(ktext(sp, 'Quantity'));
      groups[key].regs++;
    });
    return { date: text(deep(r, 'RestsDate')), items: order.map(function (k) { return groups[k]; }) };
  }

  // ---------------------------------------------------------------- отправка запросов в ЕГАИС
  function xmlEsc(s) { return String(s).replace(/[<>&'"]/g, function (c) { return { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]; }); }

  function documentsXml(inner) {
    return '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<ns:Documents Version="1.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
      'xmlns:ns="http://fsrar.ru/WEGAIS/WB_DOC_SINGLE_01" xmlns:qp="http://fsrar.ru/WEGAIS/QueryParameters">\n' +
      '<ns:Owner><ns:FSRAR_ID>' + xmlEsc(st.fsrar) + '</ns:FSRAR_ID></ns:Owner>\n' +
      '<ns:Document>' + inner + '</ns:Document>\n</ns:Documents>\n';
  }

  function queryXml(type, name, value) {
    return documentsXml('<ns:' + type + '><qp:Parameters><qp:Parameter><qp:Name>' + xmlEsc(name) + '</qp:Name><qp:Value>' +
      xmlEsc(value) + '</qp:Value></qp:Parameter></qp:Parameters></ns:' + type + '>');
  }

  // POST /opt/in/<тип> с полем xml_file. Ответ УТМ: <A><url>идентификатор</url>…</A> или <error>
  function postDoc(type, xml) {
    var fd = new FormData();
    fd.append('xml_file', new Blob([xml], { type: 'text/xml' }), type + '.xml');
    var opts = Object.assign({ method: 'POST', body: fd }, Utm.fetchOpts(st.origin));
    return Utm.fetch(st.origin + '/opt/in/' + type, opts).then(function (r) {
      return r.text().then(function (t) {
        var err = /<error[^>]*>([\s\S]*?)<\/error>/i.exec(t);
        if (!r.ok || err) throw new Error((err ? err[1] : 'HTTP ' + r.status).replace(/<[^>]+>/g, ' ').trim().slice(0, 300));
        var id = /<url[^>]*>([^<]+)<\/url>/i.exec(t);
        return id ? id[1].trim() : '';
      });
    });
  }

  // Окно подтверждения перед любой отправкой
  function confirmSend(title, bodyHtml, okText) {
    return new Promise(function (resolve) {
      var d = document.createElement('dialog');
      d.className = 'confirm';
      d.innerHTML = '<h3>' + esc(title) + '</h3><div class="confirm-body">' + bodyHtml + '</div>' +
        '<div class="row" style="justify-content:flex-end;margin-top:16px"><button type="button" class="btn" data-a="0">Отмена</button>' +
        '<button type="button" class="btn primary" data-a="1">' + esc(okText || 'Отправить') + '</button></div>';
      document.body.appendChild(d);
      var done = function (v) { d.close(); d.remove(); resolve(v); };
      d.addEventListener('click', function (e) { var a = e.target.getAttribute && e.target.getAttribute('data-a'); if (a != null) done(a === '1'); });
      d.addEventListener('cancel', function (e) { e.preventDefault(); done(false); });
      d.showModal();
      d.querySelector('[data-a="0"]').focus();
    });
  }

  function sentMap() { try { return JSON.parse(localStorage.getItem('podp:egais:sent') || '{}'); } catch (e) { return {}; } }
  function remember(key, extra) {
    try { var m = sentMap(); m[key] = Object.assign({ t: Date.now() }, extra || {}); localStorage.setItem('podp:egais:sent', JSON.stringify(m)); } catch (e) { /* нет хранилища */ }
  }
  function sentInfo(key) { var v = sentMap()[key]; return v ? (typeof v === 'number' ? { t: v } : v) : null; }
  function sentAt(key) { var v = sentInfo(key); return v ? v.t : 0; }
  function hhmm(t) { return new Date(t).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); }

  function ensureFsrar() {
    if (st.fsrar) return Promise.resolve(st.fsrar);
    return Utm.fetch(st.origin + '/api/info/list', Utm.fetchOpts(st.origin)).then(function (r) { return r.json(); }).then(function (j) {
      var id = '';
      (function walk(o) {
        if (!o || typeof o !== 'object' || id) return;
        Object.keys(o).forEach(function (k) {
          if (id) return;
          if (/^(ownerId|fsrarId|FSRAR_ID|ClientId)$/i.test(k) && /^\d{12}$/.test(String(o[k]))) id = String(o[k]);
          else walk(o[k]);
        });
      })(j);
      if (!id) throw new Error('не удалось узнать ФСРАР ID из УТМ');
      return (st.fsrar = id);
    });
  }

  function askNattn() {
    st.origin = Utm.origin();
    ensureFsrar().then(function (id) {
      return confirmSend('Запросить неподтверждённые накладные?',
        '<p>В ЕГАИС уйдёт запрос списка накладных, по которым ещё нет решения (документ <code>QueryNATTN</code>) от имени ФСРАР ID <b>' + esc(id) + '</b>.</p>' +
        '<p class="muted small">Это запрос сведений: никакие накладные он не принимает и не отклоняет. Ответ придёт в УТМ обычно за несколько минут.</p>',
        'Отправить запрос');
    }).then(function (ok) {
      if (!ok) return;
      status('wait', 'Отправляем запрос в ЕГАИС…');
      return postDoc('QueryNATTN', queryXml('QueryNATTN', 'КОД', st.fsrar)).then(function (rid) {
        remember('QueryNATTN');
        status('ok', 'Запрос отправлен' + (rid ? ' (номер в УТМ: <code>' + esc(rid) + '</code>)' : '') + '. Через несколько минут нажмите «Загрузить из УТМ» — появится список неподтверждённых накладных.');
      });
    }).catch(function (e) {
      status('err', 'Не удалось отправить запрос: ' + esc(e && e.message || e));
    });
  }

  function askResend(item) {
    confirmSend('Запросить накладную повторно?',
      '<p>В ЕГАИС уйдёт запрос на повторную отправку накладной в ваш УТМ (документ <code>QueryResendDoc</code>):</p>' +
      '<dl class="kv small"><dt>Накладная</dt><dd>№ ' + esc(item.number) + ' от ' + esc(fmtDate(item.date)) + '</dd>' +
      '<dt>Рег. номер</dt><dd>' + esc(item.wbRegId) + '</dd><dt>Поставщик</dt><dd>ФСРАР ID ' + esc(item.shipper) + '</dd></dl>' +
      '<p class="muted small">Это запрос сведений: накладная при этом не принимается и не отклоняется.</p>',
      'Запросить').then(function (ok) {
      if (!ok) return;
      status('wait', 'Отправляем запрос…');
      return ensureFsrar().then(function () {
        return postDoc('QueryResendDoc', queryXml('QueryResendDoc', 'WBREGID', item.wbRegId));
      }).then(function () {
        remember('resend:' + item.wbRegId);
        status('ok', 'Запрос на накладную № ' + esc(item.number) + ' отправлен. Когда она придёт в УТМ (обычно за несколько минут), нажмите «Загрузить из УТМ».');
        render();
      });
    }).catch(function (e) {
      status('err', 'Не удалось отправить запрос: ' + esc(e && e.message || e));
    });
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
      var need = docs.filter(function (d) { return /^(WayBill_v4|WayBill_v3|FORM2REGINFO|Ticket|ReplyNATTN|ReplyNoAnswerTTN|ReplyRests_v2|ReplyRests)$/i.test(d.type); });
      status('wait', 'Документов в УТМ: ' + docs.length + '. Читаем накладные, справки и квитанции: 0 из ' + need.length + '…');
      return pool(need, function (d) {
        return get(d.path).then(function (xml) { d.xml = xml; d.dom = parseXml(xml); return d; });
      }, function (n, total) {
        status('wait', 'Документов в УТМ: ' + docs.length + '. Читаем накладные, справки и квитанции: ' + n + ' из ' + total + '…');
      }).then(function () { return need; });
    }).then(function (need) {
      var waybills = [], regs = [], tickets = [], nattn = [], rests = [], failed = 0;
      need.forEach(function (d) {
        if (!d.dom) { failed++; return; }
        try {
          if (/^WayBill/i.test(d.type)) { var w = parseWaybill(d.dom); if (w) { w.doc = d; waybills.push(w); } }
          else if (/^FORM2REGINFO$/i.test(d.type)) { var r = parseRegInfo(d.dom); if (r) { r.doc = d; regs.push(r); } }
          else if (/^Reply(NATTN|NoAnswerTTN)$/i.test(d.type)) { var n = parseNattn(d.dom); if (n) nattn.push(n); }
          else if (/^ReplyRests/i.test(d.type)) { var rs = parseRests(d.dom); if (rs) rests.push(rs); }
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
      st.regs = regs;
      // самые свежие ответы
      nattn.sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); });
      rests.sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); });
      st.nattn = nattn[0] || null;
      st.rests = rests[0] || null;
      renderRests();
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
    var sent = w.reg && sentInfo('act:' + w.reg.wbRegId);
    var t = w.tickets.filter(function (x) { return /act|waybill|confirm|reject/i.test(x.docType + ' ' + x.operation); });
    if (t.length) {
      var last = t[t.length - 1];
      return { cls: /reject|отказ|error|ошиб/i.test(last.conclusion + last.operation + last.comment) ? 'bad' : 'live', text: 'Есть квитанция' };
    }
    if (sent) return { cls: 'wait', text: (sent.a === 'Accepted' ? 'Принята' : 'Отказ') + ', ждём квитанцию' };
    return { cls: 'wait', text: 'Ждёт решения' };
  }

  // Решение уже есть: квитанция по акту или наш отправленный акт
  function decided(w) {
    if (!w.reg) return true;
    if (sentInfo('act:' + w.reg.wbRegId)) return true;
    return w.tickets.some(function (x) { return /act|confirm|reject/i.test(x.docType + ' ' + x.operation); });
  }

  // ---------------------------------------------------------------- акт: принять / отказать
  function actXml(w, accept, note) {
    var d = new Date(), z = function (x) { return ('0' + x).slice(-2); };
    var actDate = d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate());
    var actNumber = 'P' + String(Date.now()).slice(-9);
    var inner = '<ns:WayBillAct_v4>' +
      '<wa:Header>' +
        '<wa:IsAccept>' + (accept ? 'Accepted' : 'Rejected') + '</wa:IsAccept>' +
        '<wa:ACTNUMBER>' + actNumber + '</wa:ACTNUMBER>' +
        '<wa:ActDate>' + actDate + '</wa:ActDate>' +
        '<wa:WBRegId>' + xmlEsc(w.reg.wbRegId) + '</wa:WBRegId>' +
        '<wa:Note>' + xmlEsc(note || '') + '</wa:Note>' +
      '</wa:Header>' +
      '<wa:Content></wa:Content>' +
    '</ns:WayBillAct_v4>';
    return documentsXml(inner).replace('xmlns:qp="http://fsrar.ru/WEGAIS/QueryParameters"',
      'xmlns:wa="http://fsrar.ru/WEGAIS/ActTTNSingle_v4" xmlns:ce="http://fsrar.ru/WEGAIS/CommonV3"');
  }

  function askAct(w, accept) {
    var body = '<dl class="kv small">' +
      '<dt>Накладная</dt><dd>№ ' + esc(w.number) + ' от ' + esc(fmtDate(w.date)) + '</dd>' +
      '<dt>Поставщик</dt><dd>' + esc(w.shipper.name) + (w.shipper.inn ? ', ИНН ' + esc(w.shipper.inn) : '') + '</dd>' +
      '<dt>Сумма</dt><dd>' + money(w.total) + ' · позиций ' + w.positions.length + (w.marks ? ' · марок ' + w.marks : '') + '</dd>' +
      '<dt>Рег. номер</dt><dd>' + esc(w.reg.wbRegId) + '</dd></dl>' +
      (accept
        ? '<p>Накладная будет <b>принята полностью</b>: вся продукция поступит на ваш склад в ЕГАИС.</p>'
        : '<p>Накладная будет <b>отклонена полностью</b>: продукция вернётся поставщику в ЕГАИС.</p>' +
          '<label class="field" style="max-width:none"><span>Причина отказа</span><input type="text" id="act-note" maxlength="500" placeholder="Например: товар не поступал"></label>') +
      '<p class="muted small">Это юридически значимое действие в ЕГАИС, отменить его нельзя — только по согласованию с поставщиком.</p>';
    st.pendingNote = '';
    var dlg = confirmSend(accept ? 'Принять накладную?' : 'Отказаться от накладной?', body, accept ? 'Принять' : 'Отказать');
    if (!accept) {
      // кнопка «Отказать» активна только с причиной
      setTimeout(function () {
        var inp = document.getElementById('act-note'), ok = document.querySelector('dialog.confirm [data-a="1"]');
        if (!inp || !ok) return;
        ok.disabled = true;
        inp.addEventListener('input', function () { st.pendingNote = inp.value.trim(); ok.disabled = !st.pendingNote; });
        inp.focus();
      }, 0);
    }
    dlg.then(function (yes) {
      if (!yes) return;
      var note = accept ? '' : st.pendingNote;
      if (!accept && !note) return;
      status('wait', 'Отправляем акт в ЕГАИС…');
      return ensureFsrar().then(function () {
        return postDoc('WayBillAct_v4', actXml(w, accept, note));
      }).then(function (rid) {
        remember('act:' + w.reg.wbRegId, { a: accept ? 'Accepted' : 'Rejected', id: rid });
        status('ok', 'Акт по накладной № ' + esc(w.number) + ' отправлен (' + (accept ? 'принять' : 'отказ') + '). ' +
          'Через несколько минут нажмите «Загрузить из УТМ» — придёт квитанция ЕГАИС с результатом.');
        render();
      });
    }).catch(function (e) {
      status('err', 'Акт не отправлен: ' + esc(e && e.message || e));
    });
  }

  function render() {
    var q = ($('wb-q').value || '').toLowerCase().trim();
    var list = st.waybills.filter(function (w) {
      if (!q) return true;
      return [w.number, w.shipper.name, w.shipper.inn, w.reg && w.reg.wbRegId].join(' ').toLowerCase().indexOf(q) >= 0;
    });
    var counts = Object.keys(st.counts || {}).sort().map(function (k) { return esc(k) + ': ' + st.counts[k]; }).join(' · ');
    var html = nattnHtml() + '<p class="small muted" style="margin:10px 0">Накладных в УТМ: <b>' + st.waybills.length + '</b>' +
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
    Array.prototype.forEach.call(document.querySelectorAll('[data-act]'), function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        var w = st.waybills.find(function (x) { return x.doc.path === b.getAttribute('data-key'); });
        if (w) askAct(w, b.getAttribute('data-act') === '1');
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-resend]'), function (b) {
      b.addEventListener('click', function () { askResend(st.nattn.list[+b.getAttribute('data-resend')]); });
    });
    Array.prototype.forEach.call(document.querySelectorAll('.wb-row'), function (b) {
      b.addEventListener('click', function () {
        var key = b.parentNode.getAttribute('data-key');
        st.open[key] = !st.open[key];
        render();
      });
    });
  }

  function nattnHtml() {
    var asked = sentAt('QueryNATTN');
    if (!st.nattn) {
      return '<div class="note info" style="margin-top:12px">Списка неподтверждённых накладных от ЕГАИС в УТМ нет.' +
        (asked ? ' Запрос отправлен ' + hhmm(asked) + ' — ответ обычно приходит за несколько минут, нажмите «Загрузить из УТМ» ещё раз.' :
          ' Нажмите «Запросить у ЕГАИС неподтверждённые», чтобы получить его.') + '</div>';
    }
    var inUtm = {};
    (st.regs || []).forEach(function (r) { inUtm[r.wbRegId] = 1; });
    var items = st.nattn.list;
    var html = '<div class="nattn"><p style="margin:12px 0 6px"><b>Ждут решения по данным ЕГАИС: ' + items.length + '</b>' +
      ' <span class="muted small">(ответ ЕГАИС от ' + esc(fmtDate(st.nattn.date)) + ')</span></p>';
    if (!items.length) return html + '<div class="note ok">Неподтверждённых накладных нет.</div></div>';
    html += '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Дата</th><th>Номер</th><th>Поставщик (ФСРАР ID)</th><th>Рег. номер</th><th></th></tr></thead><tbody>' +
      items.map(function (it, i) {
        var t = sentAt('resend:' + it.wbRegId);
        var act = inUtm[it.wbRegId] ? '<span class="tag live">есть в УТМ</span>' :
          '<button type="button" class="btn sm" data-resend="' + i + '">' + (t ? 'Запросить ещё раз' : 'Запросить накладную') + '</button>' +
          (t ? '<div class="muted small">запрошена ' + hhmm(t) + '</div>' : '');
        return '<tr><td>' + esc(fmtDate(it.date)) + '</td><td>' + esc(it.number) + '</td><td>' + esc(it.shipper) + '</td><td><code>' + esc(it.wbRegId) + '</code></td><td class="r">' + act + '</td></tr>';
      }).join('') + '</tbody></table></div></div>';
    return html;
  }

  function renderRests() {
    var box = $('rests');
    if (!box) return;
    var r = st.rests;
    if (!r) { box.innerHTML = '<div class="note info">Ответа с остатками в УТМ нет.</div>'; return; }
    var total = r.items.reduce(function (s, x) { return s + x.qty; }, 0);
    box.innerHTML = '<p class="small muted" style="margin:0 0 8px">По данным ЕГАИС на ' + esc(fmtDate(r.date)) + ' · наименований: ' + r.items.length + ' · всего: ' + qty(total) + '</p>' +
      '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Продукция</th><th>Алкокод</th><th class="r">Объём, л</th><th class="r">Остаток</th></tr></thead><tbody>' +
      r.items.map(function (x) {
        return '<tr><td>' + esc(x.name) + '</td><td class="muted small">' + esc(x.alccode) + '</td><td class="r">' + esc(x.capacity) + '</td><td class="r">' + qty(x.qty) + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  function actButtons(w) {
    if (!w.reg) return '<p class="small muted" style="margin-top:10px">Принять или отказать можно после того, как в УТМ придёт справка о регистрации накладной в ЕГАИС.</p>';
    var s = sentInfo('act:' + w.reg.wbRegId);
    if (s) return '<p class="small" style="margin-top:10px">Акт отправлен ' + hhmm(s.t) + ' (' + (s.a === 'Accepted' ? 'принять' : 'отказ') + '), ждём квитанцию ЕГАИС.</p>';
    if (decided(w)) return '';
    return '<div class="row act-row"><button type="button" class="btn primary" data-act="1" data-key="' + esc(w.doc.path) + '">Принять полностью</button>' +
      '<button type="button" class="btn" data-act="0" data-key="' + esc(w.doc.path) + '">Отказать</button></div>';
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
      actButtons(w) +
      '<details class="more-opts" style="margin-top:10px"><summary>Показать XML накладной</summary><pre class="diag">' + esc(w.doc.xml.slice(0, 200000)) + '</pre></details>' +
    '</div>';
  }

  document.addEventListener('DOMContentLoaded', function () {
    $('wb-load').addEventListener('click', load);
    $('wb-nattn').addEventListener('click', askNattn);
    $('wb-q').addEventListener('input', function () { if (st.waybills.length) render(); });
  });
})();
