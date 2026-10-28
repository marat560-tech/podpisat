/* подписатьэцп.рф — ЕГАИС: входящие накладные, приёмка и отказ, запросы в ЕГАИС.
 * Читает из УТМ: список /opt/out, документы WayBill_v4 (ТТН), FORM2REGINFO (справка о регистрации
 * ТТН в ЕГАИС, там WBRegId) и Ticket (квитанции). Отправляет только по кнопке и после подтверждения; из УТМ ничего не удаляет.
 * Разбор XML — по локальным именам элементов, без привязки к префиксам пространств имён.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var PARALLEL = 6;
  var SEND_TIMEOUT = window.EGAIS_SEND_TIMEOUT || 180000;   // переопределяется только в тестах
  var SENDING = 'УТМ подписывает документ и передаёт его в ЕГАИС — это может занять до минуты. Не закрывайте страницу и не нажимайте повторно.';
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
      transportId: ktext(t, 'TransportId'),
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
    // УТМ подписывает документ ключом и передаёт в ЕГАИС до ответа — это может занять минуту и больше.
    var opts = Object.assign({ method: 'POST', body: fd, timeout: SEND_TIMEOUT }, Utm.fetchOpts(st.origin));
    return Utm.fetch(st.origin + '/opt/in/' + type, opts).catch(function (e) {
      // Не дождались ответа: документ мог уйти. Повторять нельзя — для акта это был бы второй акт.
      if (e && e.name === 'AbortError') { var u = new Error('УТМ не ответил за ' + SEND_TIMEOUT / 60000 + ' мин'); u.uncertain = true; throw u; }
      throw new Error('не удалось связаться с УТМ (' + ((e && e.message) || e) + ')');
    }).then(function (r) {
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
  function sameId(a, b) { return !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase(); }

  // Время из документов ЕГАИС: «2026-10-27T20:47:12.123» — без часового пояса, читаем как местное
  function when(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(String(s || ''));
    if (!m) return null;
    return { t: new Date(+m[1], m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)).getTime(), exact: !!m[4] };
  }
  function whenText(w) { return w.exact ? hhmm(w.t) : fmtDate(new Date(w.t).toISOString()); }
  function rejected(t) { return /reject|отклон|отказ|ошиб|error/i.test(t.conclusion); }
  function accepted(t) { return /accept|успеш|подтвержд/i.test(t.conclusion); }
  var LIMIT_WORDS = /48|час|чаще|раз в|период|интервал|лимит|огранич|позже|некоторое время|повтор/i;

  // Понятное объяснение отказа ЕГАИС. Пусто — если добавить нечего, кроме текста самой квитанции.
  function explain(t) {
    if (!t || !rejected(t)) return '';
    var dt = t.docType || '', c = t.comment || '';
    if (/QueryNATTN/i.test(dt) && LIMIT_WORDS.test(c))
      return 'список неподтверждённых накладных ЕГАИС отдаёт не чаще раза в 48 часов. Отказ ничего не ломает и счётчик не сдвигает — просто повторите позже.';
    if (/QueryResendDoc/i.test(dt) && /повтор|некоторое время|позже/i.test(c))
      return 'это временный отказ — ЕГАИС сейчас не может переслать накладную. Повторите запрос позже, например через час.';
    if (/QueryResendDoc/i.test(dt) && /не найден/i.test(c))
      return 'ЕГАИС не нашёл эту накладную для повторной отправки.';
    if (/QueryRest/i.test(dt) && LIMIT_WORDS.test(c))
      return 'ЕГАИС ограничивает, как часто можно запрашивать остатки, и этот запрос пришёл раньше срока. Сайт остатки не запрашивает — этот запрос отправила другая программа, подключённая к УТМ.';
    if (/^Query/i.test(dt) && LIMIT_WORDS.test(c))
      return 'ЕГАИС ограничивает, как часто можно отправлять такой запрос. Повторите позже.';
    return '';
  }

  // Лимит QueryNATTN: ЕГАИС принимает его не чаще раза в 48 часов. Отклонённые попытки счётчик не сдвигают,
  // поэтому считаем от последнего принятого запроса: квитанция «принят» или сам ответ ReplyNATTN
  // (запрос могла отправить и другая программа — лимит общий на ФСРАР ID).
  var NATTN_GAP = 48 * 3600 * 1000;
  function nattnLimit() {
    var lastOk = null, lastRej = null, tickets = st.tickets || [];
    var bump = function (w) { if (w && (!lastOk || w.t > lastOk.t)) lastOk = w; };
    tickets.forEach(function (t) {
      if (!/QueryNATTN/i.test(t.docType)) return;
      var w = when(t.date);
      if (!w) return;
      if (rejected(t)) { if (!lastRej || w.t > lastRej.at.t) lastRej = { at: w, ticket: t }; }
      else if (accepted(t)) bump(w);
    });
    if (st.nattn) bump(when(st.nattn.date));
    // наш запрос, по которому ещё нет ни квитанции, ни более свежего ответа
    var mine = sentInfo('QueryNATTN'), pending = null;
    if (mine && Date.now() - mine.t < NATTN_GAP && !tickets.some(function (t) { return sameId(t.transportId, mine.id); }) &&
        (!lastOk || mine.t > lastOk.t)) pending = mine;
    var now = Date.now();
    var rej = lastRej && (!lastOk || lastRej.at.t > lastOk.t) && now - lastRej.at.t < NATTN_GAP ? lastRej : null;
    // Отказ по лимиту в момент R значит, что принятый запрос был не раньше R−48 ч, т. е. после R+48 ч точно можно
    var next = lastOk ? lastOk.t + NATTN_GAP : rej && explain(rej.ticket) ? rej.at.t + NATTN_GAP : 0;
    return { lastOk: lastOk, rej: rej, pending: pending, next: next > now ? next : 0 };
  }

  function note(kind, html) { return '<div class="note ' + kind + '" style="margin-top:12px">' + html + '</div>'; }

  // Пояснение под кнопкой «Запросить у ЕГАИС неподтверждённые»
  function nattnNote() {
    var L = nattnLimit();
    if (L.pending && (!L.rej || L.pending.t > L.rej.at.t)) {
      return note('wait', 'Запрос неподтверждённых отправлен ' + hhmm(L.pending.t) + (L.pending.uncertain ? ' (ответа УТМ не дождались)' : '') +
        ', ответа ЕГАИС пока нет. Обычно он приходит за несколько минут — нажмите «Загрузить из УТМ» ещё раз. Если ЕГАИС откажет, причина появится здесь.');
    }
    var nextTxt = L.next ? ' Следующий запрос можно после <b>' + hhmm(L.next) + '</b>.' : '';
    if (L.rej) {
      var t = L.rej.ticket, why = explain(t);
      return note(why ? 'wait' : 'err', '<b>ЕГАИС отклонил запрос ' + whenText(L.rej.at) + '</b>: ' + (why ? esc(why) : esc(t.comment || 'причина не указана')) +
        (L.lastOk ? ' Последний принятый запрос — ' + (L.lastOk.exact ? 'около ' : '') + whenText(L.lastOk) + '.' : '') + nextTxt +
        (why && t.comment ? '<div class="muted small" style="margin-top:4px">Текст ЕГАИС: ' + esc(t.comment) + '</div>' : ''));
    }
    if (L.next) {
      return note('info', 'Последний принятый запрос неподтверждённых — ' + (L.lastOk.exact ? 'около ' : '') + whenText(L.lastOk) +
        '. ЕГАИС принимает его не чаще раза в 48 часов.' + nextTxt);
    }
    return '';
  }

  // Предупреждение в окне подтверждения — не запрет: решает человек
  function nattnWarn() {
    var L = nattnLimit(), w = '';
    if (L.pending) w = 'Вы уже отправили этот запрос ' + hhmm(L.pending.t) + ', ответа ЕГАИС пока нет. Если тот запрос принят, этот ЕГАИС отклонит — лучше сначала нажать «Загрузить из УТМ».';
    else if (L.next && L.lastOk) w = 'Последний принятый запрос — ' + (L.lastOk.exact ? 'около ' : '') + whenText(L.lastOk) + '. ЕГАИС принимает его не чаще раза в 48 часов, поэтому сейчас, скорее всего, откажет. Следующий можно после ' + hhmm(L.next) + '.';
    else if (L.next) w = 'ЕГАИС уже отклонил такой запрос ' + whenText(L.rej.at) + ': с предыдущего прошло меньше 48 часов. Точно можно после ' + hhmm(L.next) + '.';
    return w ? '<div class="note wait">' + esc(w) + ' Отказ ничего не ломает и счётчик не сдвигает.</div>' : '';
  }

  // Последняя квитанция на повторный запрос этой накладной: по номеру нашего запроса или по рег. номеру
  function resendTicket(it) {
    var mine = sentInfo('resend:' + it.wbRegId);
    return (st.tickets || []).find(function (t) {
      return /QueryResendDoc/i.test(t.docType) && ((mine && sameId(t.transportId, mine.id)) || (t.regId && t.regId === it.wbRegId) ||
        (t.comment && t.comment.indexOf(it.wbRegId) >= 0));
    }) || null;
  }

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

  function busy(on) {
    st.busy = on;
    Array.prototype.forEach.call(document.querySelectorAll('#wb-nattn, [data-act], [data-resend]'), function (b) { b.disabled = on; });
  }

  function askNattn() {
    if (st.busy || st.asking) return;
    st.asking = true;
    st.origin = Utm.origin();
    // Перед вопросом освежаем квитанции из УТМ, чтобы предупреждение о лимите было по актуальным данным
    var fresh = st.loadedAt && Date.now() - st.loadedAt < 5 * 60000 ? Promise.resolve() : load().catch(function () {});
    fresh.then(ensureFsrar).then(function (id) {
      var warn = nattnWarn();
      return confirmSend('Запросить неподтверждённые накладные?',
        '<p>В ЕГАИС уйдёт запрос списка накладных, по которым ещё нет решения (документ <code>QueryNATTN</code>) от имени ФСРАР ID <b>' + esc(id) + '</b>.</p>' +
        warn +
        '<p class="muted small">Это запрос сведений: никакие накладные он не принимает и не отклоняет. Ответ придёт в УТМ обычно за несколько минут.</p>',
        warn ? 'Всё равно отправить' : 'Отправить запрос');
    }).then(function (ok) {
      st.asking = false;
      if (!ok) return;
      status('wait', 'Отправляем запрос в ЕГАИС… ' + SENDING);
      busy(true);
      return postDoc('QueryNATTN', queryXml('QueryNATTN', 'КОД', st.fsrar)).then(function (rid) {
        remember('QueryNATTN', { id: rid });
        status('ok', 'Запрос отправлен' + (rid ? ' (номер в УТМ: <code>' + esc(rid) + '</code>)' : '') + '. Через несколько минут нажмите «Загрузить из УТМ» — появится список неподтверждённых накладных или причина отказа ЕГАИС.');
        if (st.loadedAt) render();
      });
    }).catch(function (e) {
      st.asking = false;
      if (e && e.uncertain) {
        remember('QueryNATTN', { uncertain: true });
        status('wait', esc(e.message) + '. Запрос, скорее всего, ушёл. Подождите несколько минут и нажмите «Загрузить из УТМ» — если ответ не придёт, тогда запросите ещё раз.');
        if (st.loadedAt) render();
      } else status('err', 'Не удалось отправить запрос: ' + esc(e && e.message || e));
    }).then(function () { busy(false); });
  }

  function askResend(item) {
    confirmSend('Запросить накладную повторно?',
      '<p>В ЕГАИС уйдёт запрос на повторную отправку накладной в ваш УТМ (документ <code>QueryResendDoc</code>):</p>' +
      '<dl class="kv small"><dt>Накладная</dt><dd>№ ' + esc(item.number) + ' от ' + esc(fmtDate(item.date)) + '</dd>' +
      '<dt>Рег. номер</dt><dd>' + esc(item.wbRegId) + '</dd><dt>Поставщик</dt><dd>ФСРАР ID ' + esc(item.shipper) + '</dd></dl>' +
      '<p class="muted small">Это запрос сведений: накладная при этом не принимается и не отклоняется.</p>',
      'Запросить').then(function (ok) {
      if (!ok || st.busy) return;
      status('wait', 'Отправляем запрос… ' + SENDING);
      busy(true);
      return ensureFsrar().then(function () {
        return postDoc('QueryResendDoc', queryXml('QueryResendDoc', 'WBREGID', item.wbRegId));
      }).then(function (rid) {
        remember('resend:' + item.wbRegId, { id: rid });
        status('ok', 'Запрос на накладную № ' + esc(item.number) + ' отправлен. Когда она придёт в УТМ (обычно за несколько минут), нажмите «Загрузить из УТМ».');
        render();
      });
    }).catch(function (e) {
      if (e && e.uncertain) {
        remember('resend:' + item.wbRegId, { uncertain: true });
        status('wait', esc(e.message) + '. Запрос, скорее всего, ушёл — подождите несколько минут и нажмите «Загрузить из УТМ».');
        render();
      } else status('err', 'Не удалось отправить запрос: ' + esc(e && e.message || e));
    }).then(function () { busy(false); });
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
    if (!st.origin) { status('err', 'Сначала укажите адрес УТМ в проверке выше.'); return Promise.resolve(); }
    $('wb-load').disabled = true;
    status('wait', 'Читаем список документов из УТМ…');
    $('wb-list').innerHTML = '';
    return listOut().then(function (docs) {
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
      tickets.sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); });
      st.tickets = tickets;
      // самые свежие ответы
      nattn.sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); });
      rests.sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); });
      st.nattn = nattn[0] || null;
      st.rests = rests[0] || null;
      renderRests();
      st.counts = countTypes(st.docs);
      st.failed = failed;
      st.loadedAt = Date.now();
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
    if (sent) return { cls: 'wait', text: sent.uncertain ? 'Акт, возможно, отправлен' : (sent.a === 'Accepted' ? 'Принята' : 'Отказ') + ', ждём квитанцию' };
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
      if (st.busy) return;
      status('wait', 'Отправляем акт в ЕГАИС… ' + SENDING);
      busy(true);
      return ensureFsrar().then(function () {
        return postDoc('WayBillAct_v4', actXml(w, accept, note));
      }).then(function (rid) {
        remember('act:' + w.reg.wbRegId, { a: accept ? 'Accepted' : 'Rejected', id: rid });
        status('ok', 'Акт по накладной № ' + esc(w.number) + ' отправлен (' + (accept ? 'принять' : 'отказ') + '). ' +
          'Через несколько минут нажмите «Загрузить из УТМ» — придёт квитанция ЕГАИС с результатом.');
        render();
      });
    }).catch(function (e) {
      if (e && e.uncertain) {
        // Блокируем повтор: второй акт по той же накладной — хуже, чем подождать квитанцию
        remember('act:' + w.reg.wbRegId, { a: accept ? 'Accepted' : 'Rejected', uncertain: true });
        status('err', esc(e.message) + '. <b>Неизвестно, ушёл ли акт. Повторно не отправляйте.</b> Через несколько минут нажмите «Загрузить из УТМ» и посмотрите квитанцию по этой накладной.');
        render();
      } else status('err', 'Акт не отправлен: ' + esc(e && e.message || e));
    }).then(function () { busy(false); });
  }

  function render() {
    var q = ($('wb-q').value || '').toLowerCase().trim();
    var list = st.waybills.filter(function (w) {
      if (!q) return true;
      return [w.number, w.shipper.name, w.shipper.inn, w.reg && w.reg.wbRegId].join(' ').toLowerCase().indexOf(q) >= 0;
    });
    var counts = Object.keys(st.counts || {}).sort().map(function (k) { return esc(k) + ': ' + st.counts[k]; }).join(' · ');
    var html = nattnHtml() + '<p style="margin:16px 0 4px"><b>Накладные в УТМ: ' + st.waybills.length + '</b> <span class="muted small">— документы целиком, их можно открыть, принять или отказать</span></p>' +
      '<p class="small muted" style="margin:0 0 8px">' +
      'Всего документов в УТМ — ' + counts + (st.failed ? ' · не удалось прочитать: ' + st.failed : '') + '.</p>';
    if (!list.length) {
      var waiting = st.nattn && st.nattn.list.length;
      html += '<div class="note info">' + (st.waybills.length ? 'Ничего не найдено.' : waiting
        ? 'Самих накладных в УТМ пока нет. Список выше — только номера от ЕГАИС. Чтобы увидеть накладную целиком и принять или отказать, нажмите «Запросить накладную» — она придёт в УТМ через несколько минут и появится здесь.'
        : 'Накладных в УТМ нет.') + '</div>';
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
    html += ticketsHtml();
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

  // Последние квитанции ЕГАИС — в том числе ответы на наши запросы
  function ticketsHtml() {
    var list = (st.tickets || []).slice(0, 10);
    if (!list.length) return '';
    var ours = {};
    var m = sentMap();
    Object.keys(m).forEach(function (k) { var v = m[k]; if (v && v.id) ours[String(v.id).toLowerCase()] = k; });
    return '<details class="more-opts tickets" style="margin-top:14px"' + (list.some(function (t) { return ours[String(t.transportId).toLowerCase()]; }) ? ' open' : '') + '>' +
      '<summary>Последние квитанции ЕГАИС (' + list.length + ' из ' + st.tickets.length + ')</summary>' +
      '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Дата</th><th>Документ</th><th>Результат</th><th>Комментарий ЕГАИС</th></tr></thead><tbody>' +
      list.map(function (t) {
        var mine = ours[String(t.transportId).toLowerCase()];
        var ok = /accept|успеш|подтвержд/i.test(t.conclusion), bad = /reject|отклон|ошиб|error/i.test(t.conclusion);
        return '<tr' + (mine ? ' class="mine"' : '') + '><td>' + esc(fmtDate(t.date)) + ' ' + esc((t.date || '').slice(11, 16)) + '</td><td>' + esc(t.docType || '—') +
          (t.operation ? '<div class="muted small">' + esc(t.operation) + '</div>' : '') + (mine ? '<div class="small"><b>ваш запрос</b></div>' : '') + '</td>' +
          '<td>' + (t.conclusion ? '<span class="tag ' + (ok ? 'live' : bad ? 'bad' : 'soon') + '" title="' + esc(t.conclusion) + '">' + esc(ok ? 'Принят' : bad ? 'Отклонён' : t.conclusion) + '</span>' : '') + '</td>' +
          '<td class="small">' + (explain(t) ? '<div><b>' + esc(explain(t).charAt(0).toUpperCase() + explain(t).slice(1)) + '</b></div><div class="muted">Текст ЕГАИС: ' + esc(t.comment) + '</div>' : esc(t.comment)) +
          (t.regId ? '<div class="muted">' + esc(t.regId) + '</div>' : '') + '</td></tr>';
      }).join('') + '</tbody></table></div></details>';
  }

  function nattnHtml() {
    var top = nattnNote();
    if (!st.nattn) {
      return top || note('info', 'Списка неподтверждённых накладных от ЕГАИС в УТМ нет. Нажмите «Запросить у ЕГАИС неподтверждённые», чтобы получить его.');
    }
    var inUtm = {};
    (st.regs || []).forEach(function (r) { inUtm[r.wbRegId] = 1; });
    var items = st.nattn.list;
    var w = when(st.nattn.date);
    var html = top + '<div class="nattn"><p style="margin:12px 0 6px"><b>Ждут решения по данным ЕГАИС: ' + items.length + '</b> <span class="muted small">— список номеров из ЕГАИС</span>' +
      ' <span class="muted small">(ответ ЕГАИС от ' + esc(w ? whenText(w) : fmtDate(st.nattn.date)) + ')</span></p>';
    if (!items.length) return html + '<div class="note ok">Неподтверждённых накладных нет.</div></div>';
    html += '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Дата</th><th>Номер</th><th>Поставщик (ФСРАР ID)</th><th>Рег. номер</th><th></th></tr></thead><tbody>' +
      items.map(function (it, i) {
        var has = inUtm[it.wbRegId], r = has ? null : resendState(it);
        var act = has ? '<span class="tag live">есть в УТМ</span>' :
          '<button type="button" class="btn sm" data-resend="' + i + '">' + (r ? 'Запросить ещё раз' : 'Запросить накладную') + '</button>';
        return '<tr' + (r ? ' class="has-sub"' : '') + '><td>' + esc(fmtDate(it.date)) + '</td><td>' + esc(it.number) + '</td><td>' + esc(it.shipper) + '</td><td><code>' + esc(it.wbRegId) + '</code></td><td class="r">' + act + '</td></tr>' +
          (r ? '<tr class="sub"><td colspan="5"><div class="sub-note ' + r.kind + '">' + r.html + '</div></td></tr>' : '');
      }).join('') + '</tbody></table></div></div>';
    return html;
  }

  // Что с повторным запросом этой накладной: ждём ответа, ЕГАИС принял или отказал (и почему)
  function resendState(it) {
    var mine = sentInfo('resend:' + it.wbRegId), tk = resendTicket(it);
    var tkAt = tk && when(tk.date);
    // квитанция относится к последнему запросу, если это ответ именно на него или она пришла после него
    var current = tk && (!mine || sameId(tk.transportId, mine.id) || (tkAt && tkAt.t >= mine.t - 60000));
    if (current && rejected(tk)) {
      var why = explain(tk);
      return { kind: /повтор|некоторое время|позже/i.test(tk.comment) ? 'wait' : 'bad', html: '<b>ЕГАИС отказал ' + esc(tkAt ? whenText(tkAt) : '') + ':</b> ' + esc(why || tk.comment || 'причина не указана') +
        (why && tk.comment ? ' <span class="muted">Текст ЕГАИС: ' + esc(tk.comment) + '</span>' : '') };
    }
    if (current && accepted(tk)) return { kind: 'ok', html: 'ЕГАИС принял запрос ' + esc(tkAt ? whenText(tkAt) : '') + '. Накладная придёт в УТМ — нажмите «Загрузить из УТМ» через несколько минут.' };
    if (mine) return { kind: 'wait', html: 'Запрошена ' + hhmm(mine.t) + (mine.uncertain ? ' (ответа УТМ не дождались)' : '') + ', ответа ЕГАИС пока нет.' };
    return null;
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
    if (s) return '<p class="small" style="margin-top:10px">' + (s.uncertain ? 'Акт, возможно, отправлен ' : 'Акт отправлен ') + hhmm(s.t) +
      ' (' + (s.a === 'Accepted' ? 'принять' : 'отказ') + ')' + (s.uncertain ? ' — ответ УТМ не получен. Повторно не отправляйте, дождитесь квитанции ЕГАИС.' : ', ждём квитанцию ЕГАИС.') + '</p>';
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
