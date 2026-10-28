/* Автотесты раздела ЕГАИС: настоящий браузер + тестовый УТМ.
 *
 *   python3 build.py && node tests/egais/run.js
 *
 * Тестовый УТМ отвечает как УТМ 4.2.0: /api/info/list, /opt/out, документы, POST /opt/in/<тип>.
 * Все документы и ФСРАР ID вымышленные. Даты в документах считаются от «сейчас», чтобы
 * проверки лимитов (48 часов, раз в сутки) не зависели от дня запуска.
 * Нужен Playwright: локально — require('playwright') с установленным Chromium,
 * на GitHub — playwright-core и Chrome, который уже стоит на сервере сборки (EGAIS_CHROME_CHANNEL=chrome).
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

let pw;
try { pw = require('playwright'); } catch (e) { pw = require('playwright-core'); }

const ROOT = path.join(__dirname, '..', '..');
const SITE = path.join(ROOT, 'site');
const DOCS = path.join(__dirname, 'docs');
const FSRAR = '030000123456';

let failed = 0, passed = 0;
function check(name, ok, extra) {
  if (ok) { passed++; console.log('  ✓ ' + name); } else { failed++; console.log('  ✗ ' + name + (extra ? '\n      ' + String(extra).slice(0, 600).replace(/\n/g, '\n      ') : '')); }
}

// ---------------------------------------------------------------- даты «от сейчас» в местном времени, как пишет ЕГАИС
const z = (n) => String(n).padStart(2, '0');
function egaisDate(d) { return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate()) + 'T' + z(d.getHours()) + ':' + z(d.getMinutes()) + ':' + z(d.getSeconds()); }
const hoursAgo = (h) => egaisDate(new Date(Date.now() - h * 3600e3));
function todayEarly() { const d = new Date(); d.setHours(0, 0, 30, 0); return egaisDate(d); }

function doc(name, vars) {
  let s = fs.readFileSync(path.join(DOCS, name), 'utf8');
  Object.keys(vars || {}).forEach((k) => { s = s.split('@@' + k + '@@').join(vars[k]); });
  return s;
}
function ticket(o) {
  return doc('ticket.xml', { DATE: o.date, ID: o.id || 'other-' + Math.random().toString(16).slice(2), REG: o.reg || '', TYPE: o.type, RESULT: o.result || 'Rejected', COMMENT: o.comment || '' });
}

// ---------------------------------------------------------------- тестовый УТМ
function startUtm() {
  const utm = { docs: {}, posted: [], delayMs: 0, postError: null, nextId: 1 };
  utm.server = http.createServer((req, res) => {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Private-Network': 'true', 'Access-Control-Allow-Headers': '*' };
    const send = (code, type, body) => { res.writeHead(code, Object.assign({ 'Content-Type': type }, cors)); res.end(body); };
    if (req.method === 'OPTIONS') return send(204, 'text/plain', '');
    const url = req.url.split('?')[0];
    if (req.method === 'GET') {
      if (url === '/api/info/list') return send(200, 'application/json', JSON.stringify({ version: '4.2.0', ownerId: FSRAR, gost: { expireDate: '2027-05-22 10:00:00 +0300' } }));
      if (url.replace(/\/$/, '') === '/opt/out') {
        const base = 'http://' + req.headers.host;
        return send(200, 'application/xml', '<?xml version="1.0" encoding="UTF-8"?><A>' +
          Object.keys(utm.docs).map((p, i) => '<url replyId="r' + i + '">' + base + p + '</url>').join('') + '<ver>2</ver></A>');
      }
      if (utm.docs[url]) return send(200, 'application/xml; charset=utf-8', utm.docs[url]);
      if (url === '/') return send(200, 'text/html', '<html>UTM</html>');
      return send(404, 'text/plain', 'not found');
    }
    if (req.method === 'POST') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const m = /<\?xml[\s\S]*<\/ns:Documents>/.exec(body);
        const field = /name="([^"]+)"/.exec(body);
        utm.posted.push({ path: url, type: url.split('/').pop(), xml: m ? m[0] : '', field: field ? field[1] : '' });
        setTimeout(() => {
          if (res.destroyed) return;
          if (utm.postError) return send(200, 'application/xml', '<?xml version="1.0" encoding="UTF-8"?><A><error>' + utm.postError + '</error><ver>2</ver></A>');
          send(200, 'application/xml', '<?xml version="1.0" encoding="UTF-8" standalone="no"?><A><url>test-' + (utm.nextId++) + '</url><sign>ABC</sign><ver>2</ver></A>');
        }, utm.delayMs);
      });
      return;
    }
    send(405, 'text/plain', '');
  });
  return new Promise((r) => utm.server.listen(0, '127.0.0.1', () => { utm.origin = 'http://localhost:' + utm.server.address().port; r(utm); }));
}

// ---------------------------------------------------------------- сайт из папки site/ (как Caddy: /egais → egais.html)
function startSite() {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
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

// ---------------------------------------------------------------- помощники для страницы
async function openEgais(browser, site, utm, init) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1400 }, locale: 'ru-RU' });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(String(e)));
  if (init) await page.addInitScript(init);
  await page.goto(site.origin + '/egais');
  await page.fill('#utm-url', utm.origin);
  await page.click('#utm-go');
  await page.waitForSelector('#utm-result .checks');
  return page;
}
async function load(page) {
  await page.click('#wb-load');
  await page.waitForFunction(() => !document.getElementById('wb-load').disabled && /Документов|Накладные|Списка/.test(document.getElementById('wb-list').innerText + document.getElementById('wb-status').innerText));
  await page.waitForFunction(() => !document.getElementById('wb-load').disabled);
}
async function confirmDialog(page, yes) {
  await page.waitForSelector('dialog.confirm[open]');
  const text = await page.innerText('dialog.confirm');
  const okText = await page.innerText('dialog.confirm [data-a="1"]');
  await page.click('dialog.confirm [data-a="' + (yes ? 1 : 0) + '"]');
  await page.waitForFunction(() => !document.querySelector('dialog.confirm'));
  return { text, okText };
}
// Отправленный XML разбираем в браузере: он должен быть корректным и с верными пространствами имён
async function xmlInfo(page, xml) {
  return page.evaluate((s) => {
    const d = new DOMParser().parseFromString(s, 'application/xml');
    if (d.getElementsByTagName('parsererror').length) return { ok: false };
    const docEl = d.getElementsByTagNameNS('http://fsrar.ru/WEGAIS/WB_DOC_SINGLE_01', 'Document')[0];
    const inner = docEl && docEl.firstElementChild;
    const t = (ns, n) => { const e = d.getElementsByTagNameNS(ns, n)[0]; return e ? e.textContent : null; };
    return { ok: true, root: d.documentElement.localName, docType: inner && inner.localName, docNs: inner && inner.namespaceURI,
      fsrar: t('http://fsrar.ru/WEGAIS/WB_DOC_SINGLE_01', 'FSRAR_ID'),
      qpName: t('http://fsrar.ru/WEGAIS/QueryParameters', 'Name'), qpValue: t('http://fsrar.ru/WEGAIS/QueryParameters', 'Value'),
      isAccept: t('http://fsrar.ru/WEGAIS/ActTTNSingle_v4', 'IsAccept'), wbRegId: t('http://fsrar.ru/WEGAIS/ActTTNSingle_v4', 'WBRegId'),
      note: t('http://fsrar.ru/WEGAIS/ActTTNSingle_v4', 'Note'), actNumber: t('http://fsrar.ru/WEGAIS/ActTTNSingle_v4', 'ACTNUMBER') };
  }, xml);
}

// ---------------------------------------------------------------- сценарии
async function scenarioCheck(browser, site, utm) {
  console.log('Проверка УТМ');
  utm.docs = {};
  const page = await openEgais(browser, site, utm);
  const t = await page.innerText('#utm-result');
  check('сайт видит УТМ', /Сайт видит УТМ/.test(t), t);
  check('показан ФСРАР ID', t.includes(FSRAR), t);
  check('показана версия УТМ', t.includes('4.2.0'), t);
  check('без ошибок на странице', !page.errors.length, page.errors.join('\n'));
  await page.context().close();
}

async function scenarioWaybills(browser, site, utm) {
  console.log('Накладные: просмотр, отказ, приёмка');
  utm.posted = []; utm.postError = null; utm.delayMs = 0;
  utm.docs = {
    '/opt/out/WayBill_v4/11': doc('wb1.xml'), '/opt/out/FORM2REGINFO/12': doc('reg1.xml'), '/opt/out/WayBill_v4/13': doc('wb2.xml'),
    '/opt/out/ReplyNATTN/15': doc('nattn.xml', { DATE: hoursAgo(1) })
  };
  const page = await openEgais(browser, site, utm);
  await load(page);
  check('в списке две накладные', (await page.locator('.wb').count()) === 2);
  const row = await page.innerText('.wb-row:has-text("ТН-1045")');
  check('сумма накладной посчитана', /2\s?601,50/.test(row), row);
  check('ждёт решения', /Ждёт решения/.test(row), row);
  check('ТН-1045 отмечена в списке ЕГАИС как «есть в УТМ»', (await page.innerText('.nattn')).includes('есть в УТМ'));

  await page.click('.wb-row:has-text("ТН-1045")');
  await page.waitForSelector('[data-act]');
  const body = await page.innerText('.wb-body');
  check('видны позиции и марки', body.includes('Вино столовое') && body.includes('Пиво светлое') && /Итого: позиций 2/.test(body), body);

  // Отказ без причины невозможен; отмена ничего не отправляет
  await page.click('[data-act="0"]');
  await page.waitForSelector('dialog.confirm[open]');
  check('«Отказать» неактивна без причины', await page.isDisabled('dialog.confirm [data-a="1"]'));
  await page.fill('#act-note', 'Товар не поступал');
  check('«Отказать» активна с причиной', !(await page.isDisabled('dialog.confirm [data-a="1"]')));
  await confirmDialog(page, false);
  check('отмена ничего не отправила', utm.posted.length === 0);

  // Приёмка
  await page.click('[data-act="1"]');
  const dlg = await confirmDialog(page, true);
  check('в подтверждении номер, сумма и рег. номер', dlg.text.includes('ТН-1045') && dlg.text.includes('TTN-0011223344') && /2\s?601,50/.test(dlg.text), dlg.text);
  await page.waitForSelector('#wb-status .note.ok');
  check('ушёл ровно один документ WayBillAct_v4', utm.posted.length === 1 && utm.posted[0].type === 'WayBillAct_v4', JSON.stringify(utm.posted.map((p) => p.type)));
  check('поле формы xml_file', utm.posted[0] && utm.posted[0].field === 'xml_file');
  const x = await xmlInfo(page, utm.posted[0] ? utm.posted[0].xml : '');
  check('акт — корректный XML', x.ok && x.root === 'Documents' && x.docType === 'WayBillAct_v4', JSON.stringify(x));
  check('акт: Accepted, нужный WBRegId и ФСРАР ID', x.isAccept === 'Accepted' && x.wbRegId === 'TTN-0011223344' && x.fsrar === FSRAR, JSON.stringify(x));
  check('акт: номер вида P…', /^P\d+$/.test(x.actNumber || ''), JSON.stringify(x));
  check('после отправки кнопок «Принять/Отказать» нет', (await page.locator('[data-act]').count()) === 0);
  check('строка: «Принята, ждём квитанцию»', /Принята, ждём квитанцию/.test(await page.innerText('.wb-row:has-text("ТН-1045")')));

  // Без справки о регистрации принять нельзя
  await page.click('.wb-row:has-text("ТН-1050")');
  await page.waitForTimeout(200);
  check('без справки о регистрации кнопок нет', (await page.locator('[data-act]').count()) === 0 && (await page.innerText('#wb-list')).includes('справка о регистрации'));

  // Перезагрузка страницы: отметка об отправленном акте сохраняется, повторно принять нельзя
  await page.reload();
  await page.fill('#utm-url', utm.origin);
  await load(page);
  await page.click('.wb-row:has-text("ТН-1045")');
  await page.waitForTimeout(200);
  check('после перезагрузки повторно принять нельзя', (await page.locator('[data-act]').count()) === 0 && /Акт отправлен/.test(await page.innerText('.wb-body')));
  check('без ошибок на странице', !page.errors.length, page.errors.join('\n'));
  await page.context().close();
}

async function scenarioTimeout(browser, site, utm) {
  console.log('Акт: УТМ не ответил вовремя');
  utm.posted = []; utm.postError = null; utm.delayMs = 2500;
  utm.docs = { '/opt/out/WayBill_v4/11': doc('wb1.xml'), '/opt/out/FORM2REGINFO/12': doc('reg1.xml') };
  const page = await openEgais(browser, site, utm, 'window.EGAIS_SEND_TIMEOUT = 800;');
  await load(page);
  await page.click('.wb-row:has-text("ТН-1045")');
  await page.click('[data-act="1"]');
  await confirmDialog(page, true);
  await page.waitForSelector('#wb-status .note.err');
  const st = await page.innerText('#wb-status');
  check('предупреждение «неизвестно, ушёл ли акт»', /Неизвестно, ушёл ли акт/.test(st), st);
  check('повторно принять нельзя', (await page.locator('[data-act]').count()) === 0);
  check('ушёл один документ', utm.posted.length === 1);
  check('без ошибок на странице', !page.errors.length, page.errors.join('\n'));
  utm.delayMs = 0;
  await page.context().close();
}

async function scenarioNattn(browser, site, utm) {
  console.log('Неподтверждённые: лимит 48 часов и повторный запрос накладной');
  utm.posted = []; utm.postError = null; utm.delayMs = 0;
  utm.docs = {
    '/opt/out/ReplyNATTN/15': doc('nattn.xml', { DATE: hoursAgo(20) }),
    '/opt/out/Ticket/21': ticket({ date: hoursAgo(10), type: 'QueryNATTN', comment: 'Запрос QueryNATTN можно отправлять не чаще 1 раза в 48 часов' }),
    '/opt/out/Ticket/22': ticket({ date: hoursAgo(9), type: 'QueryResendDoc', reg: 'TTN-0055667788', comment: 'Повторите запрос через некоторое время' }),
    '/opt/out/Ticket/23': ticket({ date: hoursAgo(5), type: 'QueryRestBCode', comment: 'Запрос остатков можно отправлять не чаще 1 раза в 30 минут' })
  };
  const page = await openEgais(browser, site, utm);
  await load(page);
  const note = await page.innerText('#wb-list > .note');
  check('под кнопкой: отказ ЕГАИС по лимиту 48 часов', /ЕГАИС отклонил запрос/.test(note) && /48 часов/.test(note), note);
  check('под кнопкой: когда можно следующий запрос', /Следующий запрос можно после/.test(note), note);
  const nattn = await page.innerText('.nattn');
  check('у накладной: временный отказ повторной отправки', /временный отказ/.test(nattn), nattn);
  await page.click('.tickets summary').catch(() => {});
  const tk = await page.innerText('.tickets');
  check('квитанции по-русски: «Отклонён»', tk.includes('Отклонён') && !/Rejected/.test(tk.replace(/Текст ЕГАИС[^\n]*/g, '')), tk);
  check('чужой запрос остатков помечен «другая программа»', /другая программа/.test(tk), tk);

  await page.click('#wb-nattn');
  const d1 = await confirmDialog(page, true);
  check('в подтверждении предупреждение о лимите', /скорее всего, откажет/.test(d1.text) && d1.okText === 'Всё равно отправить', d1.text + ' | ' + d1.okText);
  await page.waitForSelector('#wb-status .note.ok');
  const q = utm.posted.find((p) => p.type === 'QueryNATTN');
  const qx = await xmlInfo(page, q ? q.xml : '');
  check('QueryNATTN: корректный XML с КОД = ФСРАР ID', qx.ok && qx.docType === 'QueryNATTN' && qx.qpName === 'КОД' && qx.qpValue === FSRAR && qx.fsrar === FSRAR, JSON.stringify(qx));
  check('после отправки: «ответа ЕГАИС пока нет»', /ответа ЕГАИС пока нет/.test(await page.innerText('#wb-list > .note')));
  await page.click('#wb-nattn');
  const d2 = await confirmDialog(page, false);
  check('повторное нажатие предупреждает о неотвеченном запросе', /уже отправили этот запрос/.test(d2.text), d2.text);

  await page.click('[data-resend="1"]');
  await confirmDialog(page, true);
  await page.waitForSelector('#wb-status .note.ok');
  const r = utm.posted.find((p) => p.type === 'QueryResendDoc');
  const rx = await xmlInfo(page, r ? r.xml : '');
  check('QueryResendDoc: WBREGID нужной накладной', rx.ok && rx.qpName === 'WBREGID' && rx.qpValue === 'TTN-0055667788', JSON.stringify(rx));
  check('ушло ровно два запроса', utm.posted.length === 2, JSON.stringify(utm.posted.map((p) => p.type)));
  check('без ошибок на странице', !page.errors.length, page.errors.join('\n'));
  await page.context().close();
}

async function scenarioRests(browser, site, utm) {
  console.log('Остатки: раз в сутки, торговый зал');
  utm.posted = []; utm.delayMs = 0;
  utm.docs = { '/opt/out/ReplyRests_v2/31': doc('rests.xml', { DATE: todayEarly() }) };
  utm.postError = 'От организации ' + FSRAR + ' уже существует документ queryrests_v2 с датой ' + todayEarly().slice(0, 10);
  let page = await openEgais(browser, site, utm);
  await load(page);
  let t = await page.innerText('#rests');
  check('остатки склада показаны', t.includes('Водка "Тест"') && /30,5/.test(t), t);
  check('сегодняшний ответ: «следующий запрос завтра»', /Сегодняшний ответ ЕГАИС уже есть/.test(t), t);
  check('торговый зал — одной строкой с пояснением', /крепкого алкоголя/.test(t) && /Ответа ЕГАИС по залу в УТМ нет/.test(t), t);
  await page.click('[data-rests="stock"]');
  const d = await confirmDialog(page, true);
  check('в подтверждении: сегодня уже запрашивали', /Сегодня остатки склада уже запрашивали/.test(d.text) && d.okText === 'Всё равно отправить', d.text);
  await page.waitForFunction(() => { const n = document.querySelector('#rs-status .note'); return n && !/Отправляем/.test(n.innerText); });
  const s = await page.innerText('#rs-status');
  check('ошибка УТМ «уже существует документ» — понятными словами', /уже запрашивали/.test(s) && /повторите завтра/.test(s), s);
  check('без ошибок на странице', !page.errors.length, page.errors.join('\n'));
  await page.context().close();

  // Старые остатки и торговый зал с товаром; запрос уходит
  utm.posted = []; utm.postError = null;
  utm.docs = { '/opt/out/ReplyRests_v2/31': doc('rests.xml', { DATE: hoursAgo(72) }), '/opt/out/ReplyRestsShop_v2/32': doc('shop.xml', { DATE: hoursAgo(2) }) };
  page = await openEgais(browser, site, utm);
  await load(page);
  t = await page.innerText('#rests');
  check('старый ответ: «больше суток»', /больше суток/.test(t), t);
  check('торговый зал с товаром — таблицей', t.includes('Коньяк "Тест" 5 лет') && /2 наименования/.test(t), t);
  await page.click('[data-rests="stock"]');
  const d2 = await confirmDialog(page, true);
  check('обычное подтверждение без предупреждения', d2.okText === 'Отправить запрос', d2.okText);
  await page.waitForSelector('#rs-status .note.ok');
  const q = utm.posted.find((p) => p.type === 'QueryRests_v2');
  const qx = await xmlInfo(page, q ? q.xml : '');
  check('QueryRests_v2: корректный XML от нужного ФСРАР ID', qx.ok && qx.docType === 'QueryRests_v2' && qx.fsrar === FSRAR, JSON.stringify(qx));
  check('после отправки: «ответа ЕГАИС пока нет»', /ответа ЕГАИС пока нет/.test(await page.innerText('#rests')));
  check('без ошибок на странице', !page.errors.length, page.errors.join('\n'));
  await page.context().close();
}

// ---------------------------------------------------------------- запуск
(async () => {
  if (!fs.existsSync(path.join(SITE, 'egais.html'))) { console.error('Нет site/egais.html — сначала python3 build.py'); process.exit(2); }
  const utm = await startUtm();
  const site = await startSite();
  const opts = process.env.EGAIS_CHROME_CHANNEL ? { channel: process.env.EGAIS_CHROME_CHANNEL } : {};
  const browser = await pw.chromium.launch(opts);
  const scenarios = [scenarioCheck, scenarioWaybills, scenarioTimeout, scenarioNattn, scenarioRests];
  for (const s of scenarios) {
    try { await s(browser, site, utm); } catch (e) { check(s.name + ' — сценарий упал', false, e && e.stack || e); }
  }
  await browser.close();
  utm.server.close(); site.server.close();
  console.log('\nЕГАИС — пройдено: ' + passed + ', не пройдено: ' + failed);
  process.exit(failed ? 1 : 0);
})();
