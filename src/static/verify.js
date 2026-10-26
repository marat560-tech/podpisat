/* подписатьэцп.рф — проверка подписи: PDF, .sig/.p7s + документ, архив .zip. Всё в браузере. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var MAX_SIZE = 100 * 1024 * 1024;
  var urls = [];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function fmtDate(d) { return d ? d.toLocaleDateString('ru-RU') : '—'; }
  function fmtDT(d) { return d ? d.toLocaleString('ru-RU') : '—'; }
  function status(kind, html) { $('status').innerHTML = html ? '<div class="note ' + kind + '">' + html + '</div>' : ''; }

  function isPdf(b) { return b.length > 5 && String.fromCharCode(b[0], b[1], b[2], b[3], b[4]) === '%PDF-'; }
  function isZip(b) { return b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 3 && b[3] === 4; }

  // CMS в DER, PEM или base64 (КриптоПро часто сохраняет .sig в base64)
  function asCms(b, name) {
    var looksSig = /\.(sig|p7s|sgn|p7m|p7b)$/i.test(name);
    if (b[0] === 0x30 && b.length > 64) {
      try {
        var n = CmsVerify.parse(b, 0);
        if (CmsVerify.oid(n.kid(0)) === '1.2.840.113549.1.7.2') return b;
      } catch (e) { /* не CMS */ }
    }
    if (!looksSig && b.length > 2 * 1024 * 1024) return null;
    var text;
    try { text = new TextDecoder('latin1').decode(b.subarray(0, Math.min(b.length, 8 * 1024 * 1024))); } catch (e) { return null; }
    var body = text.replace(/-----(BEGIN|END)[^-]*-----/g, '').replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/=]+$/.test(body) || body.length < 200) return null;
    try {
      var bin = atob(body), out = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      var n2 = CmsVerify.parse(out, 0);
      if (CmsVerify.oid(n2.kid(0)) === '1.2.840.113549.1.7.2') return out;
    } catch (e) { /* не base64 CMS */ }
    return null;
  }

  function baseNames(sigName) {
    var s = sigName.replace(/^.*\//, '');
    var noExt = s.replace(/\.(sig|p7s|sgn|p7m)$/i, '');
    var out = [noExt];
    var sbis = noExt.replace(/SGN\d*$/i, '');
    if (sbis !== noExt) out.push(sbis);
    return out;
  }

  function stem(name) { return name.replace(/^.*\//, '').replace(/\.[^.]*$/, ''); }
  function short(name) { return name.replace(/^.*\//, ''); }

  // ---------------------------------------------------------------- сбор файлов
  function expand(files) {
    var items = [];
    return Array.prototype.reduce.call(files, function (chain, f) {
      return chain.then(function () {
        if (f.size > MAX_SIZE) { items.push({ name: f.name, error: 'Файл больше 100 МБ — пропущен' }); return; }
        return f.arrayBuffer().then(function (buf) {
          var b = new Uint8Array(buf);
          if (isZip(b)) {
            return JSZip.loadAsync(b).then(function (zip) {
              var names = Object.keys(zip.files).filter(function (n) { return !zip.files[n].dir && !/^__MACOSX\//.test(n); });
              return Promise.all(names.map(function (n) {
                return zip.files[n].async('uint8array').then(function (d) { items.push({ name: n, bytes: d, from: f.name }); });
              }));
            }).catch(function () { items.push({ name: f.name, bytes: b }); });
          }
          items.push({ name: f.name, bytes: b });
        });
      });
    }, Promise.resolve()).then(function () { return items; });
  }

  function check(files) {
    $('results').innerHTML = '';
    urls.forEach(URL.revokeObjectURL); urls = [];
    status('wait', 'Проверяем…');
    expand(files).then(function (items) {
      var pdfs = [], sigs = [], data = [], errors = [];
      items.forEach(function (it) {
        if (it.error) { errors.push(it); return; }
        if (isPdf(it.bytes)) { pdfs.push(it); data.push(it); return; }
        var cms = asCms(it.bytes, it.name);
        if (cms) { it.cms = cms; sigs.push(it); } else data.push(it);
      });
      var jobs = [];
      pdfs.forEach(function (p) { jobs.push(checkPdf(p, sigs.length > 0)); });
      var used = new Set();
      sigs.forEach(function (s) {
        var bases = baseNames(s.name);
        var dir = s.name.replace(/[^/]*$/, '');
        var pair = data.find(function (d) {
          var dn = short(d.name), ddir = d.name.replace(/[^/]*$/, '');
          return ddir === dir && (bases.indexOf(dn) >= 0 || bases.indexOf(stem(d.name)) >= 0);
        }) || data.find(function (d) { return bases.indexOf(short(d.name)) >= 0 || bases.indexOf(stem(d.name)) >= 0; });
        if (pair) used.add(pair);
        s.pair = pair;
      });
      // одна подпись и один документ без пары — считаем их парой
      var freeData = data.filter(function (d) { return !used.has(d) && !isPdf(d.bytes); });
      var freeSigs = sigs.filter(function (s) { return !s.pair; });
      if (freeSigs.length === 1 && freeData.length === 1) { freeSigs[0].pair = freeData[0]; used.add(freeData[0]); }
      sigs.forEach(function (s) { jobs.push(checkSig(s)); });
      data.forEach(function (d) {
        if (!used.has(d) && !isPdf(d.bytes)) jobs.push(Promise.resolve(card('neutral', short(d.name), 'Для этого файла нет подписи', '<p class="muted">Добавьте к нему файл подписи (.sig, .p7s) — можно перетащить оба сразу.</p>')));
      });
      errors.forEach(function (e) { jobs.push(Promise.resolve(card('bad', short(e.name), e.error, ''))); });
      if (!jobs.length) { status('info', 'Не найдено ни одного файла для проверки.'); return; }
      return Promise.all(jobs).then(function (cards) {
        status();
        $('results').innerHTML = cards.join('');
      });
    }).catch(function (e) {
      status('err', 'Не удалось проверить: ' + esc(e && e.message || e));
    });
  }

  function checkPdf(it, hasOtherSigs) {
    var found = PdfInc.findSignatures(it.bytes);
    if (!found.length) {
      if (hasOtherSigs) return Promise.resolve('');
      return Promise.resolve(card('neutral', short(it.name), 'В этом PDF нет встроенной электронной подписи',
        '<p class="muted">Если подпись в отдельном файле .sig — добавьте его вместе с документом.</p>'));
    }
    var last = found.reduce(function (m, s) { return Math.max(m, s.byteRange[2] + s.byteRange[3]); }, 0);
    return Promise.all(found.map(function (s, i) {
      return CmsVerify.verify(s.cms, s.signed()).then(function (r) {
        var signer = r.signers[0] || { problems: ['В подписи нет данных о подписанте'] };
        var notes = [];
        var tail = s.byteRange[2] + s.byteRange[3];
        if (tail === it.bytes.length) notes.push('Подпись охватывает весь документ.');
        else if (tail === last || tail < it.bytes.length) notes.push('После этой подписи в документ дописаны изменения' + (found.length > 1 ? ' — например, следующие подписи' : '') + '. Подписанная версия при этом не изменилась.');
        return signerCard(short(it.name) + (found.length > 1 ? ' — подпись ' + (i + 1) + ' из ' + found.length : ''), signer, notes, s.date);
      }).catch(function (e) {
        return card('bad', short(it.name), 'Не удалось разобрать подпись', '<p>' + esc(e.message) + '</p>');
      });
    })).then(function (cs) { return cs.join(''); });
  }

  function checkSig(s) {
    return CmsVerify.verify(s.cms, s.pair ? s.pair.bytes : null).then(function (r) {
      var extra = [];
      if (r.attached) {
        extra.push('Документ находится внутри файла подписи.');
      } else if (s.pair) {
        extra.push('Документ: ' + esc(short(s.pair.name)));
      }
      var html = r.signers.map(function (sg, i) {
        return signerCard(short(s.name) + (r.signers.length > 1 ? ' — подписант ' + (i + 1) : ''), sg, extra);
      }).join('');
      if (r.attached && r.content) {
        var u = URL.createObjectURL(new Blob([r.content]));
        urls.push(u);
        html += '<div class="card"><a class="btn sm" href="' + u + '" download="' + esc(stem(s.name).replace(/SGN\d*$/i, '') || 'документ') + '">Извлечь документ из подписи</a></div>';
      }
      return html;
    }).catch(function (e) {
      var msg = /отделённая/.test(e.message)
        ? 'Подпись отделённая — добавьте сам документ, к которому она относится (можно перетащить оба файла сразу).'
        : esc(e.message);
      return card(/отделённая/.test(e.message) ? 'neutral' : 'bad', short(s.name), /отделённая/.test(e.message) ? 'Нужен подписанный документ' : 'Не удалось проверить', '<p>' + msg + '</p>');
    });
  }

  function signerCard(title, sg, notes, pdfDate) {
    var c = sg.cert, kind, head;
    if (sg.ok) { kind = 'good'; head = 'Подпись верна'; }
    else if (sg.integrity === false) { kind = 'bad'; head = 'Документ изменён после подписания'; }
    else if (sg.mathOk === false) { kind = 'bad'; head = 'Подпись недействительна'; }
    else { kind = 'bad'; head = 'Подпись не подтверждена'; }
    var rows = '';
    if (c) {
      var s = c.subject;
      var who = s.SN && s.G ? s.SN + ' ' + s.G : s.CN;
      rows += kv('Подписант', esc(who || '—'));
      if (s.O && s.O !== who) rows += kv('Организация', esc(s.O));
      if (s.T) rows += kv('Должность', esc(s.T));
      if (s.INN || s.INNLE) rows += kv('ИНН', esc([s.INNLE, s.INN].filter(Boolean).join(' / ')));
      if (s.OGRN || s.OGRNIP) rows += kv(s.OGRN ? 'ОГРН' : 'ОГРНИП', esc(s.OGRN || s.OGRNIP));
      if (s.SNILS) rows += kv('СНИЛС', esc(s.SNILS));
      rows += kv('Сертификат', '<code>' + esc(c.serial) + '</code>');
      rows += kv('Действует', 'с ' + fmtDate(c.notBefore) + ' по ' + fmtDate(c.notAfter) + (sg.certValidNow === false ? ' <span class="tag">истёк</span>' : ''));
      rows += kv('Выдан', esc(c.issuer.CN || c.issuer.O || c.issuer._text));
    }
    var when = sg.signingTime || pdfDate;
    if (when) rows += kv('Подписано', fmtDT(when));
    var checks = '';
    if (c) {
      checks += line(sg.integrity, 'Документ не изменён после подписания');
      checks += line(sg.mathOk, 'Подпись сделана ключом этого сертификата');
      checks += line(sg.certValidAtSigning, 'Сертификат действовал в момент подписания');
      if (sg.issuerChecked != null) checks += line(sg.issuerChecked, 'Сертификат подписан удостоверяющим центром из подписи');
    }
    var probs = (sg.problems || []).filter(function (p) {
      return !/хэш не совпадает|не соответствует сертификату|не действовал/.test(p) || !c;
    }).map(function (p) { return '<p class="small">' + esc(p) + '</p>'; }).join('');
    var nt = (notes || []).map(function (n) { return '<p class="small muted">' + n + '</p>'; }).join('');
    return card(kind, title, head, '<ul class="checks">' + checks + '</ul>' + probs + '<dl class="kv">' + rows + '</dl>' + nt);
  }

  function kv(k, v) { return '<dt>' + k + '</dt><dd>' + v + '</dd>'; }
  function line(ok, text) { return '<li class="' + (ok ? 'yes' : ok === false ? 'no' : 'skip') + '">' + text + '</li>'; }

  function card(kind, title, head, body) {
    var icon = kind === 'good' ? '✓' : kind === 'bad' ? '✕' : 'i';
    return '<div class="card verdict ' + kind + '"><div class="v-head"><span class="v-icon">' + icon + '</span><div><div class="v-title">' + esc(head) +
      '</div><div class="small muted">' + esc(title) + '</div></div></div>' + body + '</div>';
  }

  document.addEventListener('DOMContentLoaded', function () {
    var drop = $('drop'), input = $('file');
    input.addEventListener('change', function () { if (input.files.length) check(input.files); input.value = ''; });
    ['dragenter', 'dragover'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); });
    });
    drop.addEventListener('drop', function (e) { if (e.dataTransfer.files.length) check(e.dataTransfer.files); });
    // файлы, выбранные на главной
    Handoff.take().then(function (list) { if (list.length) check(list); });
  });
})();
