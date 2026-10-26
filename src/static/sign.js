/* подписатьэцп.рф — отделённая подпись файлов (один или сразу несколько).
 * Результат: CMS CAdES-BES, ГОСТ Р 34.10-2012, упаковка как у СБИС/КриптоАРМ:
 * <имя>.zip = <имя> + <имя без расширения>SGN1.sig
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var esc = ESign.esc;
  var MAX_SIZE = 50 * 1024 * 1024, MAX_TOTAL = 200 * 1024 * 1024;
  var files = [];
  var urls = [];

  function fmtSize(n) {
    if (n < 1024) return n + ' Б';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1).replace('.', ',') + ' КБ';
    return (n / 1024 / 1024).toFixed(1).replace('.', ',') + ' МБ';
  }

  function status(kind, html) {
    $('status').innerHTML = html ? '<div class="note ' + kind + '">' + html + '</div>' : '';
  }

  function sigNames(fileName) {
    var dot = fileName.lastIndexOf('.');
    var base = dot > 0 ? fileName.slice(0, dot) : fileName;
    return { sig: base + 'SGN1.sig', zip: fileName + '.zip' };
  }

  function readB64(file) {
    return new Promise(function (res, rej) {
      var r = new FileReader();
      r.onload = function () { res(String(r.result).split(',')[1] || ''); };
      r.onerror = function () { rej(r.error); };
      r.readAsDataURL(file);
    });
  }

  function enable(stepId, on) { $(stepId).classList.toggle('off', !on); }

  function updateSignButton() {
    var c = ESign.selected();
    var ready = files.length && c && !c.expired;
    $('sign').disabled = !ready;
    $('sign').textContent = files.length > 1 ? 'Подписать ' + files.length + ' ' + plural(files.length, 'файл', 'файла', 'файлов') : 'Подписать';
    enable('st3', !!ready);
  }

  function plural(n, one, few, many) {
    var m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  }

  function renderFiles() {
    var box = $('files');
    box.hidden = !files.length;
    $('drop').classList.toggle('compact', files.length > 0);
    box.innerHTML = files.map(function (f, i) {
      return '<div class="file-chip">📄 <div class="grow"><b>' + esc(f.name) + '</b><div class="small muted">' + fmtSize(f.size) + '</div></div>' +
        '<button class="x" type="button" data-i="' + i + '" title="Убрать">×</button></div>';
    }).join('');
    Array.prototype.forEach.call(box.querySelectorAll('button.x'), function (b) {
      b.addEventListener('click', function () { files.splice(+b.dataset.i, 1); renderFiles(); updateSignButton(); });
    });
    enable('st2', files.length > 0);
    updateSignButton();
  }

  function addFiles(list) {
    $('result').hidden = true;
    status();
    var skipped = [];
    Array.prototype.forEach.call(list, function (f) {
      if (f.size > MAX_SIZE) { skipped.push(f.name); return; }
      if (files.some(function (x) { return x.name === f.name && x.size === f.size && x.lastModified === f.lastModified; })) return;
      files.push(f);
    });
    if (skipped.length) status('err', 'Больше 50 МБ — такой большой файл браузерный плагин может не осилить: ' + skipped.map(esc).join(', '));
    var total = files.reduce(function (s, f) { return s + f.size; }, 0);
    if (total > MAX_TOTAL) status('err', 'Слишком много данных за один раз (больше 200 МБ). Подпишите файлы частями.');
    renderFiles();
    if (files.length) ESign.ensureCerts();
  }

  function link(blob, name, cls, text) {
    var u = URL.createObjectURL(blob);
    urls.push(u);
    return '<a class="btn' + (cls ? ' ' + cls : '') + '" href="' + u + '" download="' + esc(name) + '">' + text + '</a>';
  }

  function doSign() {
    var cert = ESign.selected(), list = files.slice();
    if (!cert || !list.length) return;
    var pin = $('pin').value;
    if (cert.src === 'rt' && !pin) { status('err', 'Введите PIN-код Рутокена.'); $('pin').focus(); return; }
    $('sign').disabled = true;
    $('result').hidden = true;
    urls.forEach(URL.revokeObjectURL); urls = [];
    status('wait', 'Читаем файлы…');
    Promise.all(list.map(readB64)).then(function (b64s) {
      status('wait', 'Подписываем… Если появится окно плагина — подтвердите.');
      return ESign.signMany(cert, b64s, pin, {}, function (i, n) {
        if (n > 1) status('wait', 'Подписываем ' + (i + 1) + ' из ' + n + '… Если появится окно плагина — подтвердите.');
      });
    }).then(function (sigs) {
      status('wait', 'Упаковываем…');
      var all = new JSZip(), used = {};
      var per = list.map(function (file, i) {
        var names = sigNames(file.name), zip = new JSZip();
        zip.file(file.name, file);
        zip.file(names.sig, sigs[i]);
        // в общем архиве одинаковые имена разводим по папкам
        var dir = used[file.name] ? (used[file.name]++ + 1) + '/' : '';
        used[file.name] = used[file.name] || 1;
        all.file(dir + file.name, file);
        all.file(dir + names.sig, sigs[i]);
        return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' }).then(function (blob) {
          return { file: file, names: names, zip: blob, sig: new Blob([sigs[i]], { type: 'application/pkcs7-signature' }), sigLen: sigs[i].length };
        });
      });
      return Promise.all(per).then(function (res) {
        if (res.length === 1) return { res: res, all: null };
        return all.generateAsync({ type: 'blob', compression: 'DEFLATE' }).then(function (b) { return { res: res, all: b }; });
      });
    }).then(function (out) {
      var res = out.res, now = new Date();
      if (res.length === 1) {
        var r = res[0];
        $('result-title').innerHTML = '<b>Готово!</b> Файл подписан.';
        $('result-main').innerHTML = link(r.zip, r.names.zip, 'primary', 'Скачать архив (.zip)') + link(r.sig, r.names.sig, '', 'Только подпись (.sig)');
        $('result-list').innerHTML = '';
      } else {
        var stamp = now.toISOString().slice(0, 10);
        $('result-title').innerHTML = '<b>Готово!</b> Подписано файлов: ' + res.length + '.';
        $('result-main').innerHTML = link(out.all, 'подписано_' + stamp + '.zip', 'primary', 'Скачать всё одним архивом');
        $('result-list').innerHTML = res.map(function (r) {
          return '<div class="res-row"><span class="grow">📄 ' + esc(r.file.name) + '</span>' +
            link(r.zip, r.names.zip, 'sm', '.zip') + link(r.sig, r.names.sig, 'sm', '.sig') + '</div>';
        }).join('');
      }
      $('sig-info').innerHTML =
        '<dt>Подписант</dt><dd>' + esc(cert.who) + (cert.org && cert.org !== cert.who ? ', ' + esc(cert.org) : '') + '</dd>' +
        (cert.inn ? '<dt>ИНН</dt><dd>' + esc(cert.inn) + '</dd>' : '') +
        '<dt>Время</dt><dd>' + esc(now.toLocaleString('ru-RU')) + '</dd>';
      status();
      $('result').hidden = false;
      $('pin').value = '';
    }).catch(function (e) {
      status('err', e && e.friendly ? e.message : 'Ошибка: ' + esc(e && e.message || e));
    }).finally(function () {
      updateSignButton();
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    var drop = $('drop'), input = $('file');
    input.addEventListener('change', function () { addFiles(input.files); input.value = ''; });
    ['dragenter', 'dragover'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); });
    });
    drop.addEventListener('drop', function (e) { if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files); });
    $('sign').addEventListener('click', doSign);
    $('pin').addEventListener('keydown', function (e) { if (e.key === 'Enter' && !$('sign').disabled) doSign(); });
    ESign.start({ onSelect: updateSignButton });
  });
})();
