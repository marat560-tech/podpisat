/* подписатьэцп.рф — штамп электронной подписи (ГОСТ Р 7.0.97-2025, п. 5.23).
 * Обязательные реквизиты: «Документ подписан электронной подписью», номер сертификата,
 * владелец, срок действия. Никакой рекламы в штампе.
 *
 * Stamp.draw(style, data, scale) -> { canvas, w, h }  (w, h — размер в пунктах PDF)
 */
(function () {
  'use strict';

  var COLORS = {
    blue: '#1d4f9c', navy: '#1b2a5a', green: '#1d6b45', purple: '#5a3aa3', red: '#a8321f', black: '#222222'
  };
  var FONT = '"Segoe UI", Arial, "Helvetica Neue", sans-serif';

  function fmtDate(d) {
    if (!d) return '';
    var dt = d instanceof Date ? d : new Date(d);
    if (isNaN(dt)) return String(d);
    var z = function (x) { return ('0' + x).slice(-2); };
    return z(dt.getDate()) + '.' + z(dt.getMonth() + 1) + '.' + dt.getFullYear();
  }
  function fmtDateTime(d) {
    var z = function (x) { return ('0' + x).slice(-2); };
    return fmtDate(d) + ' ' + z(d.getHours()) + ':' + z(d.getMinutes());
  }

  function lines(style, data) {
    var out = [
      { k: 'Сертификат', v: data.serial || '—', mono: true },
      { k: 'Владелец', v: data.person || '—', bold: true },
      { k: 'Действителен', v: 'с ' + fmtDate(data.validFrom) + ' по ' + fmtDate(data.validTo) }
    ];
    if (style.org && data.org && data.org !== data.person) out.splice(2, 0, { k: 'Организация', v: data.org });
    if (style.title && data.title) out.splice(style.org && data.org && data.org !== data.person ? 3 : 2, 0, { k: 'Должность', v: data.title });
    if (style.date) out.push({ k: 'Подписан', v: fmtDateTime(data.signedAt || new Date()) });
    return out;
  }

  // Уменьшить шрифт, чтобы текст влез в ширину
  function fit(ctx, text, maxW, size, weight, family) {
    var s = size;
    for (; s > 3; s -= 0.25) {
      ctx.font = (weight || '') + ' ' + s + 'px ' + (family || FONT);
      if (ctx.measureText(text).width <= maxW) break;
    }
    return s;
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function draw(style, data, scale) {
    style = style || {};
    var kind = style.kind || 'frame';
    var color = COLORS[style.color] || style.color || COLORS.blue;
    var rows = lines(style, data);
    var W, Hh;
    if (kind === 'round') { W = Hh = 170; }
    else { W = 250; Hh = (kind === 'band' ? 38 : 34) + rows.length * 13 + 8; }
    var k = scale || 4;
    var cv = document.createElement('canvas');
    cv.width = Math.round(W * k); cv.height = Math.round(Hh * k);
    var ctx = cv.getContext('2d');
    ctx.scale(k, k);
    ctx.textBaseline = 'alphabetic';
    var bg = style.fill ? 'rgba(255,255,255,0.92)' : null;

    if (kind === 'round') drawRound(ctx, W, color, rows, data, style, bg);
    else drawRect(ctx, W, Hh, kind, color, rows, data, style, bg);
    return { canvas: cv, w: W, h: Hh };
  }

  function drawRect(ctx, W, Hh, kind, color, rows, data, style, bg) {
    var pad = 7, logo = style.logo;
    var head1 = 'ДОКУМЕНТ ПОДПИСАН', head2 = 'ЭЛЕКТРОННОЙ ПОДПИСЬЮ';
    if (kind === 'frame') {
      roundRect(ctx, 1, 1, W - 2, Hh - 2, 7);
      if (bg) { ctx.fillStyle = bg; ctx.fill(); }
      ctx.lineWidth = 1.6; ctx.strokeStyle = color; ctx.stroke();
    } else if (kind === 'band') {
      roundRect(ctx, 1, 1, W - 2, Hh - 2, 6);
      if (bg) { ctx.fillStyle = bg; ctx.fill(); }
      ctx.lineWidth = 1.2; ctx.strokeStyle = color; ctx.stroke();
      ctx.save(); roundRect(ctx, 1, 1, W - 2, Hh - 2, 6); ctx.clip();
      ctx.fillStyle = color; ctx.fillRect(0, 0, W, 30); ctx.restore();
    } else { // line — тонкая полоса слева
      if (bg) { ctx.fillStyle = bg; ctx.fillRect(0, 0, W, Hh); }
      ctx.fillStyle = color; ctx.fillRect(1, 2, 3, Hh - 4);
    }

    // шапка: логотип + две строки
    var hx = kind === 'line' ? 11 : pad + 2, hy = 4, hw = W - hx - pad, hh = 26;
    if (logo) {
      var lh = 22, lw = Math.min(40, lh * logo.width / logo.height);
      if (kind === 'band') {
        ctx.save(); ctx.fillStyle = '#fff'; roundRect(ctx, hx - 2, hy + 1, lw + 4, lh + 2, 3); ctx.fill(); ctx.restore();
      }
      ctx.drawImage(logo, hx, hy + 2, lw, lh);
      hx += lw + 6; hw -= lw + 6;
    }
    ctx.fillStyle = kind === 'band' ? '#ffffff' : color;
    ctx.textAlign = logo ? 'left' : 'center';
    var tx = logo ? hx : hx + hw / 2;
    fit(ctx, head2, hw, 10.5, '700');
    ctx.fillText(head1, tx, hy + 11);
    ctx.fillText(head2, tx, hy + 23);
    if (kind === 'frame') {
      ctx.fillStyle = color; ctx.globalAlpha = 0.5;
      ctx.fillRect(pad, hh + 4, W - pad * 2, 0.8); ctx.globalAlpha = 1;
    }

    // реквизиты
    var y = (kind === 'band' ? 38 : 34) + 9, kx = kind === 'line' ? 11 : pad + 2, kw = 62, vx = kx + kw, vw = W - vx - pad;
    ctx.textAlign = 'left';
    rows.forEach(function (r) {
      ctx.fillStyle = color; ctx.globalAlpha = 0.8;
      ctx.font = '7.5px ' + FONT;
      ctx.fillText(r.k, kx, y);
      ctx.globalAlpha = 1;
      ctx.fillStyle = kind === 'line' ? '#1b1b1b' : color;
      var fam = r.mono ? 'Consolas, "Courier New", monospace' : FONT;
      fit(ctx, r.v, vw, r.mono ? 7.6 : 8.6, r.bold ? '700' : '', fam);
      ctx.fillText(r.v, vx, y);
      y += 13;
    });
  }

  function drawRound(ctx, W, color, rows, data, style, bg) {
    var c = W / 2, R = W / 2 - 2;
    ctx.beginPath(); ctx.arc(c, c, R, 0, Math.PI * 2);
    if (bg) { ctx.fillStyle = bg; ctx.fill(); }
    ctx.lineWidth = 2.2; ctx.strokeStyle = color; ctx.stroke();
    ctx.beginPath(); ctx.arc(c, c, R - 19, 0, Math.PI * 2); ctx.lineWidth = 1; ctx.stroke();

    // текст по кругу
    var text = 'ДОКУМЕНТ ПОДПИСАН ЭЛЕКТРОННОЙ ПОДПИСЬЮ ★ ';
    ctx.fillStyle = color;
    ctx.font = '700 10.5px ' + FONT;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    var r = R - 9.5, total = 0, widths = [];
    for (var i = 0; i < text.length; i++) { widths.push(ctx.measureText(text[i]).width); total += widths[i]; }
    var scale = (2 * Math.PI * r) / total, a = -Math.PI / 2 - (widths[0] * scale) / (2 * r);
    for (i = 0; i < text.length; i++) {
      var step = widths[i] * scale / r;
      a += step / 2;
      ctx.save();
      ctx.translate(c + r * Math.cos(a), c + r * Math.sin(a));
      ctx.rotate(a + Math.PI / 2);
      ctx.fillText(text[i], 0, 0);
      ctx.restore();
      a += step / 2;
    }

    // середина
    var inner = R - 24, w = inner * 1.7;
    var show = rows.filter(function (x) { return x.k !== 'Организация' && x.k !== 'Должность'; });
    var person = data.person || '—', parts = splitName(person);
    // высота блока: логотип, ФИО, реквизиты — центрируем по вертикали
    var lh = style.logo ? 20 : 0;
    var blockH = (lh ? lh + 6 : 0) + parts.length * 12 + 4 + (show.length - 1) * 10 + 8;
    var top = c - blockH / 2;
    if (style.logo) {
      var lw = Math.min(44, lh * style.logo.width / style.logo.height);
      ctx.drawImage(style.logo, c - lw / 2, top, lw, lh);
      top += lh + 6;
    }
    var y = top + 9;
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = color;
    parts.forEach(function (p, idx) {
      fit(ctx, p, w * 0.86, idx === 0 ? 11 : 9.5, '700');
      ctx.fillText(p, c, y + idx * 12);
    });
    y += parts.length * 12 + 4;
    ctx.globalAlpha = 0.85;
    show.forEach(function (row) {
      if (row.k === 'Владелец') return;
      var t = row.k === 'Сертификат' ? row.v : row.k === 'Действителен' ? row.v : row.k + ' ' + row.v;
      var fam = row.mono ? 'Consolas, "Courier New", monospace' : FONT;
      var maxw = w * (1 - Math.pow((y - c) / inner, 2) * 0.55);
      if (row.k === 'Сертификат') {
        ctx.font = '6.5px ' + FONT; ctx.fillText('сертификат', c, y); y += 8;
      }
      fit(ctx, t, maxw, row.mono ? 7 : 7.6, '', fam);
      ctx.fillText(t, c, y);
      y += 10;
    });
    ctx.globalAlpha = 1;
  }

  function splitName(s) {
    var w = s.split(/\s+/);
    if (w.length >= 3) return [w[0], w.slice(1).join(' ')];
    return [s];
  }

  // Картинка для PDF: RGB и прозрачность отдельно
  function toImage(cv) {
    var ctx = cv.getContext('2d'), d = ctx.getImageData(0, 0, cv.width, cv.height).data;
    var n = cv.width * cv.height, rgb = new Uint8Array(n * 3), alpha = new Uint8Array(n);
    for (var i = 0; i < n; i++) {
      var a = d[i * 4 + 3];
      alpha[i] = a;
      // canvas хранит цвета без домножения на альфу — берём как есть
      rgb[i * 3] = d[i * 4]; rgb[i * 3 + 1] = d[i * 4 + 1]; rgb[i * 3 + 2] = d[i * 4 + 2];
    }
    return { w: cv.width, h: cv.height, rgb: rgb, alpha: alpha };
  }

  window.Stamp = { draw: draw, toImage: toImage, COLORS: COLORS, fmtDate: fmtDate };
})();
