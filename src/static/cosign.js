/* подписатьэцп.рф — подпись вторым участником: добавить свою подпись к подписи контрагента.
 * Обе подписи — над одним документом (параллельные, detached CMS). Всё в браузере.
 * После подписания результат сразу проверяется на этой же странице: если плагин собрал
 * подпись неверно, пользователь увидит это сразу и битый файл не получит.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var esc = ESign.esc;
  var MAX_SIZE = 100 * 1024 * 1024;
  var st = { doc: null, docName: '', cms: null, baseSigners: 0 };
  var urls = [];

  function status(kind, html) { $('status').innerHTML = html ? '<div class="note ' + kind + '">' + html + '</div>' : ''; }
  function fmtDT(d) { return d ? d.toLocaleString('ru-RU') : '—'; }
  function short(n) { return String(n).replace(/^.*\//, ''); }
  function stem(n) { return short(n).replace(/\.[^.]*$/, ''); }
  function hexId(s) { return String(s || '').replace(/[^0-9a-fA-F]/g, '').toLowerCase(); }

  function isZip(b) { return b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 3 && b[3] === 4; }
  function isPdf(b) { return b.length > 5 && String.fromCharCode(b[0], b[1], b[2], b[3], b[4]) === '%PDF-'; }

  // CMS в DER или base64/PEM
  function asCms(b, name) {
    if (b[0] === 0x30 && b.length > 64) {
      try { if (CmsVerify.oid(CmsVerify.parse(b, 0).kid(0)) === '1.2.840.113549.1.7.2') return b; } catch (e) { /* не DER CMS */ }
    }
    if (!/\.(sig|p7s|sgn|p7m)$/i.test(name) && b.length > 2 * 1024 * 1024) return null;
    var text;
    try { text = new TextDecoder('latin1').decode(b.subarray(0, Math.min(b.length, 8 * 1024 * 1024))); } catch (e) { return null; }
    var body = text.replace(/-----(BEGIN|END)[^-]*-----/g, '').replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/=]+$/.test(body) || body.length < 200) return null;
    try {
      var out = ESign.b64ToBytes(body);
      if (CmsVerify.oid(CmsVerify.parse(out, 0).kid(0)) === '1.2.840.113549.1.7.2') return out;
    } catch (e) { /* не base64 CMS */ }
    return null;
  }

  function expand(files) {
    var items = [];
    return Array.prototype.reduce.call(files, function (chain, f) {
      return chain.then(function () {
        if (f.size > MAX_SIZE) return;
        return f.arrayBuffer().then(function (buf) {
          var b = new Uint8Array(buf);
          if (isZip(b)) {
            return JSZip.loadAsync(b).then(function (zip) {
              var names = Object.keys(zip.files).filter(function (n) { return !zip.files[n].dir && !/^__MACOSX\//.test(n); });
              return Promise.all(names.map(function (n) {
                return zip.files[n].async('uint8array').then(function (d) { items.push({ name: n, bytes: d }); });
              }));
            }).catch(function () { items.push({ name: f.name, bytes: b }); });
          }
          items.push({ name: f.name, bytes: b });
        });
      });
    }, Promise.resolve()).then(function () { return items; });
  }

  function baseNames(sigName) {
    var noExt = short(sigName).replace(/\.(sig|p7s|sgn|p7m)$/i, '');
    var out = [noExt];
    var sbis = noExt.replace(/SGN\d*$/i, '');
    if (sbis !== noExt) out.push(sbis);
    return out;
  }

  function reset() {
    st = { doc: null, docName: '', cms: null, baseSigners: 0 };
    $('result').hidden = true;
    updateButton();
  }

  function load(files) {
    reset();
    $('loaded').innerHTML = '<div class="note wait">Читаем файлы…</div>';
    status();
    expand(files).then(function (items) {
      var sig = null, docs = [];
      items.forEach(function (it) {
        if (isPdf(it.bytes)) { it.isPdf = true; docs.push(it); return; }
        var cms = asCms(it.bytes, it.name);
        if (cms && !sig) { sig = { name: it.name, cms: cms }; }
        else docs.push(it);
      });
      if (!sig) {
        $('loaded').innerHTML = '<div class="note err">Не нашли файл подписи. Добавьте файл <code>.sig</code> (или <code>.p7s</code>) контрагента — вместе с документом.</div>';
        if (docs.some(function (d) { return d.isPdf; })) $('loaded').innerHTML += '<div class="note info">Похоже, это PDF с подписью внутри. Эта страница — для отделённой подписи .sig. Для PDF со штампом откройте <a href="/pdf">страницу PDF</a>.</div>';
        return;
      }
      // документ к подписи: по имени, иначе единственный оставшийся
      var bases = baseNames(sig.name);
      var pair = docs.find(function (d) { return bases.indexOf(short(d.name)) >= 0 || bases.indexOf(stem(d.name)) >= 0; }) ||
        (docs.length === 1 ? docs[0] : null);
      if (!pair) {
        $('loaded').innerHTML = '<div class="note err">Нашли подпись <b>' + esc(short(sig.name)) + '</b>, но непонятно, к какому документу она относится. Добавьте сам документ (один файл).</div>';
        return;
      }
      st.cms = sig.cms; st.doc = pair.bytes; st.docName = short(pair.name);
      showExisting(sig, pair);
      ESign.ensureCerts();
    }).catch(function (e) {
      $('loaded').innerHTML = '<div class="note err">Не удалось прочитать файлы: ' + esc(e && e.message || e) + '</div>';
    });
  }

  function who(cert) {
    if (!cert) return 'подписант не указан';
    var s = cert.subject, nm = s.SN && s.G ? s.SN + ' ' + s.G : s.CN;
    return esc([nm, s.O && s.O !== nm ? s.O : ''].filter(Boolean).join(', ') || '—');
  }

  function showExisting(sig, pair) {
    CmsVerify.verify(sig.cms, pair.bytes).then(function (r) {
      st.baseSigners = r.signers.length;
      var rows = r.signers.map(function (sg) {
        var ok = sg.ok;
        return '<li class="' + (ok ? 'yes' : 'no') + '">' + who(sg.cert) +
          (sg.signingTime ? ' <span class="muted small">· ' + esc(fmtDT(sg.signingTime)) + '</span>' : '') +
          (ok ? '' : ' <span class="tag">подпись не подтверждена</span>') + '</li>';
      }).join('');
      var allOk = r.signers.length && r.signers.every(function (s) { return s.ok; });
      $('loaded').innerHTML =
        '<div class="note ' + (allOk ? 'ok' : 'wait') + '"><b>Документ:</b> ' + esc(st.docName) + '<br><b>Уже подписал' + (r.signers.length > 1 ? 'и' : '') + ':</b></div>' +
        '<ul class="checks" style="margin-top:8px">' + rows + '</ul>' +
        (allOk ? '' : '<div class="note wait" style="margin-top:8px">Подпись контрагента не удалось подтвердить (возможно, это не тот документ). Проверьте файлы — иначе ваша подпись ляжет рядом с неподтверждённой.</div>');
      updateButton();
    }).catch(function (e) {
      $('loaded').innerHTML = '<div class="note err">Не удалось разобрать подпись контрагента: ' + esc(e && e.message || e) +
        (/отделённая/.test(e && e.message) ? '. Добавьте сам документ, к которому относится подпись.' : '') + '</div>';
      st.cms = null; updateButton();
    });
  }

  function updateButton() {
    var cert = ESign.selected();
    $('sign').disabled = !(st.cms && st.doc && cert && !cert.expired);
    if (st.cms && st.doc && !cert) status('info', 'Выберите свою подпись в пункте 1.');
    else if (!$('status').querySelector('.err')) status();
  }

  function link(blob, name, cls, text) {
    var u = URL.createObjectURL(blob); urls.push(u);
    return '<a class="btn' + (cls ? ' ' + cls : '') + '" href="' + u + '" download="' + esc(name) + '">' + text + '</a>';
  }

  function doSign() {
    var cert = ESign.selected();
    if (!cert || !st.cms || !st.doc) return;
    var pin = $('pin').value;
    if (cert.src === 'rt' && !pin) { status('err', 'Введите PIN-код Рутокена.'); $('pin').focus(); return; }
    $('sign').disabled = true;
    $('result').hidden = true;
    urls.forEach(URL.revokeObjectURL); urls = [];
    status('wait', 'Подписываем… Если появится окно плагина — подтвердите.');
    var dataB64 = ESign.bytesToB64(st.doc), existingB64 = ESign.bytesToB64(st.cms);
    ESign.coSign(cert, dataB64, existingB64, pin, {}).then(function (newCms) {
      status('wait', 'Проверяем результат…');
      return CmsVerify.verify(newCms, st.doc).then(function (r) {
        // наша подпись — по номеру сертификата; запасной вариант: появившийся новый верный подписант
        var mine = r.signers.find(function (sg) { return sg.cert && hexId(sg.cert.serial) === hexId(cert.serial); });
        var newOk = r.signers.length === st.baseSigners + 1;
        if (!mine && newOk) mine = r.signers.filter(function (sg) { return sg.ok; })[r.signers.length - 1] || null;
        if (!newOk || !mine || !mine.ok) {
          throw friendly('Ваш плагин не смог добавить подпись второго участника правильно. ' +
            'Так бывает со старыми версиями плагина. Напишите нам — поможем: подписей в файле ' + r.signers.length + ', из них ваша ' + (mine ? 'не подтвердилась' : 'не найдена') + '.');
        }
        showResult(newCms, r, cert);
      });
    }).catch(function (e) {
      status('err', e && e.friendly ? e.message : 'Ошибка: ' + esc(e && e.message || e));
    }).finally(function () { updateButton(); });
  }

  function friendly(msg) { var e = new Error(msg); e.friendly = true; return e; }

  function showResult(newCms, r, cert) {
    var base = stem(st.docName).replace(/SGN\d*$/i, '') || 'документ';
    var sigName = base + 'SGN1.sig';
    var sigBlob = new Blob([newCms], { type: 'application/pkcs7-signature' });
    var zip = new JSZip();
    zip.file(st.docName, st.doc);
    zip.file(sigName, newCms);
    zip.generateAsync({ type: 'blob', compression: 'DEFLATE' }).then(function (zb) {
      $('result-title').innerHTML = '<b>Готово!</b> В файле подписи теперь ' + r.signers.length + ' ' +
        (r.signers.length === 2 ? 'подписи' : 'подписей') + '. Сайт их проверил — все верны.';
      $('result-main').innerHTML =
        link(zb, st.docName + '.zip', 'primary', 'Скачать архив (.zip)') +
        link(sigBlob, sigName, '', 'Только подпись (.sig)');
      $('result-signers').innerHTML = '<ul class="checks" style="margin-top:12px">' +
        r.signers.map(function (sg) {
          var me = sg.cert && hexId(sg.cert.serial) === hexId(cert.serial);
          return '<li class="yes">' + who(sg.cert) + (me ? ' <span class="tag">вы</span>' : '') +
            (sg.signingTime ? ' <span class="muted small">· ' + esc(fmtDT(sg.signingTime)) + '</span>' : '') + '</li>';
        }).join('') + '</ul>';
      status();
      $('result').hidden = false;
      $('pin').value = '';
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    var drop = $('drop'), input = $('file');
    input.addEventListener('change', function () { if (input.files.length) load(input.files); input.value = ''; });
    ['dragenter', 'dragover'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
    ['dragleave', 'drop'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); }); });
    drop.addEventListener('drop', function (e) { if (e.dataTransfer.files.length) load(e.dataTransfer.files); });
    $('sign').addEventListener('click', doSign);
    $('pin').addEventListener('keydown', function (e) { if (e.key === 'Enter' && !$('sign').disabled) doSign(); });
    ESign.start({ onSelect: updateButton });
  });
})();
