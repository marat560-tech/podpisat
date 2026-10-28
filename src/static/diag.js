/* подписатьэцп.рф — диагностика: почему не работает подпись.
 * Проверяет по цепочке: браузер → расширение и Рутокен Плагин → Рутокен вставлен → сертификаты и ключи
 * → КриптоПро. Всё в браузере, ничего никуда не отправляется. В конце — понятный вывод и отчёт для поддержки.
 * Регион (Татарстан или нет) берём из сертификата: от него зависит, что предлагаем сделать на месте.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var U = window.ESign && ESign.util;
  var esc = window.ESign ? ESign.esc : function (s) { return String(s); };
  var DAY = 864e5, SOON_DAYS = 30;
  var RT_EXT = 'https://chromewebstore.google.com/detail/ohedcglhbbfdgaogjhcclacoccbagkjg';
  var RT_PLUGIN = 'https://www.rutoken.ru/support/download/rutoken-plugin/';
  var CP_PLUGIN = 'https://www.cryptopro.ru/products/cades/plugin';
  var CP_EXT = 'https://chromewebstore.google.com/detail/iifchhfnnmpdbibifmljnfjhpififfog';
  var run = 0;
  var CP_OFF = 'Не найден: не установлен или выключено расширение CryptoPro Extension.';
  var CP_FIX = 'Нужен, если подпись на обычном Рутокене (не ЭЦП 3.0), флешке или записана на компьютере. Проверьте, что расширение CryptoPro Extension включено (меню браузера → «Расширения»), или установите <a href="' + CP_PLUGIN + '" target="_blank" rel="noopener">КриптоПро ЭЦП Browser plug-in</a> и расширение <a href="' + CP_EXT + '" target="_blank" rel="noopener">CryptoPro Extension</a>. Затем обновите страницу.';
  var rtLoad = null;          // Рутокен Плагин подключаем один раз на страницу — повторная загрузка может зависнуть
  var needReload = false;     // расширение/плагин ставили после открытия страницы — поможет только перезагрузка

  function loadRutoken() {
    if (rtLoad) return rtLoad;
    var chromium = !!window.chrome || /Chrome\/|Chromium|Firefox|YaBrowser|Edg\//.test(navigator.userAgent);
    var fail = function (code) { var e = new Error(code); e.code = code; throw e; };
    rtLoad = U.withTimeout(rutoken.ready, 8000).then(function () {
      return chromium ? U.withTimeout(Promise.resolve(rutoken.isExtensionInstalled()), 8000) : true;
    }).then(function (ext) {
      if (!ext) fail('noext');
      return U.withTimeout(Promise.resolve(rutoken.isPluginInstalled()), 8000);
    }).then(function (inst) {
      if (!inst) fail('noplugin');
      return U.withTimeout(Promise.resolve(rutoken.loadPlugin()), 15000);
    }).then(function (plugin) {
      return { plugin: plugin, p: U.promisifyPlugin(plugin), chromium: chromium };
    });
    rtLoad.catch(function (e) {
      if (e && (e.code === 'noext' || e.code === 'noplugin')) needReload = true;
      rtLoad = null;          // в следующий раз попробуем снова (после перезагрузки)
    });
    return rtLoad;
  }

  // ---------------------------------------------------------------- браузер
  function browserInfo() {
    var ua = navigator.userAgent, m;
    var mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
    var name = 'Неизвестный браузер', ver = 0, ok = true;
    if ((m = /YaBrowser\/(\d+)/.exec(ua))) { name = 'Яндекс Браузер'; ver = +m[1]; }
    else if ((m = /Edg\/(\d+)/.exec(ua))) { name = 'Microsoft Edge'; ver = +m[1]; }
    else if ((m = /OPR\/(\d+)/.exec(ua))) { name = 'Opera'; ver = +m[1]; }
    else if ((m = /Firefox\/(\d+)/.exec(ua))) { name = 'Firefox'; ver = +m[1]; }
    else if ((m = /Chrome\/(\d+)/.exec(ua))) { name = 'Google Chrome'; ver = +m[1]; }
    else if ((m = /Version\/(\d+).*Safari/.exec(ua))) { name = 'Safari'; ver = +m[1]; ok = false; }
    var os = /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) && !mobile ? 'macOS' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : 'неизвестная система';
    var old = (name === 'Google Chrome' || name === 'Microsoft Edge' || name === 'Яндекс Браузер' || name === 'Opera') && ver && ver < 100 ||
      name === 'Firefox' && ver && ver < 100;
    return { name: name, ver: ver, os: os, mobile: mobile, ok: ok && !mobile, old: old };
  }

  // ---------------------------------------------------------------- сертификаты
  function daysLeft(to) { return Math.floor((new Date(to) - Date.now()) / DAY); }
  function fromFns(issuer) { return /налогов|ФНС/i.test(issuer || ''); }
  function regionOf(c) {
    var text = (c.region || '') + ' ' + (c.locality || '');
    if (/татарстан|казань|набережные челны|альметьевск|нижнекамск|елабуга|зеленодольск/i.test(text) || /^\s*16\b/.test(c.region || '')) return 'tatarstan';
    var inn = String(c.innLe || c.inn || '');
    if (/^\d{10}(\d{2})?$/.test(inn)) return inn.slice(0, 2) === '16' ? 'tatarstan' : 'other';
    return c.region ? 'other' : '';
  }

  function rtCerts(p) {
    var list = [], devices = [];
    return p.enumerateDevices().then(function (ids) {
      return ids.reduce(function (chain, dev) {
        return chain.then(function () {
          var d = { id: dev, label: '', model: '', serial: '' };
          devices.push(d);
          var info = function (k, f) { return typeof p[k] === 'undefined' ? Promise.resolve() : p.getDeviceInfo(dev, p[k]).then(function (v) { d[f] = String(v); }, function () {}); };
          return info('TOKEN_INFO_LABEL', 'label').then(function () { return info('TOKEN_INFO_MODEL', 'model'); }).then(function () { return info('TOKEN_INFO_SERIAL', 'serial'); })
            .then(function () { return p.enumerateCertificates(dev, p.CERT_CATEGORY_USER); })
            .then(function (certIds) {
              return certIds.reduce(function (c2, id) {
                return c2.then(function () {
                  return p.parseCertificate(dev, id).then(function (info) {
                    var s = {}, i = {};
                    (info.subject || []).forEach(function (x) { s[x.rdn] = x.value; });
                    (info.issuer || []).forEach(function (x) { i[x.rdn] = x.value; });
                    var c = { src: 'Рутокен', device: d, person: U.personName(s.surname, s.givenName, s.commonName), org: s.organizationName || '',
                      inn: s.INN || s['1.2.643.3.131.1.1'] || '', innLe: s.INNLE || s['1.2.643.100.4'] || '',
                      region: s.stateOrProvinceName || '', locality: s.localityName || '',
                      issuer: i.commonName || i.organizationName || '', validTo: info.validNotAfter, hasKey: null };
                    list.push(c);
                    if (typeof p.getKeyByCertificate !== 'function') return;
                    return p.getKeyByCertificate(dev, id).then(function (k) { c.hasKey = !!k; }, function () { c.hasKey = false; });
                  });
                });
              }, Promise.resolve());
            }).catch(function () {});
        });
      }, Promise.resolve());
    }).then(function () { return { devices: devices, certs: list }; });
  }

  function cpCerts() {
    var c = window.cadesplugin, list = [];
    return c.CreateObjectAsync('CAdESCOM.Store').then(function (store) {
      return store.Open(c.CAPICOM_CURRENT_USER_STORE, c.CAPICOM_MY_STORE, c.CAPICOM_STORE_OPEN_MAXIMUM_ALLOWED)
        .then(function () { return store.Certificates; })
        .then(function (certs) {
          return certs.Count.then(function (n) {
            var chain = Promise.resolve();
            for (var k = 1; k <= n; k++) (function (k) {
              chain = chain.then(function () {
                return certs.Item(k).then(function (cert) {
                  return Promise.all([cert.SubjectName, cert.ValidToDate, cert.HasPrivateKey(), cert.IssuerName]).then(function (v) {
                    var dn = U.parseDn(v[0]), idn = U.parseDn(v[3]);
                    list.push({ src: 'КриптоПро', person: U.personName(dn.SN, dn.G, dn.CN), org: dn.O || '',
                      inn: dn['ИНН'] || dn.INN || '', innLe: dn['ИНН ЮЛ'] || dn.INNLE || '', region: dn.S || '', locality: dn.L || '',
                      issuer: idn.CN || idn.O || '', validTo: v[1], hasKey: !!v[2] });
                  });
                }).catch(function () {});
              });
            })(k);
            return chain;
          });
        })
        .then(function () { return store.Close(); });
    }).then(function () { return list; });
  }

  // ---------------------------------------------------------------- проверки
  // Каждая проверка: { title, state: ok|warn|err|skip|wait, text, fix }
  function Check(title) { this.title = title; this.state = 'wait'; this.text = 'Проверяем…'; this.fix = ''; }

  function render(r) {
    var icon = { ok: '✓', warn: '!', err: '✕', skip: '–', wait: '…' };
    $('diag-list').innerHTML = r.checks.map(function (c) {
      return '<li class="dg ' + c.state + '"><span class="dg-ico">' + icon[c.state] + '</span><div><b>' + esc(c.title) + '</b>' +
        '<div class="dg-text">' + c.text + '</div>' + (c.fix ? '<div class="dg-fix">' + c.fix + '</div>' : '') + '</div></li>';
    }).join('');
  }

  function certLine(c) {
    var d = c.validTo ? daysLeft(c.validTo) : null;
    var when = c.validTo ? (d < 0 ? 'истёк ' : 'до ') + new Date(c.validTo).toLocaleDateString('ru-RU') + (d >= 0 ? ' (осталось ' + d + ' дн.)' : '') : '';
    return '<b>' + esc(c.person || 'Сертификат') + '</b>' + (c.org && c.org !== c.person ? ', ' + esc(c.org) : '') + ' — ' + esc(when) +
      (c.hasKey === false ? ' · <b>нет закрытого ключа</b>' : '') + '<span class="muted"> · ' + esc(c.src) + (c.issuer ? ', выдал ' + esc(c.issuer) : '') + '</span>';
  }

  function check() {
    var my = ++run;
    var r = { at: new Date(), browser: browserInfo(), checks: [], certs: [], devices: [], rt: null, cp: null };
    var cB = new Check('Браузер'), cExt = new Check('Расширение «Адаптер Рутокен Плагин»'), cRt = new Check('Рутокен Плагин'),
      cDev = new Check('Рутокен вставлен'), cCp = new Check('КриптоПро ЭЦП Browser plug-in'), cCert = new Check('Подписи (сертификаты)');
    r.checks = [cB, cExt, cRt, cDev, cCp, cCert];
    $('diag-go').disabled = true;
    $('diag-verdict').innerHTML = '<div class="note wait">Проверяем… Если появится окно с вопросом о доступе — нажмите «Да» или «Разрешить». Оно может спрятаться за браузером.</div>';
    $('diag-offer').innerHTML = '';
    render(r);

    // 1. Браузер
    var b = r.browser;
    cB.text = esc(b.name + (b.ver ? ' ' + b.ver : '') + ', ' + b.os);
    if (b.mobile) { cB.state = 'err'; cB.fix = 'На телефоне и планшете подписать нельзя: плагины для подписи работают только на компьютере. Откройте сайт на компьютере с Windows, macOS или Linux.'; }
    else if (!b.ok) { cB.state = 'warn'; cB.fix = 'В этом браузере работа с подписью не проверялась. Надёжнее открыть сайт в Google Chrome, Яндекс Браузере или Microsoft Edge.'; }
    else if (b.old) { cB.state = 'warn'; cB.fix = 'Браузер устарел — обновите его, иначе плагины могут не работать.'; }
    else cB.state = 'ok';
    render(r);
    if (b.mobile) {
      // на телефоне плагинов не бывает — остальное не проверяем, чтобы не пугать лишними ошибками
      [cExt, cRt, cDev, cCp, cCert].forEach(function (c) { c.state = 'skip'; c.text = 'Не проверяли — нужен компьютер.'; });
      render(r);
      $('diag-verdict').innerHTML = '<div class="note err"><b>Подписать с телефона не получится.</b> Откройте этот сайт на компьютере с Windows, macOS или Linux и вставьте ключ.</div>';
      $('diag-report-text').textContent = reportText(r);
      $('diag-report').hidden = false;
      $('diag-go').disabled = false;
      return;
    }

    // 2–4. Рутокен
    var rtDone = (function () {
      if (!window.rutoken || !U) {
        cExt.state = cRt.state = 'err'; cExt.text = cRt.text = 'Не удалось загрузить модуль проверки.'; cDev.state = 'skip'; cDev.text = 'Не проверяли.';
        return Promise.resolve();
      }
      return loadRutoken().then(function (x) {
        var plugin = x.plugin;
        cExt.state = 'ok'; cExt.text = x.chromium ? 'Установлено.' : 'Для этого браузера не нужно.';
        var p = r.rt = x.p;
        cRt.state = 'ok'; cRt.text = 'Установлен' + (plugin.version ? ', версия ' + esc(plugin.version) : '') + '.';
        if (typeof plugin.DATA_FORMAT_BASE64 === 'undefined') { cRt.state = 'warn'; cRt.fix = 'Версия устарела — <a href="' + RT_PLUGIN + '" target="_blank" rel="noopener">обновите Рутокен Плагин</a>.'; }
        render(r);
        return U.withTimeout(rtCerts(p), 20000).then(function (x) {
          r.devices = x.devices; r.certs = r.certs.concat(x.certs);
          if (!x.devices.length) {
            cDev.state = 'err'; cDev.text = 'Рутокен не найден.';
            cDev.fix = 'Вставьте Рутокен в USB-разъём (лучше прямо в компьютер, не через удлинитель) и нажмите «Проверить ещё раз». Если на нём не загорается лампочка — попробуйте другой разъём.';
          } else {
            cDev.state = 'ok';
            cDev.text = x.devices.map(function (d) { return esc([d.model || d.label || 'Рутокен', d.serial ? '№ ' + d.serial : ''].filter(Boolean).join(', ')); }).join('<br>');
          }
        }, function (e) {
          cDev.state = 'err'; cDev.text = e && e.message === 'timeout' ? 'Рутокен Плагин не ответил за 20 секунд.' : 'Ошибка: ' + esc(e && e.message || e);
          cDev.fix = 'Проверьте, нет ли окна плагина с вопросом о доступе (может прятаться за браузером). Переподключите Рутокен и нажмите «Проверить ещё раз».';
        });
      }).catch(function (e) {
        var m = e && e.message;
        if (m === 'noext') {
          cExt.state = 'err'; cExt.text = 'Не установлено.';
          cExt.fix = '<a href="' + RT_EXT + '" target="_blank" rel="noopener">Установить расширение</a> (бесплатно, из магазина расширений), затем нажмите «Обновить страницу».';
        } else if (m === 'noplugin') { cExt.state = 'ok'; cExt.text = 'Установлено.'; }
        else if (cExt.state === 'wait') { cExt.state = 'skip'; cExt.text = 'Не удалось проверить — модуль Рутокена не ответил.'; }
        if (m === 'noplugin') {
          cRt.state = 'err'; cRt.text = 'Не установлен.';
          cRt.fix = '<a href="' + RT_PLUGIN + '" target="_blank" rel="noopener">Скачать Рутокен Плагин</a>, установить, закрыть и снова открыть браузер.';
        }
        if (m === 'timeout') { cRt.state = 'err'; cRt.text = 'Рутокен Плагин не ответил.'; cRt.fix = 'Обновите страницу. Если не помогло — закройте и снова откройте браузер или переустановите Рутокен Плагин.'; needReload = true; }
        if (cRt.state === 'wait') { cRt.state = 'skip'; cRt.text = 'Не проверяли — сначала расширение.'; }
        if (m !== 'noext' && m !== 'noplugin' && m !== 'timeout' && cRt.state !== 'err') { cRt.state = 'err'; cRt.text = 'Ошибка: ' + esc(m || e); }
        cDev.state = 'skip'; cDev.text = 'Не проверяли — нужен Рутокен Плагин.';
      });
    })();

    // 5. КриптоПро
    var cpDone = (function () {
      if (!window.cadesplugin) { cCp.state = 'skip'; cCp.text = CP_OFF; cCp.fix = CP_FIX; r.cpMissing = true; return Promise.resolve(); }
      return U.withTimeout(Promise.resolve(window.cadesplugin), 10000).then(function () {
        return cadesplugin.CreateObjectAsync('CAdESCOM.About');
      }).then(function (about) {
        return Promise.all([
          about.PluginVersion.then(function (v) { return v.toString(); }).catch(function () { return ''; }),
          about.CSPVersion('', 80).then(function (v) { return v.toString(); }).catch(function () { return ''; })
        ]);
      }).then(function (v) {
        r.cp = { plugin: v[0], csp: v[1] };
        cCp.state = 'ok';
        cCp.text = 'Установлен' + (v[0] ? ', версия ' + esc(v[0]) : '') + (v[1] ? '. КриптоПро CSP ' + esc(v[1]) : '. КриптоПро CSP не найден') + '.';
        if (!v[1]) { cCp.state = 'warn'; cCp.fix = 'Плагин есть, но КриптоПро CSP не установлен — подписи КриптоПро работать не будут. Для Рутокена из налоговой он не нужен.'; }
        render(r);
        return U.withTimeout(cpCerts(), 30000).then(function (l) { r.certs = r.certs.concat(l); }, function () {
          cCp.state = 'warn'; cCp.fix = 'КриптоПро долго не отвечает: скорее всего, открыто окно «Подтверждение доступа» за браузером. Нажмите в нём «Да» и проверьте ещё раз.';
        });
      }).catch(function () {
        cCp.state = 'skip'; cCp.text = CP_OFF; cCp.fix = CP_FIX; r.cpMissing = true;
      });
    })();

    // 6. Сертификаты — когда оба плагина ответили
    Promise.all([rtDone, cpDone]).then(function () {
      if (my !== run) return;
      var certs = r.certs;
      if (!certs.length) {
        var noPlug = cRt.state !== 'ok' && cCp.state !== 'ok' && cCp.state !== 'warn';
        cCert.state = 'err';
        if (noPlug) {
          // ни одного плагина: какой нужен — зависит от ключа, не отправляем всех ставить Рутокен
          r.noPlugins = true;
          cCert.text = 'Не найден ни один плагин для подписи — подписи не видно.';
          cCert.fix = 'Какой плагин нужен, зависит от ключа. <b>Рутокен ЭЦП 3.0 из налоговой</b> — Рутокен Плагин и расширение «Адаптер Рутокен Плагин». ' +
            '<b>Обычный Рутокен, флешка или ключ на компьютере</b> — КриптоПро ЭЦП Browser plug-in и расширение CryptoPro Extension. ' +
            'Если нужное уже установлено — проверьте, что расширение включено (меню браузера → «Расширения»), и обновите страницу.';
        } else {
          cCert.text = 'Подписей не найдено.';
          var tips = [cDev.state === 'ok' ? 'Рутокен вставлен, но подписей для Рутокен Плагина на нём нет.' : 'Вставьте ключ с подписью и нажмите «Проверить ещё раз».'];
          if (r.cpMissing) {
            tips.push('Если подпись на обычном Рутокене, флешке или записана на компьютере — она работает через КриптоПро, а плагин КриптоПро сейчас не найден или выключен. Включите расширение CryptoPro Extension (меню браузера → «Расширения») и обновите страницу.');
            cCp.state = 'warn';
            // Рутокен не вставлен — хватит «Проверить ещё раз»; а включённое расширение КриптоПро без перезагрузки не подхватится
            if (cDev.state !== 'err') needReload = true;
          } else tips.push('Возможно, это не тот ключ или подпись записана на другой носитель.');
          cCert.fix = tips.join(' ');
        }
      } else {
        certs.forEach(function (c) { c.days = c.validTo ? daysLeft(c.validTo) : null; c.reg = regionOf(c); });
        var bad = certs.filter(function (c) { return c.days !== null && c.days < 0 || c.hasKey === false; });
        var soon = certs.filter(function (c) { return c.days !== null && c.days >= 0 && c.days <= SOON_DAYS && c.hasKey !== false; });
        var good = certs.filter(function (c) { return (c.days === null || c.days > SOON_DAYS) && c.hasKey !== false; });
        cCert.state = good.length ? (soon.length || bad.length ? 'warn' : 'ok') : soon.length ? 'warn' : 'err';
        cCert.text = certs.map(certLine).join('<br>');
        var fixes = [];
        if (bad.some(function (c) { return c.days < 0; })) fixes.push('Есть подпись с истёкшим сроком — ею подписать нельзя.');
        if (bad.some(function (c) { return c.hasKey === false; })) fixes.push('Есть сертификат без закрытого ключа — подписать им нельзя. Обычно это копия сертификата без самого ключа.');
        if (soon.length) fixes.push('Срок подписи скоро закончится.');
        cCert.fix = fixes.join(' ');
      }
      r.done = true;
      render(r);
      verdict(r);
    }).then(done, function (e) { done(); throw e; });
    function done() {
      $('diag-go').disabled = false;
      $('diag-go').textContent = needReload ? 'Обновить страницу' : 'Проверить ещё раз';
      if (needReload) $('diag-verdict').insertAdjacentHTML('beforeend', '<div class="small muted" style="margin-top:6px">Установили или включили расширение или плагин — страницу нужно обновить: кнопка «Обновить страницу» вверху.</div>');
    }
  }

  // ---------------------------------------------------------------- вывод и предложения
  function verdict(r) {
    var errs = r.checks.filter(function (c) { return c.state === 'err'; });
    var warns = r.checks.filter(function (c) { return c.state === 'warn'; });
    var usable = r.certs.filter(function (c) { return (c.days === null || c.days >= 0) && c.hasKey !== false; });
    var html;
    if (usable.length && !errs.some(function (c) { return c.title === 'Браузер'; })) {
      html = '<div class="note ok"><b>Всё готово к подписи.</b> ' + (warns.length ? 'Есть замечания — смотрите отмеченное «!» ниже. ' : '') +
        '<a href="/sign">Подписать файл</a> · <a href="/pdf">PDF со штампом</a></div>';
    } else {
      var first = (r.noPlugins ? r.checks[5] : errs[0]) || warns[0];
      html = '<div class="note err"><b>Подписать пока не получится.</b> ' + (first ? 'Главное: «' + esc(first.title) + '» — ' + (first.fix || first.text) : '') + '</div>';
    }
    $('diag-verdict').innerHTML = html;
    offers(r);
    $('diag-report').hidden = false;
  }

  function offers(r) {
    var box = $('diag-offer'), phone = box.getAttribute('data-phone') || '', tel = box.getAttribute('data-tel') || '';
    var call = '<a class="btn primary sm" href="tel:' + esc(tel) + '">' + esc(phone) + '</a> <a class="btn sm" href="/help4x">Удалённая помощь Help4x</a>';
    var out = [];
    var soon = r.certs.filter(function (c) { return c.days !== null && c.days >= 0 && c.days <= SOON_DAYS && c.hasKey !== false; });
    var expired = r.certs.filter(function (c) { return c.days !== null && c.days < 0; });
    var usable = r.certs.filter(function (c) { return (c.days === null || c.days >= 0) && c.hasKey !== false; });
    var tatarstan = r.certs.some(function (c) { return c.reg === 'tatarstan'; });

    soon.forEach(function (c) {
      out.push('<div class="offer"><b>Подпись заканчивается через ' + c.days + ' дн.</b> (' + esc(c.person ? c.person + ', ' : '') + 'до ' + new Date(c.validTo).toLocaleDateString('ru-RU') + '). ' +
        'Пока она действует, её можно продлить без визита ' + (fromFns(c.issuer) ? 'в налоговую' : 'в удостоверяющий центр') + ' — поможем удалённо. После окончания срока придётся ехать лично.' +
        '<div class="row tight" style="margin-top:8px">' + call + '</div></div>');
    });
    if (expired.length && !usable.length) {
      var c = expired[0];
      out.push('<div class="offer"><b>Срок подписи истёк ' + new Date(c.validTo).toLocaleDateString('ru-RU') + '.</b> ' +
        (fromFns(c.issuer)
          ? 'Удалённо её уже не продлить: нужно лично обратиться в налоговую с паспортом, СНИЛС и Рутокеном. Новую подпись выдадут бесплатно.'
          : 'Удалённо её уже не продлить: обратитесь в удостоверяющий центр, который её выдал' + (c.issuer ? ' (' + esc(c.issuer) + ')' : '') + '.') +
        ' Когда получите — поможем настроить её на компьютере.' +
        (tatarstan ? ' Нужен новый Рутокен ЭЦП 3.0 — есть у нас в Казани.' : '') +
        '<div class="row tight" style="margin-top:8px">' + call + '</div></div>');
    }
    if (!out.length && !usable.length) {
      out.push('<div class="offer"><b>Не получается самостоятельно?</b> Подключимся удалённо и настроим подпись — от 1&nbsp;000&nbsp;₽.' +
        (tatarstan ? ' Если нужен Рутокен ЭЦП 3.0 — есть у нас в Казани.' : '') + '<div class="row tight" style="margin-top:8px">' + call + '</div></div>');
    }
    $('diag-offer').innerHTML = out.join('');
    $('diag-report-text').textContent = reportText(r);
  }

  function reportText(r) {
    var b = r.browser, st = { ok: 'OK', warn: 'ЗАМЕЧАНИЕ', err: 'ОШИБКА', skip: '—', wait: '…' };
    var strip = function (h) { var d = document.createElement('div'); d.innerHTML = h; return d.textContent.trim(); };
    return ['Диагностика подписи — подписатьэцп.рф', 'Время: ' + r.at.toLocaleString('ru-RU'),
      'Браузер: ' + b.name + ' ' + b.ver + ', ' + b.os, 'User-Agent: ' + navigator.userAgent, ''].concat(
      r.checks.map(function (c) { return '[' + st[c.state] + '] ' + c.title + ': ' + strip(c.text.replace(/<br>/g, '; ')) + (c.fix ? ' → ' + strip(c.fix) : ''); })
    ).join('\n');
  }

  document.addEventListener('DOMContentLoaded', function () {
    $('diag-go').addEventListener('click', function () { if (needReload) location.reload(); else check(); });
    $('diag-copy').addEventListener('click', function () {
      navigator.clipboard.writeText($('diag-report-text').textContent).then(function () { $('diag-copy').textContent = 'Скопировано'; }, function () {});
    });
    check();
  });
})();
