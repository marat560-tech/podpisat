/* Автотест страницы «подпись второй стороной» (/cosign) в настоящем браузере.
 *
 *   WRITE_COSIGN_FIXTURES=1 node tests/run.js   # один раз — сгенерировать фикстуры
 *   python3 build.py && node tests/cosign/run.js
 *
 * Фикстуры (tests/cosign/fixtures) — настоящие ГОСТ-подписи: документ, подпись контрагента
 * и готовая co-подпись с двумя подписантами. Рутокен подменён заглушкой: на запрос co-подписи
 * она отдаёт готовую co-подпись из фикстуры, и страница проверяет её своим же кодом (CmsVerify).
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

let pw;
try { pw = require('playwright'); } catch (e) { pw = require('playwright-core'); }

const SITE = path.join(__dirname, '..', '..', 'site');
const FX = path.join(__dirname, 'fixtures');
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
    if ((!fs.existsSync(f) || fs.statSync(f).isDirectory()) && fs.existsSync(f + '.html')) f += '.html';
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, origin: 'http://127.0.0.1:' + server.address().port })));
}

// Заглушка Рутокена: на co-подпись (opts.cmsToAdd) отдаёт window.__COSIGNED (base64 готовой co-подписи),
// а в режиме сбоя — window.__BADSIGN (подпись без второго участника).
const RT_MOCK = `(function () {
  var P = function (v) { return Promise.resolve(v); };
  var plugin = { version: '4.6.0', TOKEN_INFO_LABEL: 1, TOKEN_INFO_MODEL: 2, TOKEN_INFO_SERIAL: 3, CERT_CATEGORY_USER: 1, DATA_FORMAT_BASE64: 2, errorCodes: {},
    enumerateDevices: function () { return P([0]); },
    getDeviceInfo: function (d, k) { return P(k === 2 ? 'Рутокен Lite' : k === 3 ? '0246813579' : 'Иванов'); },
    enumerateCertificates: function () { return P(['c1']); },
    parseCertificate: function () { return P({
      subject: [{ rdn: 'commonName', value: 'Иванов Иван (вы)' }, { rdn: 'organizationName', value: 'ООО «Ваша фирма»' }],
      issuer: [{ rdn: 'commonName', value: 'Тестовый УЦ' }],
      serialNumber: '02:46:8a', validNotBefore: new Date(Date.now() - 864e5).toISOString(), validNotAfter: new Date(Date.now() + 300 * 864e5).toISOString() }); },
    login: function (d, pin) { return pin === '12345678' ? P() : Promise.reject(new Error('10')); },
    logout: function () { return P(); },
    sign: function (d, id, data, fmt, opts) { window.__lastOpts = opts; return P(window.__BAD ? window.__BADSIGN : window.__COSIGNED); } };
  window.rutoken = { ready: P(), isExtensionInstalled: function () { return P(true); }, isPluginInstalled: function () { return P(true); }, loadPlugin: function () { return P(plugin); } };
})();`;

function file(name) { return { name, buffer: fs.readFileSync(path.join(FX, name)) }; }

async function openPage(browser, site, bad) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1200 }, locale: 'ru-RU' });
  await ctx.route('**/static/vendor/rutoken.min.js', (r) => r.fulfill({ contentType: 'text/javascript', body: RT_MOCK }));
  await ctx.route('**/static/vendor/cadesplugin_api.js', (r) => r.fulfill({ contentType: 'text/javascript', body: '' }));
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(String(e)));
  await page.addInitScript((d) => { window.__COSIGNED = d.cos; window.__BADSIGN = d.bad; window.__BAD = d.isBad; }, {
    cos: fs.readFileSync(path.join(FX, 'cosigned.sig')).toString('base64'),
    bad: fs.readFileSync(path.join(FX, 'doc.txtSGN1.sig')).toString('base64'),
    isBad: !!bad
  });
  await page.goto(site.origin + '/cosign');
  return page;
}

(async () => {
  if (!fs.existsSync(path.join(SITE, 'cosign.html'))) { console.error('Нет site/cosign.html — сначала python3 build.py'); process.exit(2); }
  if (!fs.existsSync(path.join(FX, 'cosigned.sig'))) { console.error('Нет фикстур — сначала WRITE_COSIGN_FIXTURES=1 node tests/run.js'); process.exit(2); }
  const site = await startSite();
  const opts = process.env.EGAIS_CHROME_CHANNEL ? { channel: process.env.EGAIS_CHROME_CHANNEL } : {};
  const browser = await pw.chromium.launch(opts);

  // 1. Загрузили документ и подпись контрагента → видно, кто подписал
  try {
    const page = await openPage(browser, site);
    await page.setInputFiles('#file', [file('doc.txt'), file('doc.txtSGN1.sig')]);
    await page.waitForSelector('#loaded .checks', { timeout: 20000 });
    const loaded = await page.innerText('#loaded');
    console.log('Загрузка подписи контрагента');
    check('показан документ', loaded.includes('doc.txt'), loaded);
    check('показан подписант контрагента', /Иванов Иван|Петров/.test(loaded), loaded);
    check('подпись контрагента подтверждена (нет пометки о проблеме)', !/не подтвержд/.test(loaded), loaded);

    // кнопка активна после авто-выбора единственной подписи
    await page.waitForFunction(() => !document.getElementById('sign').disabled, null, { timeout: 20000 });
    await page.fill('#pin', '12345678');
    await page.click('#sign');
    await page.waitForSelector('#result:not([hidden])', { timeout: 20000 });
    const title = await page.innerText('#result-title');
    const signers = await page.innerText('#result-signers');
    console.log('Добавление своей подписи');
    check('co-подпись отправлена с опцией cmsToAdd', await page.evaluate(() => !!(window.__lastOpts && window.__lastOpts.cmsToAdd)));
    check('в результате две подписи, все верны', /2 подпис/.test(title) && /верны/.test(title), title);
    check('в списке две подписи', (await page.locator('#result-signers li').count()) === 2, signers);
    check('ваша подпись помечена «вы»', (await page.locator('#result-signers .tag').count()) === 1 && (await page.locator('#result-signers .tag').innerText()).trim() === 'вы', signers);
    check('есть ссылки на скачивание', (await page.locator('#result-main a[download]').count()) === 2);
    check('без ошибок на странице', !page.errors.length, page.errors.join('\n'));
    await page.context().close();
  } catch (e) { check('сценарий «загрузка+подпись» упал', false, e && e.stack || e); }

  // 2. Только документ, без подписи
  try {
    const page = await openPage(browser, site);
    await page.setInputFiles('#file', [file('doc.txt')]);
    await page.waitForSelector('#loaded .note.err', { timeout: 20000 });
    console.log('Нет файла подписи');
    check('просит добавить файл подписи', /Не нашли файл подписи/.test(await page.innerText('#loaded')));
    await page.context().close();
  } catch (e) { check('сценарий «нет подписи» упал', false, e && e.stack || e); }

  // 3. Плагин собрал подпись неверно (без второго участника) → честная ошибка, файла не даём
  try {
    const page = await openPage(browser, site, true);
    await page.setInputFiles('#file', [file('doc.txt'), file('doc.txtSGN1.sig')]);
    await page.waitForFunction(() => !document.getElementById('sign').disabled, null, { timeout: 20000 });
    await page.fill('#pin', '12345678');
    await page.click('#sign');
    await page.waitForSelector('#status .note.err', { timeout: 20000 });
    console.log('Плагин не добавил вторую подпись');
    check('честная ошибка вместо битого файла', /не смог добавить подпись/.test(await page.innerText('#status')));
    check('результат не показан', await page.locator('#result[hidden]').count() === 1);
    await page.context().close();
  } catch (e) { check('сценарий «сбой плагина» упал', false, e && e.stack || e); }

  await browser.close();
  site.server.close();
  console.log('\nПодпись второй стороной — пройдено: ' + passed + ', не пройдено: ' + failed);
  process.exit(failed ? 1 : 0);
})();
