/* Автотесты подписатьэцп.рф: node tests/run.js
 * Без внешних зависимостей (Node 18+). Проверяют то, что сломать страшнее всего:
 *  - хэш «Стрибог» и параметры кривых ГОСТ;
 *  - проверку подписи CMS: верные, изменённые, поддельные; DER и BER; ключи 256 и 512 бит;
 *  - подпись PDF дописыванием: разные виды PDF, повторная подпись, обнаружение изменений.
 * Тестовые ключи и подписи создаёт библиотека из tests/vendor (только для тестов).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const STATIC = path.join(ROOT, 'src', 'static');
let failed = 0, passed = 0;

function check(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')); }
}

// ---------------------------------------------------------------- загрузка модулей
// Библиотека ГОСТ — в отдельном контексте, как в браузере (глобальные переменные)
const libCtx = { crypto: globalThis.crypto, Uint8Array, ArrayBuffer, DataView, Error, Math, console };
libCtx.window = libCtx;
vm.createContext(libCtx);
for (const f of ['gostRandom', 'gostCipher', 'gostDigest', 'gostSign']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'vendor', f + '.min.js'), 'utf8'), libCtx, { filename: f });
}
// На сайте используется тот же gostDigest — проверяем именно копию сайта
const siteCtx = { crypto: globalThis.crypto, Uint8Array, ArrayBuffer, DataView, Error, Math, console };
siteCtx.window = siteCtx;
vm.createContext(siteCtx);
vm.runInContext(fs.readFileSync(path.join(STATIC, 'vendor', 'gost', 'gostDigest.min.js'), 'utf8'), siteCtx);
globalThis.GostDigest = siteCtx.GostDigest;
require(path.join(STATIC, 'pdfinc.js'));
require(path.join(STATIC, 'cmsverify.js'));
const { PdfInc, CmsVerify } = globalThis;

// ---------------------------------------------------------------- DER для тестовых подписей
const len = n => n < 128 ? [n] : n < 256 ? [0x81, n] : n < 65536 ? [0x82, n >> 8, n & 255] : [0x83, n >> 16, (n >> 8) & 255, n & 255];
const tlv = (t, ...c) => { const b = Buffer.concat(c.map(x => Buffer.from(x))); return Buffer.concat([Buffer.from([t, ...len(b.length)]), b]); };
const ind = (t, ...c) => Buffer.concat([Buffer.from([t, 0x80]), ...c.map(x => Buffer.from(x)), Buffer.from([0, 0])]);
const seq = (...c) => tlv(0x30, ...c), set = (...c) => tlv(0x31, ...c);
const oid = s => {
  const p = s.split('.').map(Number), out = [40 * p[0] + p[1]];
  for (const x of p.slice(2)) { const t = []; let v = x; do { t.unshift(v & 127); v = Math.floor(v / 128); } while (v); for (let i = 0; i < t.length - 1; i++) t[i] |= 128; out.push(...t); }
  return tlv(6, out);
};
const int = b => { b = Buffer.from(b); if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]); return tlv(2, b); };
const utf8 = s => tlv(0x0c, Buffer.from(s, 'utf8')), oct = b => tlv(4, b);
const utc = d => tlv(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z'));
const ctx0 = (...c) => tlv(0xa0, ...c);

const ALG = {
  256: { hash: '1.2.643.7.1.1.2.2', key: '1.2.643.7.1.1.1.1', sig: '1.2.643.7.1.1.3.2' },
  512: { hash: '1.2.643.7.1.1.2.3', key: '1.2.643.7.1.1.1.2', sig: '1.2.643.7.1.1.3.3' }
};

function makeKey(bits, curve, curveOid, cn) {
  // Тестовая библиотека держит общее состояние между объектами: после создания второго ключа
  // первый объект начинает подписывать неверно. Поэтому каждая подпись — свежим объектом.
  const signer = () => new libCtx.GostSign({ name: 'GOST R 34.10', version: 2012, length: bits, namedCurve: curve, procreator: 'CP', hash: 'GOST R 34.11' });
  const k = signer().generateKey();
  const s = { sign: (priv, d) => signer().sign(priv, d) };
  const a = ALG[bits];
  const name = seq(set(seq(oid('2.5.4.3'), utf8(cn))), set(seq(oid('2.5.4.4'), utf8('Иванов'))), set(seq(oid('2.5.4.42'), utf8('Иван Иванович'))));
  const now = Date.now();
  const tbs = seq(tlv(0xa0, int([2])), int([0x01, 0x23, 0x45]), seq(oid(a.sig)), name,
    seq(utc(new Date(now - 864e5)), utc(new Date(now + 365 * 864e5))), name,
    seq(seq(oid(a.key), seq(oid(curveOid), oid(a.hash))), tlv(3, Buffer.concat([Buffer.from([0]), oct(Buffer.from(k.publicKey))]))));
  const sign = d => Buffer.from(s.sign(k.privateKey, new Uint8Array(d)));
  const cert = seq(tbs, seq(oid(a.sig)), tlv(3, Buffer.concat([Buffer.from([0]), sign(tbs)])));
  return { bits, name, cert, sign, a };
}

function digest(bits, data) {
  return Buffer.from(new libCtx.GostDigest({ name: 'GOST R 34.11', version: 2012, length: bits }).digest(new Uint8Array(data)));
}

function makeCms(key, data, opt = {}) {
  const a = key.a;
  const md = opt.badDigest ? Buffer.alloc(key.bits / 8, 7) : digest(key.bits, data);
  const sa = Buffer.concat([
    seq(oid('1.2.840.113549.1.9.3'), set(oid('1.2.840.113549.1.7.1'))),
    seq(oid('1.2.840.113549.1.9.5'), set(utc(new Date()))),
    seq(oid('1.2.840.113549.1.9.4'), set(oct(md)))
  ]);
  const sv = (opt.signer || key).sign(set(sa));
  const si = seq(int([1]), seq(key.name, int([0x01, 0x23, 0x45])), seq(oid(a.hash)), tlv(0xa0, sa), seq(oid(a.key)), oct(sv));
  if (opt.ber) {
    const encap = ind(0x30, oid('1.2.840.113549.1.7.1'), ...(opt.attached ? [ind(0xa0, ind(0x24, oct(data.subarray(0, 3)), oct(data.subarray(3))))] : []));
    return ind(0x30, oid('1.2.840.113549.1.7.2'), ind(0xa0, ind(0x30, int([1]), set(seq(oid(a.hash))), encap, ind(0xa0, key.cert), set(si))));
  }
  const sd = seq(int([1]), set(seq(oid(a.hash))), seq(oid('1.2.840.113549.1.7.1'), ...(opt.attached ? [ctx0(oct(data))] : [])), tlv(0xa0, key.cert), set(si));
  return seq(oid('1.2.840.113549.1.7.2'), ctx0(sd));
}

// ---------------------------------------------------------------- тесты
async function main() {
  console.log('Хэш и кривые');
  const m1 = Buffer.from('012345678901234567890123456789012345678901234567890123456789012');
  check('Стрибог-256 (контрольный пример ГОСТ)', Buffer.from(new globalThis.GostDigest({ name: 'GOST R 34.11', version: 2012, length: 256 }).digest(m1)).toString('hex') === '9d151eefd8590b89daa6ba6cb74af9275dd051026bb149a452fd84e5e57b5500');
  check('Стрибог-512 (контрольный пример ГОСТ)', Buffer.from(new globalThis.GostDigest({ name: 'GOST R 34.11', version: 2012, length: 512 }).digest(m1)).toString('hex').startsWith('1b54d01a4af5b9d5cc3d86d68d285462b19abc2475222f35c085122be4ba1ffa'));
  for (const [n, c] of Object.entries(CmsVerify._curves)) {
    check('кривая ' + n + ': точка на кривой и q·G = 0', CmsVerify._onCurve(c.x, c.y, c) && CmsVerify._jmul([c.x, c.y, 1n], c.q, c)[2] === 0n);
  }

  console.log('Проверка подписи CMS');
  const keys = [
    makeKey(256, 'S-256-A', '1.2.643.2.2.35.1', 'Ключ 256'),
    makeKey(512, 'T-512-A', '1.2.643.7.1.2.1.2.1', 'Ключ 512')
  ];
  const doc = Buffer.from('Тестовый документ для проверки подписи');
  for (const key of keys) {
    const t = ' (' + key.bits + ' бит)';
    let r = await CmsVerify.verify(makeCms(key, doc), doc);
    check('отделённая подпись верна' + t, r.signers[0].ok, JSON.stringify(r.signers[0].problems));
    r = await CmsVerify.verify(makeCms(key, doc, { attached: true }), null);
    check('присоединённая подпись верна' + t, r.signers[0].ok && r.attached && Buffer.from(r.content).equals(doc));
    r = await CmsVerify.verify(makeCms(key, doc, { ber: true, attached: true }), null);
    check('подпись в BER верна' + t, r.signers[0].ok && Buffer.from(r.content).equals(doc));
    const changed = Buffer.from(doc); changed[3] ^= 1;
    r = await CmsVerify.verify(makeCms(key, doc), changed);
    check('изменённый документ обнаружен' + t, !r.signers[0].ok && r.signers[0].integrity === false);
    r = await CmsVerify.verify(makeCms(key, doc, { badDigest: true }), doc);
    check('неверный хэш в подписи обнаружен' + t, !r.signers[0].ok);
    const other = makeKey(key.bits, key.bits === 256 ? 'S-256-A' : 'T-512-A', key.bits === 256 ? '1.2.643.2.2.35.1' : '1.2.643.7.1.2.1.2.1', 'Чужой');
    r = await CmsVerify.verify(makeCms(key, doc, { signer: other }), doc);
    check('подпись чужим ключом отвергнута' + t, !r.signers[0].ok && r.signers[0].mathOk === false);
    const broken = makeCms(key, doc); broken[broken.length - 3] ^= 1;
    r = await CmsVerify.verify(broken, doc);
    check('испорченное значение подписи отвергнуто' + t, !r.signers[0].ok);
  }
  let threw = false;
  try { await CmsVerify.verify(makeCms(keys[0], doc), null); } catch (e) { threw = /отделённая/.test(e.message); }
  check('отделённая подпись без документа — понятная ошибка', threw);

  console.log('Подпись PDF');
  const key = keys[0];
  const img = { w: 4, h: 2, rgb: new Uint8Array(24).fill(90), alpha: new Uint8Array(8).fill(200), key: 's' };
  const fixtures = path.join(__dirname, 'fixtures');
  for (const f of ['plain.pdf', 'objstm.pdf', 'lin.pdf', 'form-indirect.pdf', 'broken.pdf', 'broken2.pdf']) {
    try {
      let bytes = new Uint8Array(fs.readFileSync(path.join(fixtures, f)));
      for (let round = 1; round <= 2; round++) {
        const d = await PdfInc.open(bytes);
        const widgets = d.pages.map((p, i) => ({ page: i, rect: [100, 100 + round * 90, 300, 170 + round * 90], rotate: 0, image: img }));
        const prep = await PdfInc.prepare(d, { widgets, name: 'Иванов Иван' });
        bytes = PdfInc.finish(prep, new Uint8Array(makeCms(key, Buffer.from(PdfInc.signedBytes(prep)))));
      }
      const sigs = PdfInc.findSignatures(bytes);
      const res = [];
      for (const s of sigs) res.push((await CmsVerify.verify(s.cms, s.signed())).signers[0].ok);
      check(f + ': две подписи подряд, обе верны', sigs.length === 2 && res.every(Boolean) && sigs[1].coversWhole && !sigs[0].coversWhole, JSON.stringify(res));
      const reopened = await PdfInc.open(bytes);
      check(f + ': подписанный файл открывается снова, страниц столько же', reopened.pages.length === (await PdfInc.open(new Uint8Array(fs.readFileSync(path.join(fixtures, f))))).pages.length);
      const tampered = new Uint8Array(bytes); tampered[Math.floor(sigs[0].byteRange[1] / 2)] ^= 1;
      const tr = await CmsVerify.verify(PdfInc.findSignatures(tampered)[1].cms, PdfInc.findSignatures(tampered)[1].signed());
      check(f + ': изменение после подписи обнаружено', !tr.signers[0].ok);
    } catch (e) {
      check(f + ': без ошибок', false, e.message);
    }
  }
  let encErr = '';
  try { await PdfInc.open(new Uint8Array(fs.readFileSync(path.join(fixtures, 'enc-nopass.pdf')))); } catch (e) { encErr = e.message; }
  check('зашифрованный PDF: понятный отказ', /защищён/.test(encErr));
  let notPdf = '';
  try { await PdfInc.open(new Uint8Array(Buffer.from('просто текст'))); } catch (e) { notPdf = e.message; }
  check('не PDF: понятный отказ', /не PDF/.test(notPdf));

  console.log('\nПройдено: ' + passed + ', не пройдено: ' + failed);
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
