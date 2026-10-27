/* подписатьэцп.рф — проверка связи сайта с УТМ ЕГАИС.
 * Только чтение (GET): /api/info/list и /opt/out. В ЕГАИС ничего не отправляется.
 *
 * Что выясняем:
 *  1) отвечает ли что-то по адресу УТМ (запрос no-cors: ответ не читаем, но видно, что порт жив);
 *  2) разрешает ли УТМ сайту читать свои ответы (обычный запрос: без заголовков CORS браузер не даст);
 *  3) если читать можно — ФСРАР ID, версия, сертификаты, число входящих документов.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var TIMEOUT = 6000;
  var last = null;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function normalize(v) {
    v = String(v || '').trim();
    if (!v) v = 'http://localhost:8080';
    if (!/^https?:\/\//i.test(v)) v = 'http://' + v;
    v = v.replace(/\/+$/, '');
    try {
      var u = new URL(v);
      if (!u.port && u.protocol === 'http:') u.port = '8080';
      return u.origin;
    } catch (e) { return null; }
  }

  function addressKind(origin) {
    var h = new URL(origin).hostname;
    if (h === 'localhost' || h === '127.0.0.1' || h === '[::1]') return 'loopback';
    if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(h) || /\.local$/i.test(h) || !/\./.test(h)) return 'local';
    return 'public';
  }

  function withTimeout(url, opts) {
    var ctl = new AbortController();
    var t = setTimeout(function () { ctl.abort(); }, TIMEOUT);
    opts = Object.assign({ cache: 'no-store', signal: ctl.signal }, opts || {});
    return fetch(url, opts).finally(function () { clearTimeout(t); });
  }

  // Chrome (Local Network Access): адрес из локальной сети нужно явно пометить,
  // иначе запрос с https-страницы к http-адресу в сети блокируется. В других браузерах опция игнорируется.
  function lnaOpts(kind) {
    return kind === 'loopback' ? { targetAddressSpace: 'loopback' } : kind === 'local' ? { targetAddressSpace: 'local' } : {};
  }

  // Ищем значения по ключам на любой глубине JSON
  function find(obj, re) {
    var out = [];
    (function walk(o, path) {
      if (!o || typeof o !== 'object') return;
      Object.keys(o).forEach(function (k) {
        var v = o[k], p = path ? path + '.' + k : k;
        if (re.test(k) && (typeof v !== 'object' || v === null)) out.push({ path: p, value: v });
        walk(v, p);
      });
    })(obj, '');
    return out;
  }

  function fmtDate(v) {
    if (v == null || v === '') return '';
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v));
    if (m) return m[3] + '.' + m[2] + '.' + m[1];
    var d = typeof v === 'number' ? new Date(v) : new Date(String(v));
    return isNaN(d) ? String(v) : d.toLocaleDateString('ru-RU');
  }

  function line(ok, text) { return '<li class="' + (ok ? 'yes' : ok === false ? 'no' : 'skip') + '">' + text + '</li>'; }

  function run() {
    var origin = normalize($('utm-url').value);
    var box = $('utm-result');
    if (!origin) { box.innerHTML = '<div class="note err">Не похоже на адрес. Пример: <code>http://localhost:8080</code></div>'; return; }
    $('utm-url').value = origin;
    $('utm-go').disabled = true;
    box.innerHTML = '<div class="note wait">Проверяем ' + esc(origin) + '… Если браузер спросит разрешение на доступ к устройствам в локальной сети — нажмите «Разрешить».</div>';

    var kind = addressKind(origin);
    var res = { origin: origin, kind: kind, at: new Date().toISOString(), reachable: null, readable: null, info: null, outCount: null, errors: [] };

    // 1) жив ли адрес (ответ непрозрачный, но успешный fetch = кто-то ответил по HTTP)
    withTimeout(origin + '/', Object.assign({ mode: 'no-cors' }, lnaOpts(kind))).then(function () {
      res.reachable = true;
    }, function (e) {
      res.reachable = false;
      res.errors.push('no-cors: ' + (e && e.name === 'AbortError' ? 'нет ответа за ' + TIMEOUT / 1000 + ' с' : (e && e.message) || e));
    }).then(function () {
      // 2) можно ли читать ответы
      return withTimeout(origin + '/api/info/list', lnaOpts(kind)).then(function (r) {
        res.readable = true;
        res.status = r.status;
        return r.text().then(function (t) {
          try { res.info = JSON.parse(t); } catch (e) { res.infoText = t.slice(0, 2000); }
        });
      }, function (e) {
        res.readable = false;
        res.errors.push('cors: ' + (e && e.name === 'AbortError' ? 'нет ответа' : (e && e.message) || e));
      });
    }).then(function () {
      if (!res.readable) return;
      // 3) входящие документы — только счёт
      return withTimeout(origin + '/opt/out', lnaOpts(kind)).then(function (r) { return r.text(); }).then(function (t) {
        var m = t.match(/<url[\s>]/gi);
        res.outCount = m ? m.length : 0;
      }, function (e) { res.errors.push('opt/out: ' + ((e && e.message) || e)); });
    }).then(function () {
      last = res;
      render(res);
    }).finally(function () {
      $('utm-go').disabled = false;
    });
  }

  function render(r) {
    var html = '<ul class="checks" style="margin-top:14px">';
    html += line(r.reachable, r.reachable ? 'По адресу ' + esc(r.origin) + ' кто-то отвечает' : 'По адресу ' + esc(r.origin) + ' никто не отвечает');
    html += line(r.readable, r.readable ? 'Сайт может читать ответы УТМ' : r.reachable ? 'УТМ не разрешает сайту читать свои ответы' : 'Прочитать ответ УТМ не удалось');
    html += '</ul>';

    var verdict, kind;
    if (r.readable && r.info) {
      kind = 'ok';
      verdict = '<b>Сайт видит УТМ напрямую.</b> Раздел ЕГАИС сможет работать с ним без дополнительных программ.';
    } else if (r.readable) {
      kind = 'wait';
      verdict = '<b>Что-то отвечает, но это не похоже на УТМ.</b> Проверьте адрес и порт.';
    } else if (r.reachable) {
      kind = 'wait';
      verdict = '<b>УТМ работает, но браузер не даёт сайту читать его ответы</b> — УТМ не разрешает обращения со сторонних сайтов. Для работы раздела ЕГАИС понадобится мост в программе Help4x (готовим).';
    } else {
      kind = 'err';
      var tips = ['УТМ не запущен — проверьте, открывается ли <code>' + esc(r.origin) + '</code> в новой вкладке.'];
      if (r.kind === 'local') {
        tips.push('УТМ на другом компьютере: в настройках УТМ должен быть разрешён IP этого компьютера, а брандмауэр на компьютере с УТМ — пропускать порт.');
        tips.push('Браузер мог заблокировать обращение с защищённого сайта к адресу в локальной сети. Тогда понадобится мост Help4x.');
      }
      tips.push('Если браузер спрашивал разрешение на доступ к устройствам в локальной сети и вы нажали «Блокировать» — разрешите его в настройках сайта (значок слева от адреса).');
      verdict = '<b>До УТМ достучаться не удалось.</b> Возможные причины:<ul style="margin:6px 0 0;padding-left:20px">' + tips.map(function (t) { return '<li>' + t + '</li>'; }).join('') + '</ul>';
    }
    html += '<div class="note ' + kind + '">' + verdict + '</div>';

    if (r.info) {
      var get = function (re) { var f = find(r.info, re)[0]; return f ? f.value : ''; };
      var rows = [];
      var fsrar = get(/^(ownerId|fsrarId|FSRAR_ID|ClientId)$/i);
      var ver = get(/^version$/i);
      if (fsrar) rows.push(['ФСРАР ID', esc(fsrar)]);
      if (ver) rows.push(['Версия УТМ', esc(ver)]);
      var seen = {};
      find(r.info, /expire|validTo|notAfter|endDate/i).forEach(function (x) {
        var label = /gost/i.test(x.path) ? 'Сертификат ГОСТ до' : /rsa/i.test(x.path) ? 'Сертификат RSA до' : 'Действует до';
        var v = fmtDate(x.value);
        if (!v || seen[label]) return;   // пустые и повторы не показываем
        seen[label] = 1;
        rows.push([label, esc(v)]);
      });
      if (r.outCount != null) rows.push(['Входящих документов', String(r.outCount)]);
      if (rows.length) html += '<dl class="kv">' + rows.map(function (x) { return '<dt>' + x[0] + '</dt><dd>' + x[1] + '</dd>'; }).join('') + '</dl>';
    }

    html += '<details class="more-opts" style="margin-top:12px"><summary>Подробности для поддержки</summary>' +
      '<pre class="diag">' + esc(diagText(r)) + '</pre>' +
      '<button class="btn sm" type="button" id="utm-copy">Скопировать</button></details>';
    $('utm-result').innerHTML = html;
    $('utm-copy').addEventListener('click', function () {
      navigator.clipboard.writeText(diagText(last)).then(function () { $('utm-copy').textContent = 'Скопировано'; }, function () {});
    });
  }

  function diagText(r) {
    return [
      'Проверка УТМ — подписатьэцп.рф',
      'Время: ' + r.at,
      'Адрес: ' + r.origin + ' (' + r.kind + ')',
      'Браузер: ' + navigator.userAgent,
      'Отвечает: ' + r.reachable,
      'Читается: ' + r.readable + (r.status ? ' (HTTP ' + r.status + ')' : ''),
      r.outCount != null ? 'Входящих документов: ' + r.outCount : '',
      r.errors.length ? 'Ошибки: ' + r.errors.join(' | ') : '',
      r.info ? 'api/info/list: ' + JSON.stringify(r.info).slice(0, 3000) : (r.infoText ? 'Ответ: ' + r.infoText : '')
    ].filter(Boolean).join('\n');
  }

  document.addEventListener('DOMContentLoaded', function () {
    $('utm-go').addEventListener('click', run);
    $('utm-url').addEventListener('keydown', function (e) { if (e.key === 'Enter') run(); });
    try { var saved = localStorage.getItem('podp:utm'); if (saved) $('utm-url').value = saved; } catch (e) { /* нет хранилища */ }
    $('utm-url').addEventListener('change', function () {
      try { localStorage.setItem('podp:utm', normalize($('utm-url').value) || ''); } catch (e) { /* нет хранилища */ }
    });
  });
})();
