/* подписатьэцп.рф — главная: одно поле для любых файлов, сайт сам решает, куда дальше. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };

  function isSigName(n) { return /\.(sig|p7s|sgn|p7m|zip)$/i.test(n); }
  function isPdfName(n) { return /\.pdf$/i.test(n); }

  // Есть ли в PDF встроенная подпись — ищем /ByteRange
  function pdfSigned(file) {
    return file.arrayBuffer().then(function (b) {
      var u = new Uint8Array(b), CH = 1 << 20, dec = new TextDecoder('latin1');
      for (var i = 0; i < u.length; i += CH - 16) {
        if (dec.decode(u.subarray(i, Math.min(u.length, i + CH))).indexOf('/ByteRange') >= 0) return true;
      }
      return false;
    });
  }

  function go(files, url) {
    $('home-status').innerHTML = '<div class="note wait">Открываем…</div>';
    Handoff.put(files).then(function () { location.href = url; }, function () {
      // хранилище недоступно (приватный режим) — просто переходим, файл выберут там
      location.href = url;
    });
  }

  function choose(files) {
    var list = Array.prototype.slice.call(files);
    if (!list.length) return;
    if (list.some(function (f) { return isSigName(f.name); })) return go(list, '/verify');
    if (list.length === 1 && isPdfName(list[0].name)) {
      return pdfSigned(list[0]).then(function (signed) {
        if (!signed) return go(list, '/pdf');
        // уже подписан — спросим, что нужно
        $('home-status').innerHTML =
          '<div class="choice"><b>Этот PDF уже подписан.</b> Что сделать?' +
          '<div class="row" style="margin-top:10px"><button class="btn primary" id="ch-verify" type="button">Проверить подпись</button>' +
          '<button class="btn" id="ch-sign" type="button">Подписать ещё раз</button></div></div>';
        $('ch-verify').addEventListener('click', function () { go(list, '/verify'); });
        $('ch-sign').addEventListener('click', function () { go(list, '/pdf'); });
      });
    }
    go(list, '/sign');
  }

  document.addEventListener('DOMContentLoaded', function () {
    var drop = $('drop'), input = $('file');
    input.addEventListener('change', function () { choose(input.files); });
    ['dragenter', 'dragover'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); });
    });
    drop.addEventListener('drop', function (e) { choose(e.dataTransfer.files); });
  });
})();
