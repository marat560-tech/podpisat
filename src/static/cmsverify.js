/* подписатьэцп.рф — проверка подписи CMS (ГОСТ Р 34.10-2012) прямо в браузере, без плагинов.
 * Хэш ГОСТ Р 34.11-2012 «Стрибог» — библиотека GostDigest (Р. Николаев, Apache-2.0).
 *
 * CmsVerify.verify(cmsBytes, contentBytes|null) -> Promise<{signers: [...], attached: bool, content}>
 * CmsVerify.parseCert(der) -> сведения о сертификате
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------- ASN.1 DER
  function Node(b, start, tag, hl, len) {
    this.b = b; this.start = start; this.tag = tag; this.hl = hl; this.len = len;
  }
  Node.prototype.end = function () { return this.start + this.hl + this.len; };
  Node.prototype.der = function () { return this.b.subarray(this.start, this.end()); };
  Node.prototype.val = function () { return this.b.subarray(this.start + this.hl, this.end()); };
  Node.prototype.cls = function () { return this.tag >> 6; };
  Node.prototype.constructed = function () { return !!(this.tag & 0x20); };
  Node.prototype.kids = function () {
    if (this._kids) return this._kids;
    var out = [], p = this.start + this.hl, e = this.end();
    while (p < e) { var n = parse(this.b, p); out.push(n); p = n.end(); }
    return (this._kids = out);
  };
  Node.prototype.kid = function (i) { return this.kids()[i]; };

  function parse(b, p) {
    if (p + 2 > b.length) throw new Error('ASN.1: неожиданный конец данных');
    var start = p, tag = b[p++];
    if ((tag & 0x1f) === 0x1f) { while (b[p++] & 0x80); } // длинные теги не нужны, пропускаем
    var len = b[p++];
    if (len === 0x80) { // неопределённая длина (BER) — найдём 00 00
      var n = new Node(b, start, tag, p - start, 0), q = p;
      while (!(b[q] === 0 && b[q + 1] === 0)) { var k = parse(b, q); q = k.end(); }
      n.len = q - p + 2;
      n.indef = true;
      return n;
    }
    if (len & 0x80) {
      var nb = len & 0x7f; len = 0;
      for (var i = 0; i < nb; i++) len = len * 256 + b[p++];
    }
    if (p + len > b.length) throw new Error('ASN.1: длина больше данных');
    return new Node(b, start, tag, p - start, len);
  }

  // Для BER с неопределённой длиной содержимое надо читать без завершающих 00 00
  Node.prototype.content = function () {
    if (this.indef) return this.b.subarray(this.start + this.hl, this.end() - 2);
    return this.val();
  };
  var _kids = Node.prototype.kids;
  Node.prototype.kids = function () {
    if (this._kids) return this._kids;
    if (!this.indef) return _kids.call(this);
    var out = [], p = this.start + this.hl, e = this.end() - 2;
    while (p < e) { var n = parse(this.b, p); out.push(n); p = n.end(); }
    return (this._kids = out);
  };

  function oid(n) {
    var v = n.val(), out = [], x = 0;
    for (var i = 0; i < v.length; i++) {
      x = x * 128 + (v[i] & 0x7f);
      if (!(v[i] & 0x80)) {
        if (!out.length) { var f = Math.min(2, Math.floor(x / 40)); out.push(f, x - f * 40); }
        else out.push(x);
        x = 0;
      }
    }
    return out.join('.');
  }

  // Содержимое OCTET STRING (в BER может быть составным)
  function octets(n) {
    if (!n.constructed()) return n.val();
    var parts = n.kids().map(octets), len = 0;
    parts.forEach(function (p) { len += p.length; });
    var out = new Uint8Array(len), off = 0;
    parts.forEach(function (p) { out.set(p, off); off += p.length; });
    return out;
  }

  function str(n) {
    var v = n.val();
    switch (n.tag) {
      case 0x0c: return new TextDecoder('utf-8').decode(v);           // UTF8String
      case 0x1e: var s = ''; for (var i = 0; i + 1 < v.length; i += 2) s += String.fromCharCode(v[i] << 8 | v[i + 1]); return s; // BMPString
      default: return new TextDecoder('latin1').decode(v);           // Printable, IA5, Numeric
    }
  }

  function time(n) {
    var s = new TextDecoder('latin1').decode(n.val());
    var m = n.tag === 0x17
      ? /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?Z$/.exec(s)
      : /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?(?:\.\d+)?Z$/.exec(s);
    if (!m) return null;
    var y = +m[1];
    if (n.tag === 0x17) y += y < 50 ? 2000 : 1900;
    return new Date(Date.UTC(y, +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)));
  }

  function hex(b) {
    var s = '';
    for (var i = 0; i < b.length; i++) s += ('0' + b[i].toString(16)).slice(-2);
    return s;
  }

  function eq(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  // ---------------------------------------------------------------- сертификат
  var DN = {
    '2.5.4.3': 'CN', '2.5.4.4': 'SN', '2.5.4.42': 'G', '2.5.4.10': 'O', '2.5.4.11': 'OU', '2.5.4.12': 'T',
    '2.5.4.6': 'C', '2.5.4.7': 'L', '2.5.4.8': 'S', '2.5.4.9': 'STREET', '1.2.840.113549.1.9.1': 'E',
    '1.2.643.3.131.1.1': 'INN', '1.2.643.100.4': 'INNLE', '1.2.643.100.1': 'OGRN', '1.2.643.100.5': 'OGRNIP',
    '1.2.643.100.3': 'SNILS'
  };

  function name(n) {
    var out = {}, list = [];
    n.kids().forEach(function (rdn) {
      rdn.kids().forEach(function (atv) {
        var k = DN[oid(atv.kid(0))] || oid(atv.kid(0)), v = str(atv.kid(1));
        if (!(k in out)) out[k] = v;
        list.push(k + '=' + v);
      });
    });
    out._text = list.join(', ');
    return out;
  }

  function parseCert(der) {
    var c = der instanceof Node ? der : parse(der, 0);
    var tbs = c.kid(0), k = tbs.kids(), i = 0;
    if (k[0].tag === 0xa0) i++; // версия
    var serial = k[i++].val(), sigAlg = oid(k[i++].kid(0)), issuer = k[i++], validity = k[i++], subject = k[i++], spki = k[i++];
    var ext = {};
    for (; i < k.length; i++) {
      if (k[i].tag === 0xa3) {
        k[i].kid(0).kids().forEach(function (e) {
          var id = oid(e.kid(0)), val = e.kid(e.kids().length - 1);
          ext[id] = val.val();
        });
      }
    }
    var alg = spki.kid(0), params = alg.kids()[1];
    var curve = null;
    if (params && params.tag === 0x30) curve = oid(params.kid(0));
    var keyBits = spki.kid(1).val().subarray(1); // BIT STRING без байта «неиспользованных бит»
    var keyOct = parse(keyBits, 0).val();       // внутри — OCTET STRING с x||y (little-endian)
    var sn = '';
    for (var j = 0; j < serial.length; j++) sn += ('0' + serial[j].toString(16)).slice(-2);
    sn = sn.replace(/^(00)+(?=..)/, '').toUpperCase();
    return {
      der: c.der(), tbs: tbs.der(), sigAlg: sigAlg, signature: c.kid(2).val().subarray(1),
      serial: sn, serialBytes: serial, issuer: name(issuer), issuerDer: issuer.der(), subject: name(subject),
      notBefore: time(validity.kid(0)), notAfter: time(validity.kid(1)),
      keyAlg: oid(alg.kid(0)), curve: curve, publicKey: keyOct, ext: ext
    };
  }

  // ---------------------------------------------------------------- кривые ГОСТ Р 34.10-2012
  function H(s) { return BigInt('0x' + s); }
  var C = {
    cpA: { p: H('FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFD97'), a: H('FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFD94'), b: 166n,
      q: H('FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF6C611070995AD10045841B09B761B893'), x: 1n, y: H('8D91E471E0989CDA27DF505A453F2B7635294F2DDF23E3B122ACC99C9E9F1E14') },
    cpB: { p: H('8000000000000000000000000000000000000000000000000000000000000C99'), a: H('8000000000000000000000000000000000000000000000000000000000000C96'),
      b: H('3E1AF419A269A5F866A7D3C25C3DF80AE979259373FF2B182F49D4CE7E1BBC8B'), q: H('800000000000000000000000000000015F700CFFF1A624E5E497161BCC8A198F'),
      x: 1n, y: H('3FA8124359F96680B83D1C3EB2C070E5C545C9858D03ECFB744BF8D717717EFC') },
    cpC: { p: H('9B9F605F5A858107AB1EC85E6B41C8AACF846E86789051D37998F7B9022D759B'), a: H('9B9F605F5A858107AB1EC85E6B41C8AACF846E86789051D37998F7B9022D7598'),
      b: 32858n, q: H('9B9F605F5A858107AB1EC85E6B41C8AA582CA3511EDDFB74F02F3A6598980BB9'), x: 0n, y: H('41ECE55743711A8C3CBF3783CD08C0EE4D4DC440D4641A8F366E550DFDB3BB67') },
    tc256A: { p: H('FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFD97'), a: H('C2173F1513981673AF4892C23035A27CE25E2013BF95AA33B22C656F277E7335'),
      b: H('295F9BAE7428ED9CCC20E7C359A9D41A22FCCD9108E17BF7BA9337A6F8AE9513'), q: H('400000000000000000000000000000000FD8CDDFC87B6635C115AF556C360C67'),
      x: H('91E38443A5E82C0D880923425712B2BB658B9196932E02C78B2582FE742DAA28'), y: H('32879423AB1A0375895786C4BB46E9565FDE0B5344766740AF268ADB32322E5C') },
    tc512A: { p: H('FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFDC7'),
      a: H('FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFDC4'),
      b: H('E8C2505DEDFC86DDC1BD0B2B6667F1DA34B82574761CB0E879BD081CFD0B6265EE3CB090F30D27614CB4574010DA90DD862EF9D4EBEE4761503190785A71C760'),
      q: H('FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF27E69532F48D89116FF22B8D4E0560609B4B38ABFAD2B85DCACDB1411F10B275'),
      x: 3n, y: H('7503CFE87A836AE3A61B8816E25450E6CE5E1C93ACF1ABC1778064FDCBEFA921DF1626BE4FD036E93D75E6A50E3A41E98028FE5FC235F5B889A589CB5215F2A4') },
    tc512B: { p: H('8000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000006F'),
      a: H('8000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000006C'),
      b: H('687D1B459DC841457E3E06CF6F5E2517B97C7D614AF138BCBF85DC806C4B289F3E965D2DB1416D217F8B276FAD1AB69C50F78BEE1FA3106EFB8CCBC7C5140116'),
      q: H('800000000000000000000000000000000000000000000000000000000000000149A1EC142565A545ACFDB77BD9D40CFA8B996712101BEA0EC6346C54374F25BD'),
      x: 2n, y: H('1A8F7EDA389B094C2C071E3647A8940F3C123B697578C213BE6DD9E6C8EC7335DCB228FD1EDF4A39152CBCAAF8C0398828041055F94CEEEC7E21340780FE41BD') },
    tc512C: { p: H('FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFDC7'),
      a: H('DC9203E514A721875485A529D2C722FB187BC8980EB866644DE41C68E143064546E861C0E2C9EDD92ADE71F46FCF50FF2AD97F951FDA9F2A2EB6546F39689BD3'),
      b: H('B4C4EE28CEBC6C2C8AC12952CF37F16AC7EFB6A9F69F4B57FFDA2E4F0DE5ADE038CBC2FFF719D2C18DE0284B8BFEF3B52B8CC7A5F5BF0A3C8D2319A5312557E1'),
      q: H('3FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFC98CDBA46506AB004C33A9FF5147502CC8EDA9E7A769A12694623CEF47F023ED'),
      x: H('E2E31EDFC23DE7BDEBE241CE593EF5DE2295B7A9CBAEF021D385F7074CEA043AA27272A7AE602BF2A7B9033DB9ED3610C6FB85487EAE97AAC5BC7928C1950148'),
      y: H('F5CE40D95B5EB899ABBCCFF5911CB8577939804D6527378B8C108C3D2090FF9BE18E2D33E3021ED2EF32D85822423B6304F726AA854BAE07D0396E9A9ADDC40F') }
  };
  var CURVE_OID = {
    '1.2.643.2.2.35.1': 'cpA', '1.2.643.2.2.35.2': 'cpB', '1.2.643.2.2.35.3': 'cpC',
    '1.2.643.2.2.36.0': 'cpA', '1.2.643.2.2.36.1': 'cpC',
    '1.2.643.7.1.2.1.1.1': 'tc256A', '1.2.643.7.1.2.1.1.2': 'cpA', '1.2.643.7.1.2.1.1.3': 'cpB', '1.2.643.7.1.2.1.1.4': 'cpC',
    '1.2.643.7.1.2.1.2.1': 'tc512A', '1.2.643.7.1.2.1.2.2': 'tc512B', '1.2.643.7.1.2.1.2.3': 'tc512C'
  };

  function mod(a, m) { a %= m; return a < 0n ? a + m : a; }
  function inv(a, m) { // расширенный алгоритм Евклида
    var t = 0n, nt = 1n, r = m, nr = mod(a, m);
    while (nr) { var q = r / nr; var x = t - q * nt; t = nt; nt = x; x = r - q * nr; r = nr; nr = x; }
    return mod(t, m);
  }
  // Точки в якобиевых координатах [X, Y, Z]; бесконечность — Z = 0
  function jdbl(P, c) {
    var X = P[0], Y = P[1], Z = P[2], p = c.p;
    if (!Y || !Z) return [0n, 1n, 0n];
    var YY = Y * Y % p, S = 4n * X * YY % p, ZZ = Z * Z % p;
    var M = (3n * X * X + c.a * ZZ * ZZ) % p;
    var X3 = mod(M * M - 2n * S, p);
    var Y3 = mod(M * (S - X3) - 8n * YY * YY, p);
    return [X3, Y3, 2n * Y * Z % p];
  }
  function jadd(P, Q, c) {
    if (!P[2]) return Q;
    if (!Q[2]) return P;
    var p = c.p, Z1Z1 = P[2] * P[2] % p, Z2Z2 = Q[2] * Q[2] % p;
    var U1 = P[0] * Z2Z2 % p, U2 = Q[0] * Z1Z1 % p;
    var S1 = P[1] * Q[2] % p * Z2Z2 % p, S2 = Q[1] * P[2] % p * Z1Z1 % p;
    if (U1 === U2) return S1 === S2 ? jdbl(P, c) : [0n, 1n, 0n];
    var Hh = mod(U2 - U1, p), R = mod(S2 - S1, p), HH = Hh * Hh % p, HHH = Hh * HH % p, V = U1 * HH % p;
    var X3 = mod(R * R - HHH - 2n * V, p);
    var Y3 = mod(R * (V - X3) - S1 * HHH, p);
    return [X3, Y3, P[2] * Q[2] % p * Hh % p];
  }
  function jmul(P, k, c) {
    var R = [0n, 1n, 0n];
    for (var i = BigInt(k.toString(2).length) - 1n; i >= 0n; i--) {
      R = jdbl(R, c);
      if ((k >> i) & 1n) R = jadd(R, P, c);
    }
    return R;
  }
  function affineX(P, c) { var zi = inv(P[2], c.p); return zi * zi % c.p * P[0] % c.p; }
  function onCurve(x, y, c) { return mod(y * y - (x * x * x + c.a * x + c.b), c.p) === 0n; }

  function le(b) { var x = 0n; for (var i = b.length - 1; i >= 0; i--) x = (x << 8n) | BigInt(b[i]); return x; }
  function be(b) { var x = 0n; for (var i = 0; i < b.length; i++) x = (x << 8n) | BigInt(b[i]); return x; }

  // e — хэш, r,s — подпись, (qx,qy) — открытый ключ
  function gostVerify(c, e, r, s, qx, qy) {
    var q = c.q;
    if (r <= 0n || r >= q || s <= 0n || s >= q) return false;
    e = mod(e, q); if (!e) e = 1n;
    var v = inv(e, q), z1 = s * v % q, z2 = mod(-r * v, q);
    var Cp = jadd(jmul([c.x, c.y, 1n], z1, c), jmul([qx, qy, 1n], z2, c), c);
    if (!Cp[2]) return false;
    return mod(affineX(Cp, c), q) === r;
  }

  // Проверка подписи над digest (хэш уже посчитан). Порядок байт — как в RFC 4491/9215:
  // открытый ключ x||y little-endian, хэш little-endian, значение подписи s||r big-endian.
  // На всякий случай пробуем и другие встречающиеся раскладки (это не ослабляет проверку).
  function verifyDigest(cert, digest, sig) {
    var cname = CURVE_OID[cert.curve];
    if (!cname) return { ok: false, error: 'Неизвестные параметры ключа (' + cert.curve + ')' };
    var c = C[cname], L = sig.length / 2, kl = cert.publicKey.length / 2;
    var qx = le(cert.publicKey.subarray(0, kl)), qy = le(cert.publicKey.subarray(kl));
    if (!onCurve(qx, qy, c)) return { ok: false, error: 'Открытый ключ сертификата повреждён' };
    var variants = [
      [le(digest), be(sig.subarray(L)), be(sig.subarray(0, L))],      // стандарт: s||r BE, хэш LE
      [be(digest), be(sig.subarray(L)), be(sig.subarray(0, L))],
      [le(digest), le(sig.subarray(0, L)), le(sig.subarray(L))],      // r||s LE
      [be(digest), le(sig.subarray(0, L)), le(sig.subarray(L))]
    ];
    for (var i = 0; i < variants.length; i++) {
      if (gostVerify(c, variants[i][0], variants[i][1], variants[i][2], qx, qy)) return { ok: true, variant: i };
    }
    return { ok: false };
  }

  // ---------------------------------------------------------------- хэш
  var HASH = {
    '1.2.643.7.1.1.2.2': 256, '1.2.643.7.1.1.2.3': 512
  };
  var KEY_HASH = { // если digestAlgorithm не указан явно — по алгоритму ключа
    '1.2.643.7.1.1.1.1': 256, '1.2.643.7.1.1.1.2': 512, '1.2.643.7.1.1.3.2': 256, '1.2.643.7.1.1.3.3': 512
  };
  function digest(bits, data) {
    var d = new root.GostDigest({ name: 'GOST R 34.11', version: 2012, length: bits });
    return new Uint8Array(d.digest(data));
  }

  // ---------------------------------------------------------------- CMS SignedData
  var OID_SIGNED_DATA = '1.2.840.113549.1.7.2';
  var ATTR = {
    contentType: '1.2.840.113549.1.9.3', messageDigest: '1.2.840.113549.1.9.4', signingTime: '1.2.840.113549.1.9.5',
    signingCertV2: '1.2.840.113549.1.9.16.2.47', signingCert: '1.2.840.113549.1.9.16.2.12'
  };

  function verify(cmsBytes, content) {
    return Promise.resolve().then(function () {
      var ci = parse(cmsBytes, 0);
      if (ci.tag !== 0x30 || oid(ci.kid(0)) !== OID_SIGNED_DATA) throw new Error('Это не файл подписи (CMS SignedData)');
      var sd = ci.kid(1).kid(0), k = sd.kids(), i = 1;
      i++; // digestAlgorithms
      var encap = k[i++], eContent = null;
      if (encap.kids()[1]) eContent = octets(encap.kid(1).kid(0));
      var certs = [];
      while (k[i] && (k[i].tag === 0xa0 || k[i].tag === 0xa1)) {
        if (k[i].tag === 0xa0) k[i].kids().forEach(function (c) { if (c.tag === 0x30) { try { certs.push(parseCert(c)); } catch (e) { /* не X.509 */ } } });
        i++;
      }
      var signerInfos = k[i];
      var data = eContent || content;
      var attached = !!eContent;
      if (!data) throw new Error('Подпись отделённая — нужен ещё сам подписанный файл');
      var hashes = {};
      function hashOf(bits) { return hashes[bits] || (hashes[bits] = digest(bits, data)); }

      var signers = signerInfos.kids().map(function (si) {
        var res = { ok: false, problems: [] };
        try {
          var s = si.kids(), j = 1;
          var sid = s[j++];
          var digAlg = oid(s[j++].kid(0));
          var signedAttrs = null;
          if (s[j].tag === 0xa0) signedAttrs = s[j++];
          var sigAlg = oid(s[j++].kid(0));
          var sigVal = s[j++].val();

          // сертификат подписанта
          var cert = null;
          if (sid.tag === 0x30) {
            var iss = sid.kid(0).der(), ser = sid.kid(1).val();
            cert = certs.find(function (c) { return eq(c.issuerDer, iss) && eq(c.serialBytes, ser); }) || null;
          } else if (sid.tag === 0x80 || sid.tag === 0xa0) {
            var ski = sid.val();
            cert = certs.find(function (c) {
              var e = c.ext['2.5.29.14'];
              return e && eq(parse(e, 0).val(), ski);
            }) || null;
          }
          if (!cert && certs.length === 1) cert = certs[0];
          res.cert = cert;
          if (!cert) { res.problems.push('В подписи нет сертификата подписанта — проверить её нельзя'); return res; }

          var bits = HASH[digAlg] || KEY_HASH[sigAlg] || KEY_HASH[cert.keyAlg];
          if (!bits) { res.problems.push('Алгоритм не поддерживается: ' + digAlg + ' (поддерживается ГОСТ Р 34.10/34.11-2012)'); return res; }
          var md = hashOf(bits), toSign = data;

          if (signedAttrs) {
            var attrs = {};
            signedAttrs.kids().forEach(function (a) { attrs[oid(a.kid(0))] = a.kid(1).kid(0); });
            var mdAttr = attrs[ATTR.messageDigest];
            if (!mdAttr || !eq(mdAttr.val(), md)) {
              res.integrity = false;
              res.problems.push('Документ изменён после подписания — хэш не совпадает');
            } else {
              res.integrity = true;
            }
            if (attrs[ATTR.signingTime]) res.signingTime = time(attrs[ATTR.signingTime]);
            res.hasSigningCertV2 = !!attrs[ATTR.signingCertV2];
            // подписываются атрибуты в DER с тегом SET (0x31) вместо [0]
            var der = new Uint8Array(signedAttrs.der());
            der[0] = 0x31;
            toSign = der;
          }
          var h = signedAttrs ? digest(bits, toSign) : md;
          var v = verifyDigest(cert, h, sigVal);
          res.mathOk = v.ok;
          if (v.error) res.problems.push(v.error);
          else if (!v.ok) res.problems.push('Подпись не соответствует сертификату или документу');
          if (!signedAttrs) res.integrity = v.ok;

          // срок действия сертификата
          var when = res.signingTime || new Date();
          res.certValidAtSigning = (!cert.notBefore || when >= cert.notBefore) && (!cert.notAfter || when <= cert.notAfter);
          res.certValidNow = new Date() <= cert.notAfter && new Date() >= cert.notBefore;
          if (!res.certValidAtSigning) res.problems.push('Сертификат не действовал на момент подписания');

          // подпись сертификата издателем — если сертификат издателя есть в подписи
          var issuer = certs.find(function (c) { return c !== cert && eq(subjectDer(c), cert.issuerDer); });
          if (issuer) {
            var ib = KEY_HASH[cert.sigAlg] || 256;
            var cv = verifyDigest(issuer, digest(ib, cert.tbs), cert.signature);
            res.issuerChecked = cv.ok;
          }
          res.ok = res.integrity && res.mathOk && res.certValidAtSigning;
        } catch (e) {
          res.problems.push('Не удалось разобрать подпись: ' + e.message);
        }
        return res;
      });
      return { signers: signers, attached: attached, content: eContent, certs: certs };
    });
  }

  function subjectDer(c) {
    var tbs = parse(c.tbs, 0), k = tbs.kids(), i = k[0].tag === 0xa0 ? 1 : 0;
    return (c.subjectDer = k[i + 4].der());
  }

  root.CmsVerify = { verify: verify, parseCert: parseCert, parse: parse, oid: oid, hex: hex, _curves: C, _gostVerify: gostVerify, _onCurve: onCurve, _jmul: jmul };
})(typeof window !== 'undefined' ? window : globalThis);
