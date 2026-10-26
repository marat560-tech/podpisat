/* подписатьэцп.рф — подпись PDF со штампом (PAdES): просмотр, расстановка штампа, подпись. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var esc = ESign.esc;
  var MAX_SIZE = 50 * 1024 * 1024;
  var SAMPLE = {
    person: 'Фамилия Имя Отчество', serial: '01DB4C3F00A1B0C2D3E4F5A6B7C8D9E0', org: 'ООО «Организация»', title: 'Генеральный директор',
    validFrom: new Date(Date.now() - 100 * 864e5), validTo: new Date(Date.now() + 265 * 864e5)
  };
  var DEFAULT_STYLE = { kind: 'frame', color: 'blue', org: false, title: false, date: false, fill: true, size: 100, logo: null };

  var st = {
    file: null, bytes: null, pdf: null, inc: null, pages: [], placements: [],
    style: Object.assign({}, DEFAULT_STYLE), logoImg: null, stampUrl: null, stampW: 0, stampH: 0
  };

  function status(id, kind, html) {
    $(id).innerHTML = html ? '<div class="note ' + kind + '">' + html + '</div>' : '';
  }
  function enable(stepId, on) { $(stepId).classList.toggle('off', !on); }

  function fmtSize(n) {
    if (n < 1024 * 1024) return (n / 1024).toFixed(1).replace('.', ',') + ' КБ';
    return (n / 1024 / 1024).toFixed(1).replace('.', ',') + ' МБ';
  }

  // ---------------------------------------------------------------- оформление штампа
  function certKey(c) { return 'podp:stamp:' + (c ? (c.serial || c.id) : 'default'); }

  function loadStyle(c) {
    var s = null;
    try { s = JSON.parse(localStorage.getItem(certKey(c)) || localStorage.getItem(certKey(null)) || 'null'); } catch (e) { s = null; }
    st.style = Object.assign({}, DEFAULT_STYLE, s || {});
    return loadLogo().then(syncControls).then(redrawStamp);
  }

  function saveStyle() {
    var c = ESign.selected();
    try {
      var v = JSON.stringify(st.style);
      localStorage.setItem(certKey(null), v);
      if (c) localStorage.setItem(certKey(c), v);
    } catch (e) { /* хранилище недоступно — не страшно */ }
  }

  function loadLogo() {
    st.logoImg = null;
    if (!st.style.logo) return Promise.resolve();
    return new Promise(function (res) {
      var im = new Image();
      im.onload = function () { st.logoImg = im; res(); };
      im.onerror = function () { st.style.logo = null; res(); };
      im.src = st.style.logo;
    });
  }

  function syncControls() {
    Array.prototype.forEach.call(document.querySelectorAll('#kinds .chip-btn'), function (b) {
      b.classList.toggle('on', b.dataset.kind === st.style.kind);
    });
    Array.prototype.forEach.call(document.querySelectorAll('#colors .swatch'), function (b) {
      b.classList.toggle('on', b.dataset.color === st.style.color);
    });
    $('o-org').checked = !!st.style.org;
    $('o-title').checked = !!st.style.title;
    $('o-date').checked = !!st.style.date;
    $('o-fill').checked = !!st.style.fill;
    $('o-size').value = st.style.size;
    $('logo-x').hidden = !st.style.logo;
  }

  function stampData(signedAt) {
    var c = ESign.selected();
    var d = c ? { person: c.person || c.who, serial: c.serial, org: c.org, title: c.title, validFrom: c.validFrom, validTo: c.validTo } : SAMPLE;
    d = Object.assign({}, d, { signedAt: signedAt || new Date() });
    return d;
  }

  function styleForDraw() {
    return Object.assign({}, st.style, { logo: st.logoImg });
  }

  function redrawStamp() {
    var r = Stamp.draw(styleForDraw(), stampData(), 3);
    st.stampW = r.w; st.stampH = r.h;
    st.stampUrl = r.canvas.toDataURL('image/png');
    var prev = $('stamp-preview');
    prev.innerHTML = '';
    var img = new Image();
    img.src = st.stampUrl;
    img.style.width = Math.round(r.w * 1.25) + 'px';
    prev.appendChild(img);
    st.placements.forEach(layoutPlacement);
  }

  function setStyle(patch) {
    Object.assign(st.style, patch);
    saveStyle();
    syncControls();
    redrawStamp();
  }

  // ---------------------------------------------------------------- просмотр PDF
  function openFile(file) {
    $('result').hidden = true;
    status('status', '', '');
    status('file-status', '', '');
    if (!file) return;
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
      status('file-status', 'err', 'Это не PDF. Для других файлов есть <a href="/sign">отделённая подпись</a>.');
      return;
    }
    if (file.size > MAX_SIZE) { status('file-status', 'err', 'Файл больше 50 МБ — такой большой файл браузерный плагин может не осилить.'); return; }
    status('file-status', 'wait', 'Открываем документ…');
    file.arrayBuffer().then(function (buf) {
      var bytes = new Uint8Array(buf);
      return PdfInc.open(bytes).then(function (inc) {
        return pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise.then(function (pdf) {
          if (pdf.numPages !== inc.pages.length) throw Object.assign(new Error('Не удалось однозначно разобрать страницы документа.'), { pdf: true });
          st.file = file; st.bytes = bytes; st.inc = inc;
          if (st.pdf) st.pdf.destroy();
          st.pdf = pdf;
          st.placements = [];
          $('chip').hidden = false;
          $('chip').innerHTML = '📄 <div><b>' + esc(file.name) + '</b><div class="small muted">' + fmtSize(file.size) + ' · страниц: ' + pdf.numPages +
            ' · <a href="#" id="change">выбрать другой</a></div></div>';
          $('drop').hidden = true;
          $('change').addEventListener('click', function (e) {
            e.preventDefault(); $('file').value = ''; $('drop').hidden = false; $('chip').hidden = true;
            st.file = null; $('viewer').innerHTML = ''; st.placements = []; update();
          });
          status('file-status', 'err', inc.locked
            ? 'Автор документа запретил любые изменения после своей подписи. Новая подпись сделает прежнюю недействительной.' : '');
          ESign.ensureCerts();
          return buildViewer();
        });
      });
    }).then(function () {
      placeDefault();
      update();
    }).catch(function (e) {
      status('file-status', 'err', e && e.pdf ? esc(e.message) : 'Не удалось открыть PDF: ' + esc(e && e.message || e));
    });
  }

  function buildViewer() {
    var viewer = $('viewer');
    viewer.innerHTML = '';
    st.pages = [];
    if (st.observer) st.observer.disconnect();
    st.observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { if (en.isIntersecting) renderPage(+en.target.dataset.i); });
    }, { rootMargin: '400px 0px' });
    var chain = Promise.resolve();
    for (var i = 0; i < st.pdf.numPages; i++) (function (i) {
      chain = chain.then(function () {
        return st.pdf.getPage(i + 1).then(function (page) {
          var vp = page.getViewport({ scale: 1 });
          var wrap = document.createElement('div');
          wrap.className = 'pg';
          wrap.dataset.i = i;
          wrap.style.aspectRatio = vp.width + ' / ' + vp.height;
          wrap.innerHTML = '<div class="pg-num">' + (i + 1) + '</div>';
          wrap.addEventListener('click', function (e) {
            if (e.target.closest('.stamp')) return;
            var r = wrap.getBoundingClientRect();
            var fw = st.stampW * st.style.size / 100 / vp.width, fh = st.stampH * st.style.size / 100 / vp.height;
            addPlacement(i, (e.clientX - r.left) / r.width - fw / 2, (e.clientY - r.top) / r.height - fh / 2);
          });
          viewer.appendChild(wrap);
          st.pages.push({ page: page, vp: vp, el: wrap, rendered: false });
          st.observer.observe(wrap);
        });
      });
    })(i);
    return chain;
  }

  function renderPage(i) {
    var p = st.pages[i];
    if (!p || p.rendered) return;
    p.rendered = true;
    var cssW = p.el.clientWidth || 700, dpr = Math.min(window.devicePixelRatio || 1, 2);
    var vp = p.page.getViewport({ scale: cssW / p.vp.width * dpr });
    var cv = document.createElement('canvas');
    cv.width = Math.floor(vp.width); cv.height = Math.floor(vp.height);
    p.el.insertBefore(cv, p.el.firstChild);
    p.page.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise.catch(function () {});
  }

  // ---------------------------------------------------------------- штампы на страницах
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  function addPlacement(page, fx, fy) {
    if ($('invisible').checked) { $('invisible').checked = false; }
    var pl = { page: page, fx: fx, fy: fy, el: null };
    var el = document.createElement('div');
    el.className = 'stamp';
    el.innerHTML = '<img alt="Штамп подписи" draggable="false"><button type="button" class="x" title="Убрать">✕</button>';
    el.querySelector('.x').addEventListener('click', function (e) {
      e.stopPropagation();
      st.placements.splice(st.placements.indexOf(pl), 1);
      el.remove();
      update();
    });
    drag(el, pl);
    pl.el = el;
    st.pages[page].el.appendChild(el);
    st.placements.push(pl);
    layoutPlacement(pl);
    update();
    return pl;
  }

  function layoutPlacement(pl) {
    var p = st.pages[pl.page];
    var fw = st.stampW * st.style.size / 100 / p.vp.width, fh = st.stampH * st.style.size / 100 / p.vp.height;
    pl.fx = clamp(pl.fx, 0, Math.max(0, 1 - fw));
    pl.fy = clamp(pl.fy, 0, Math.max(0, 1 - fh));
    var el = pl.el;
    el.style.left = pl.fx * 100 + '%';
    el.style.top = pl.fy * 100 + '%';
    el.style.width = fw * 100 + '%';
    el.style.height = fh * 100 + '%';
    el.querySelector('img').src = st.stampUrl;
  }

  function drag(el, pl) {
    var start = null;
    el.addEventListener('pointerdown', function (e) {
      if (e.target.closest('.x')) return;
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      var r = st.pages[pl.page].el.getBoundingClientRect();
      start = { x: e.clientX, y: e.clientY, fx: pl.fx, fy: pl.fy, w: r.width, h: r.height };
      el.classList.add('drag');
    });
    el.addEventListener('pointermove', function (e) {
      if (!start) return;
      pl.fx = start.fx + (e.clientX - start.x) / start.w;
      pl.fy = start.fy + (e.clientY - start.y) / start.h;
      layoutPlacement(pl);
    });
    function end() { start = null; el.classList.remove('drag'); }
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  // правый нижний угол с отступом 15 мм
  function cornerFor(i) {
    var p = st.pages[i], m = 42.5;
    var w = st.stampW * st.style.size / 100, h = st.stampH * st.style.size / 100;
    return { fx: (p.vp.width - w - m) / p.vp.width, fy: (p.vp.height - h - m) / p.vp.height };
  }

  function placeDefault() {
    if (st.placements.length || !st.pages.length) return;
    var i = st.pages.length - 1, c = cornerFor(i);
    addPlacement(i, c.fx, c.fy);
  }

  function clearPlacements() {
    st.placements.forEach(function (pl) { pl.el.remove(); });
    st.placements = [];
  }

  // ---------------------------------------------------------------- подпись
  function update() {
    var c = ESign.selected(), has = !!st.file;
    enable('st2', has);
    enable('st3', has && !$('invisible').checked);
    enable('st4', has);
    var ready = has && c && !c.expired && (st.placements.length || $('invisible').checked);
    $('sign').disabled = !ready;
    enable('st5', !!(has && c && !c.expired));
    if (has && c && !st.placements.length && !$('invisible').checked) {
      status('status', 'info', 'Поставьте штамп хотя бы на одну страницу или отметьте «без штампа».');
    } else if (!$('status').querySelector('.err')) {
      status('status', '', '');
    }
  }

  function outName(name) {
    var base = name.replace(/\.pdf$/i, '');
    return base + '_подписан.pdf';
  }

  function doSign() {
    var cert = ESign.selected();
    if (!cert || !st.file) return;
    var pin = $('pin').value;
    if (cert.src === 'rt' && !pin) { status('status', 'err', 'Введите PIN-код Рутокена.'); $('pin').focus(); return; }
    $('sign').disabled = true;
    $('result').hidden = true;
    status('status', 'wait', 'Готовим документ…');
    var now = new Date(), size = st.style.size / 100;
    var widgets = [];
    if (!$('invisible').checked) {
      var r = Stamp.draw(styleForDraw(), stampData(now), 4 * size);
      var image = Object.assign(Stamp.toImage(r.canvas), { key: 'stamp' });
      st.placements.slice().sort(function (a, b) { return a.page - b.page; }).forEach(function (pl) {
        var p = st.pages[pl.page], vp = p.vp;
        var x1 = pl.fx * vp.width, y1 = pl.fy * vp.height, x2 = x1 + r.w * size, y2 = y1 + r.h * size;
        var a = vp.convertToPdfPoint(x1, y1), b = vp.convertToPdfPoint(x2, y2);
        widgets.push({ page: pl.page, rect: [a[0], a[1], b[0], b[1]], rotate: p.page.rotate, image: image });
      });
    }
    var prep;
    PdfInc.prepare(st.inc, {
      widgets: widgets, date: now,
      name: cert.person || cert.who,
      stampText: 'Документ подписан электронной подписью. Владелец: ' + (cert.person || cert.who) + '. Сертификат: ' + cert.serial
    }).then(function (p) {
      prep = p;
      status('status', 'wait', 'Подписываем… Если появится окно плагина — подтвердите.');
      return ESign.signMany(cert, [ESign.bytesToB64(PdfInc.signedBytes(prep))], pin, {});
    }).then(function (cms) {
      var out = PdfInc.finish(prep, cms[0]);
      var a = $('dl-pdf');
      if (a.href) URL.revokeObjectURL(a.href);
      a.href = URL.createObjectURL(new Blob([out], { type: 'application/pdf' }));
      a.download = outName(st.file.name);
      $('sig-info').innerHTML =
        '<dt>Подписант</dt><dd>' + esc(cert.who) + (cert.org && cert.org !== cert.who ? ', ' + esc(cert.org) : '') + '</dd>' +
        '<dt>Сертификат</dt><dd>' + esc(cert.serial) + '</dd>' +
        '<dt>Время</dt><dd>' + esc(now.toLocaleString('ru-RU')) + '</dd>' +
        '<dt>Штампов</dt><dd>' + (widgets.length || 'без штампа') + '</dd>' +
        '<dt>Файл</dt><dd>' + esc(a.download) + ' (' + fmtSize(out.length) + ')</dd>';
      status('status', '', '');
      $('result').hidden = false;
      $('pin').value = '';
    }).catch(function (e) {
      status('status', 'err', e && (e.friendly || e.pdf) ? e.message : 'Ошибка: ' + esc(e && e.message || e));
    }).finally(update);
  }

  // ---------------------------------------------------------------- старт
  document.addEventListener('DOMContentLoaded', function () {
    pdfjsLib.GlobalWorkerOptions.workerSrc = '/static/vendor/pdfjs/pdf.worker.js';

    var drop = $('drop'), input = $('file');
    input.addEventListener('change', function () { openFile(input.files[0]); });
    ['dragenter', 'dragover'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); });
    });
    drop.addEventListener('drop', function (e) { if (e.dataTransfer.files[0]) openFile(e.dataTransfer.files[0]); });

    var colors = $('colors');
    Object.keys(Stamp.COLORS).forEach(function (k) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'swatch'; b.dataset.color = k; b.title = k;
      b.style.background = Stamp.COLORS[k];
      b.addEventListener('click', function () { setStyle({ color: k }); });
      colors.appendChild(b);
    });
    Array.prototype.forEach.call(document.querySelectorAll('#kinds .chip-btn'), function (b) {
      b.addEventListener('click', function () { setStyle({ kind: b.dataset.kind }); });
    });
    [['o-org', 'org'], ['o-title', 'title'], ['o-date', 'date'], ['o-fill', 'fill']].forEach(function (x) {
      $(x[0]).addEventListener('change', function () { var p = {}; p[x[1]] = $(x[0]).checked; setStyle(p); });
    });
    $('o-size').addEventListener('input', function () { setStyle({ size: +$('o-size').value }); });
    $('logo').addEventListener('change', function () {
      var f = $('logo').files[0];
      $('logo').value = '';
      if (!f) return;
      if (f.size > 2 * 1024 * 1024) { alert('Картинка больше 2 МБ — выберите поменьше.'); return; }
      var rd = new FileReader();
      rd.onload = function () {
        // уменьшаем до 400 px, чтобы не раздувать PDF и хранилище
        var im = new Image();
        im.onload = function () {
          var k = Math.min(1, 400 / Math.max(im.width, im.height));
          var cv = document.createElement('canvas');
          cv.width = Math.max(1, Math.round(im.width * k)); cv.height = Math.max(1, Math.round(im.height * k));
          cv.getContext('2d').drawImage(im, 0, 0, cv.width, cv.height);
          st.style.logo = cv.toDataURL('image/png');
          loadLogo().then(function () { saveStyle(); syncControls(); redrawStamp(); });
        };
        im.src = rd.result;
      };
      rd.readAsDataURL(f);
    });
    $('logo-x').addEventListener('click', function () { st.style.logo = null; st.logoImg = null; saveStyle(); syncControls(); redrawStamp(); });

    $('place-last').addEventListener('click', function () {
      if (!st.pages.length) return;
      var i = st.pages.length - 1, c = cornerFor(i);
      addPlacement(i, c.fx, c.fy);
      st.pages[i].el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    $('place-all').addEventListener('click', function () {
      if (!st.pages.length) return;
      var ref = st.placements[st.placements.length - 1];
      clearPlacements();
      st.pages.forEach(function (p, i) {
        var c = ref ? { fx: ref.fx, fy: ref.fy } : cornerFor(i);
        addPlacement(i, c.fx, c.fy);
      });
    });
    $('place-clear').addEventListener('click', function () { clearPlacements(); update(); });
    $('invisible').addEventListener('change', update);

    $('sign').addEventListener('click', doSign);
    $('pin').addEventListener('keydown', function (e) { if (e.key === 'Enter' && !$('sign').disabled) doSign(); });

    loadStyle(null);
    ESign.start({ onSelect: function (c) { loadStyle(c).then(update); } });
  });
})();
