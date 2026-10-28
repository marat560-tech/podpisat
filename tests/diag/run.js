/* Автотесты страницы «Проверка компьютера» (/diagnostics) в настоящем браузере.
 *
 *   python3 build.py && node tests/diag/run.js
 *
 * Вместо настоящих Рутокен Плагина и КриптоПро — заглушки (подменяем их скрипты на странице),
 * поэтому можно проверить все случаи: ничего не установлено, ключ не вставлен, срок подписи
 * истекает или истёк, регион Татарстан или другой. Все данные вымышленные.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

let pw;
try { pw = require('playwright'); } catch (e) { pw = require('playwright-core'); }

const SITE = path.join(__dirname, '..', '..', 'site');
let failed = 0, passed = 0;
function check(name, ok, extra) {
  if (ok) { passed++; console.log('  ✓ ' + name); } else { failed++; console.log('  ✗ ' + name + (extra ? '\n      ' + String(extra).slice(0, 700).replace(/\n/g, '\n      ') : '')); }
}

function startSite() {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index';
    let f = path.join(SITE, path.normalize(p));
    if (!f.startsWith(SITE)) { res.writeHead(403); return res.end(); }
    if (!fs.existsSync(f) && fs.existsSync(f + '.html')) f += '.html';
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, origin: 'http://127.0.0.1:' + server.address().port })));
}

// ---------------------------------------------------------------- заглушки плагинов (конфиг — window.__RT / window.__CP)
const RT_MOCK = `(function () {
  var cfg = window.__RT || {};
  var DAY = 864e5;
  var loads = 0;
  // список подписей читаем при каждом обращении — тест может «вставить Рутокен» после открытия страницы
  var C = function () { return cfg.devices === 0 ? [] : (cfg.certs || []); };
  // как настоящий плагин через адаптер — «thenable» без .catch
  var T = function (v, err) { return { then: function (ok, bad) { return err ? Promise.reject(v).then(ok, bad) : Promise.resolve(v).then(ok, bad); } }; };
  var plugin = { version: cfg.version || '4.6.0', TOKEN_INFO_LABEL: 1, TOKEN_INFO_MODEL: 2, TOKEN_INFO_SERIAL: 3, CERT_CATEGORY_USER: 1, DATA_FORMAT_BASE64: 2, errorCodes: {},
    enumerateDevices: function () { return T(cfg.devices === 0 ? [] : [0]); },
    getDeviceInfo: function (d, k) { return T(k === 2 ? 'Рутокен ЭЦП 3.0' : k === 3 ? '0123456789' : 'Тест'); },
    enumerateCertificates: function () { return T(C().map(function (c, i) { return 'c' + i; })); },
    parseCertificate: function (d, id) {
      var c = C()[+id.slice(1)];
      var subj = [{ rdn: 'commonName', value: c.cn }, { rdn: 'surname', value: c.cn.split(' ')[0] }, { rdn: 'givenName', value: c.cn.split(' ').slice(1).join(' ') }];
      if (c.org) subj.push({ rdn: 'organizationName', value: c.org });
      if (c.region) subj.push({ rdn: 'stateOrProvinceName', value: c.region });
      if (c.inn) subj.push({ rdn: 'INN', value: c.inn });
      if (c.innLe) subj.push({ rdn: 'INNLE', value: c.innLe });
      return T({ subject: subj, issuer: [{ rdn: 'commonName', value: c.issuer || 'Федеральная налоговая служба' }], serialNumber: '01',
        validNotBefore: new Date(Date.now() - 300 * DAY).toISOString(), validNotAfter: new Date(Date.now() + c.days * DAY + 3600e3).toISOString() });
    },
    getKeyByCertificate: function (d, id) { var c = C()[+id.slice(1)]; return c.noKey ? T(new Error('no key'), true) : T('k' + id); }
  };
  window.rutoken = { ready: Promise.resolve(),
    isExtensionInstalled: function () { return T(cfg.ext !== false); },
    isPluginInstalled: function () { return T(cfg.plugin !== false); },
    // повторное подключение плагина на той же странице не отвечает — как может вести себя настоящий
    loadPlugin: function () { return ++loads > 1 ? new Promise(function () {}) : T(plugin); } };
})();`;

const CP_MOCK = `(function () {
  var cfg = window.__CP;
  if (!cfg) return;                       // КриптоПро не установлен
  var DAY = 864e5, P = function (v) { return Promise.resolve(v); };
  var certs = cfg.certs || [];
  var cp = Promise.resolve();
  cp.CAPICOM_CURRENT_USER_STORE = 2; cp.CAPICOM_MY_STORE = 'My'; cp.CAPICOM_STORE_OPEN_MAXIMUM_ALLOWED = 2;
  cp.CreateObjectAsync = function (name) {
    if (name === 'CAdESCOM.About') return P({ PluginVersion: P({ toString: function () { return '2.0.15000'; } }),
      CSPVersion: function () { return cfg.csp === false ? Promise.reject(new Error('no csp')) : P({ toString: function () { return '5.0.13000'; } }); } });
    if (name === 'CAdESCOM.Store') return P({ Open: function () { return P(); }, Close: function () { return P(); },
      Certificates: P({ Count: P(certs.length), Item: function (i) { var c = certs[i - 1]; return P({
        SubjectName: P('CN=' + c.cn + ', SN=' + c.cn.split(' ')[0] + ', G=' + c.cn.split(' ').slice(1).join(' ') + (c.region ? ', S=' + c.region : '') + (c.inn ? ', ИНН=' + c.inn : '')),
        ValidToDate: P(new Date(Date.now() + c.days * DAY + 3600e3).toISOString()), HasPrivateKey: function () { return P(c.noKey ? false : true); },
        IssuerName: P('CN=' + (c.issuer || 'ООО "Тестовый УЦ"')) }); } }) });
    return Promise.reject(new Error('unknown ' + name));
  };
  window.cadesplugin = cp;
})();`;

async function run(browser, site, name, cfg, ctxOpts) {
  const ctx = await browser.newContext(Object.assign({ viewport: { width: 1280, height: 1200 }, locale: 'ru-RU' }, ctxOpts || {}));
  await ctx.route('**/static/vendor/rutoken.min.js', (r) => r.fulfill({ contentType: 'text/javascript', body: RT_MOCK }));
  await ctx.route('**/static/vendor/cadesplugin_api.js', (r) => r.fulfill({ contentType: 'text/javascript', body: CP_MOCK }));
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(String(e)));
  await page.addInitScript((c) => { window.__RT = c.rt; window.__CP = c.cp; }, cfg);
  await page.goto(site.origin + '/diagnostics');
  await page.waitForFunction(() => !document.getElementById('diag-go').disabled, null, { timeout: 30000 });
  const r = {
    page, verdict: await page.innerText('#diag-verdict'), list: await page.innerText('#diag-list'), offer: await page.innerText('#diag-offer'),
    states: await page.$$eval('#diag-list li.dg', (els) => els.map((e) => e.className.replace('dg ', ''))),
    report: await page.textContent('#diag-report-text')
  };
  if (process.env.DIAG_SHOTS) await page.screenshot({ path: path.join(process.env.DIAG_SHOTS, name.replace(/[^а-яА-Яa-z0-9]+/gi, '_') + '.png'), fullPage: true });
  console.log(name);
  return r;
}

const FNS = 'Федеральная налоговая служба';
const TAT = '16 Республика Татарстан (Татарстан)';

(async () => {
  if (!fs.existsSync(path.join(SITE, 'diagnostics.html'))) { console.error('Нет site/diagnostics.html — сначала python3 build.py'); process.exit(2); }
  const site = await startSite();
  const opts = process.env.EGAIS_CHROME_CHANNEL ? { channel: process.env.EGAIS_CHROME_CHANNEL } : {};
  const browser = await pw.chromium.launch(opts);
  const cases = [
    ['Ничего не установлено', { rt: { ext: false } }, (r) => {
      check('вывод: подписать не получится', /Подписать пока не получится/.test(r.verdict), r.verdict);
      check('главная причина — расширение', /Адаптер Рутокен Плагин/.test(r.verdict), r.verdict);
      check('ссылка на установку расширения', /Установить расширение/.test(r.list), r.list);
      check('предложена удалённая помощь', /Подключимся удалённо/.test(r.offer), r.offer);
      check('без «есть у нас в Казани» — регион неизвестен', !/Казани/.test(r.offer), r.offer);
    }],
    ['Всё в порядке', { rt: { certs: [{ cn: 'Иванов Иван Иванович', org: 'ООО «Ромашка»', days: 200, region: TAT }] } }, (r) => {
      check('вывод: всё готово', /Всё готово к подписи/.test(r.verdict), r.verdict);
      check('показан Рутокен с номером', /Рутокен ЭЦП 3.0, № 0123456789/.test(r.list), r.list);
      check('сертификат: срок и сколько осталось', /Иванов Иван Иванович/.test(r.list) && /осталось 200 дн/.test(r.list), r.list);
      check('предложений нет', r.offer.trim() === '', r.offer);
      check('отчёт для поддержки собран', /\[OK\] Рутокен Плагин/.test(r.report) && /Диагностика подписи/.test(r.report), r.report);
    }],
    ['Срок заканчивается (Татарстан)', { rt: { certs: [{ cn: 'Петров Пётр', days: 12, region: TAT, issuer: FNS }] } }, (r) => {
      check('вывод: готово, но с замечанием', /Всё готово к подписи/.test(r.verdict) && /замечания/.test(r.verdict), r.verdict);
      check('сертификат отмечен «!»', r.states[5] === 'warn', r.states.join(','));
      check('предложение продлить удалённо', /заканчивается через 12 дн/.test(r.offer) && /Петров Пётр, до /.test(r.offer) && /продлить без визита в налоговую/.test(r.offer) && /поможем удалённо/.test(r.offer), r.offer);
    }],
    ['Срок истёк, Москва', { rt: { certs: [{ cn: 'Сидоров Сидор', days: -5, region: '77 г. Москва', inn: '770000000001', issuer: FNS }] } }, (r) => {
      check('вывод: подписать не получится', /Подписать пока не получится/.test(r.verdict), r.verdict);
      check('сертификат отмечен ошибкой', r.states[5] === 'err', r.states.join(','));
      check('удалённо не продлить — лично в налоговую', /Удалённо её уже не продлить/.test(r.offer) && /лично обратиться в налоговую/.test(r.offer), r.offer);
      check('Москве не предлагаем Рутокен в Казани', !/Казани/.test(r.offer), r.offer);
    }],
    ['Срок истёк, Татарстан (по ИНН)', { rt: { certs: [{ cn: 'Галиев Марат', days: -30, innLe: '1655000001', issuer: FNS }] } }, (r) => {
      check('Татарстану предлагаем Рутокен в Казани', /Рутокен ЭЦП 3.0 — есть у нас в Казани/.test(r.offer), r.offer);
    }],
    ['Рутокен не вставлен', { rt: { devices: 0 } }, (r) => {
      check('«Рутокен не найден» с подсказкой', /Рутокен не найден/.test(r.list) && /Вставьте Рутокен/.test(r.list), r.list);
      check('вывод: главное — Рутокен', /Рутокен вставлен/.test(r.verdict), r.verdict);
    }],
    ['Сертификат без ключа', { rt: { certs: [{ cn: 'Копия Сертификата', days: 100, noKey: true }] } }, (r) => {
      check('«нет закрытого ключа»', /нет закрытого ключа/.test(r.list), r.list);
      check('вывод: подписать не получится', /Подписать пока не получится/.test(r.verdict), r.verdict);
    }],
    ['Подпись через КриптоПро, Рутокен Плагина нет', { rt: { plugin: false }, cp: { certs: [{ cn: 'Смирнова Анна', days: 90 }] } }, (r) => {
      check('КриптоПро и CSP найдены', /КриптоПро CSP 5.0.13000/.test(r.list), r.list);
      check('вывод: всё готово (подпись КриптоПро)', /Всё готово к подписи/.test(r.verdict), r.verdict);
      check('Рутокен Плагин — ошибка со ссылкой', /Скачать Рутокен Плагин/.test(r.list), r.list);
    }],
    ['Телефон', { rt: {} }, (r) => {
      check('на телефоне — понятный отказ', /На телефоне и планшете подписать нельзя/.test(r.list), r.list);
      check('браузер отмечен ошибкой', r.states[0] === 'err', r.states.join(','));
      check('остальное на телефоне не проверяем', r.states.slice(1).every((s) => s === 'skip'), r.states.join(','));
      check('вывод: откройте на компьютере', /Подписать с телефона не получится/.test(r.verdict), r.verdict);
      check('на телефоне не предлагаем удалённую помощь', r.offer.trim() === '', r.offer);
    }, { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', viewport: { width: 390, height: 844 } }]
  ];
  // Рутокен вставили после открытия страницы → «Проверить ещё раз» должно его найти без перезагрузки
  try {
    const r = await run(browser, site, 'Рутокен вставили после открытия страницы', { rt: { devices: 0 } });
    check('сначала «Рутокен не найден»', /Рутокен не найден/.test(r.list), r.list);
    check('кнопка — «Проверить ещё раз»', (await r.page.innerText('#diag-go')) === 'Проверить ещё раз');
    await r.page.evaluate(() => { window.__RT.devices = 1; window.__RT.certs = [{ cn: 'Иванов Иван', days: 200 }]; });
    await r.page.click('#diag-go');
    await r.page.waitForFunction(() => /Всё готово|не получится/.test(document.getElementById('diag-verdict').innerText) && !document.getElementById('diag-go').disabled, null, { timeout: 30000 }).catch(() => {});
    const v = await r.page.innerText('#diag-verdict'), l = await r.page.innerText('#diag-list');
    check('после «Проверить ещё раз» Рутокен найден', /Рутокен ЭЦП 3.0/.test(l) && /Иванов Иван/.test(l), l);
    check('вывод: всё готово', /Всё готово к подписи/.test(v), v);
    check('без ошибок на странице', !r.page.errors.length, r.page.errors.join('\n'));
    await r.page.context().close();
  } catch (e) { check('повторная проверка — сценарий упал', false, e && e.stack || e); }

  // Расширение не установлено → кнопка «Обновить страницу» и правда перезагружает
  try {
    const r = await run(browser, site, 'Расширение ставят после открытия страницы', { rt: { ext: false } });
    check('кнопка — «Обновить страницу»', (await r.page.innerText('#diag-go')) === 'Обновить страницу');
    check('подсказка, что нужно обновить страницу', /страницу нужно обновить/.test(r.verdict), r.verdict);
    await Promise.all([r.page.waitForNavigation({ timeout: 10000 }), r.page.click('#diag-go')]);
    check('страница перезагрузилась', /\/diagnostics$/.test(r.page.url()));
    await r.page.context().close();
  } catch (e) { check('кнопка «Обновить страницу» — сценарий упал', false, e && e.stack || e); }

  for (const [name, cfg, assert, ctxOpts] of cases) {
    try {
      const r = await run(browser, site, name, cfg, ctxOpts);
      assert(r);
      check('без ошибок на странице', !r.page.errors.length, r.page.errors.join('\n'));
      if (ctxOpts && ctxOpts.viewport) check('без горизонтальной прокрутки', !(await r.page.evaluate(() => document.documentElement.scrollWidth > innerWidth)));
      await r.page.context().close();
    } catch (e) { check(name + ' — сценарий упал', false, e && e.stack || e); }
  }
  await browser.close();
  site.server.close();
  console.log('\nДиагностика — пройдено: ' + passed + ', не пройдено: ' + failed);
  process.exit(failed ? 1 : 0);
})();
