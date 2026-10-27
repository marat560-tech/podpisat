/* подписатьэцп.рф — подпись PDF инкрементальным обновлением (PAdES).
 * Исходный файл не переписывается: в конец дописываются штамп, поле подписи и сама подпись,
 * поэтому прежние подписи в документе остаются действительными.
 *
 * PdfInc.open(bytes)                    -> документ (разбор xref, страниц)
 * PdfInc.prepare(doc, opts)             -> заготовка с пустым местом под подпись
 * PdfInc.signedBytes(prep)              -> байты, которые подписываются (по /ByteRange)
 * PdfInc.finish(prep, cmsBytes)         -> готовый подписанный PDF
 * PdfInc.findSignatures(bytes)          -> подписи в PDF (для проверки)
 */
(function (root) {
  'use strict';

  var WS = { 0: 1, 9: 1, 10: 1, 12: 1, 13: 1, 32: 1 };
  var DELIM = { 40: 1, 41: 1, 60: 1, 62: 1, 91: 1, 93: 1, 123: 1, 125: 1, 47: 1, 37: 1 };

  function PdfError(msg) { var e = new Error(msg); e.pdf = true; return e; }

  function latin1(bytes, from, to) {
    var s = '', CH = 0x8000;
    for (var i = from || 0, n = to == null ? bytes.length : to; i < n; i += CH) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CH, n)));
    }
    return s;
  }

  function ascii(str) {
    var out = new Uint8Array(str.length);
    for (var i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
    return out;
  }

  function concat(parts) {
    var len = 0, i;
    for (i = 0; i < parts.length; i++) len += parts[i].length;
    var out = new Uint8Array(len), off = 0;
    for (i = 0; i < parts.length; i++) { out.set(parts[i], off); off += parts[i].length; }
    return out;
  }

  // ---------------------------------------------------------------- лексер и разбор объектов
  function Parser(bytes, pos) { this.b = bytes; this.p = pos || 0; }

  Parser.prototype.skip = function () {
    var b = this.b;
    for (;;) {
      while (this.p < b.length && WS[b[this.p]]) this.p++;
      if (b[this.p] === 37) { // комментарий
        while (this.p < b.length && b[this.p] !== 10 && b[this.p] !== 13) this.p++;
        continue;
      }
      return;
    }
  };

  Parser.prototype.word = function () {
    this.skip();
    var b = this.b, s = this.p;
    while (this.p < b.length && !WS[b[this.p]] && !DELIM[b[this.p]]) this.p++;
    return latin1(b, s, this.p);
  };

  Parser.prototype.peekWord = function () {
    var save = this.p, w = this.word();
    this.p = save;
    return w;
  };

  Parser.prototype.value = function () {
    this.skip();
    var b = this.b, c = b[this.p];
    if (c === 47) { // имя
      var s = ++this.p;
      while (this.p < b.length && !WS[b[this.p]] && !DELIM[b[this.p]]) this.p++;
      var raw = latin1(b, s, this.p);
      return { T: 'name', raw: raw, v: raw.replace(/#([0-9A-Fa-f]{2})/g, function (_, h) { return String.fromCharCode(parseInt(h, 16)); }) };
    }
    if (c === 60 && b[this.p + 1] === 60) { // словарь
      this.p += 2;
      var m = new Map();
      for (;;) {
        this.skip();
        if (b[this.p] === 62 && b[this.p + 1] === 62) { this.p += 2; break; }
        if (this.p >= b.length) throw PdfError('Повреждённый словарь');
        var k = this.value();
        if (k.T !== 'name') throw PdfError('Ожидалось имя в словаре');
        m.set(k.v, this.value());
      }
      return { T: 'dict', m: m };
    }
    if (c === 60) { // шестнадцатеричная строка
      var hs = this.p;
      while (this.p < b.length && b[this.p] !== 62) this.p++;
      this.p++;
      return { T: 'str', raw: b.slice(hs, this.p), hex: true };
    }
    if (c === 40) { // строка в скобках
      var ss = this.p, depth = 0;
      for (; this.p < b.length; this.p++) {
        var ch = b[this.p];
        if (ch === 92) { this.p++; continue; }
        if (ch === 40) depth++;
        else if (ch === 41 && --depth === 0) { this.p++; break; }
      }
      return { T: 'str', raw: b.slice(ss, this.p) };
    }
    if (c === 91) { // массив
      this.p++;
      var a = [];
      for (;;) {
        this.skip();
        if (b[this.p] === 93) { this.p++; break; }
        if (this.p >= b.length) throw PdfError('Повреждённый массив');
        a.push(this.value());
      }
      return { T: 'arr', a: a };
    }
    var w = this.word();
    if (w === '') { this.p++; throw PdfError('Неожиданный символ в PDF'); }
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(w)) {
      if (/^\d+$/.test(w)) { // возможно ссылка «n g R»
        var save = this.p, g = this.word();
        if (/^\d+$/.test(g) && this.word() === 'R') return { T: 'ref', n: +w, g: +g };
        this.p = save;
      }
      return { T: 'num', v: parseFloat(w), raw: w };
    }
    return { T: 'kw', raw: w };
  };

  // ---------------------------------------------------------------- запись объектов
  function ser(v) {
    switch (v.T) {
      case 'name': return '/' + v.raw;
      case 'num': return v.raw;
      case 'kw': return v.raw;
      case 'ref': return v.n + ' ' + v.g + ' R';
      case 'str': return latin1(v.raw);
      case 'arr': return '[' + v.a.map(ser).join(' ') + ']';
      case 'dict':
        var out = '<<';
        v.m.forEach(function (val, key) { out += ' ' + ser(nameOf(key)) + ' ' + ser(val); });
        return out + ' >>';
    }
    throw PdfError('Неизвестный тип объекта');
  }

  function nameOf(s) {
    return { T: 'name', v: s, raw: s.replace(/[^!-~]|[#()<>\[\]{}\/%]/g, function (c) {
      return '#' + ('0' + c.charCodeAt(0).toString(16)).slice(-2);
    }) };
  }
  function num(x) { return { T: 'num', v: x, raw: fmtNum(x) }; }
  function ref(n, g) { return { T: 'ref', n: n, g: g || 0 }; }
  function arr(a) { return { T: 'arr', a: a }; }
  function dict(obj) {
    var m = new Map();
    Object.keys(obj).forEach(function (k) { if (obj[k] != null) m.set(k, obj[k]); });
    return { T: 'dict', m: m };
  }
  function fmtNum(x) {
    if (Math.abs(x - Math.round(x)) < 1e-9) return String(Math.round(x));
    return x.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  }
  // Текстовая строка PDF в UTF-16BE с BOM
  function textStr(s) {
    var h = 'FEFF';
    for (var i = 0; i < s.length; i++) h += ('000' + s.charCodeAt(i).toString(16)).slice(-4).toUpperCase();
    return { T: 'str', raw: ascii('<' + h + '>'), hex: true };
  }
  function asciiStr(s) { return { T: 'str', raw: ascii('(' + s.replace(/[\\()]/g, '\\$&') + ')') }; }

  // ---------------------------------------------------------------- сжатие
  function streamThrough(data, stream) {
    var blob = new Blob([data]).stream().pipeThrough(stream);
    return new Response(blob).arrayBuffer().then(function (b) { return new Uint8Array(b); });
  }
  function inflate(data) { return streamThrough(data, new DecompressionStream('deflate')); }
  function deflate(data) { return streamThrough(data, new CompressionStream('deflate')); }

  function unpredict(data, parms) {
    if (!parms || parms.T !== 'dict') return data;
    var pred = parms.m.get('Predictor');
    pred = pred ? pred.v : 1;
    if (pred < 10) return data;
    var cols = parms.m.get('Columns'); cols = cols ? cols.v : 1;
    var colors = parms.m.get('Colors'); colors = colors ? colors.v : 1;
    var bpc = parms.m.get('BitsPerComponent'); bpc = bpc ? bpc.v : 8;
    var bpp = Math.max(1, Math.ceil(colors * bpc / 8)), rowLen = Math.ceil(cols * colors * bpc / 8);
    var rows = Math.floor(data.length / (rowLen + 1)), out = new Uint8Array(rows * rowLen);
    var prev = new Uint8Array(rowLen);
    for (var r = 0; r < rows; r++) {
      var type = data[r * (rowLen + 1)], row = data.subarray(r * (rowLen + 1) + 1, (r + 1) * (rowLen + 1));
      var cur = out.subarray(r * rowLen, (r + 1) * rowLen);
      for (var i = 0; i < rowLen; i++) {
        var left = i >= bpp ? cur[i - bpp] : 0, up = prev[i], ul = i >= bpp ? prev[i - bpp] : 0, x = row[i];
        switch (type) {
          case 0: cur[i] = x; break;
          case 1: cur[i] = x + left; break;
          case 2: cur[i] = x + up; break;
          case 3: cur[i] = x + ((left + up) >> 1); break;
          case 4:
            var pa = Math.abs(up - ul), pb = Math.abs(left - ul), pc = Math.abs(left + up - 2 * ul);
            cur[i] = x + (pa <= pb && pa <= pc ? left : pb <= pc ? up : ul);
            break;
          default: throw PdfError('Неизвестный предиктор PNG');
        }
      }
      prev = cur;
    }
    return out;
  }

  // ---------------------------------------------------------------- документ
  function Doc(bytes) {
    this.bytes = bytes;
    this.xref = new Map();   // номер -> {off, gen} | {stm, idx}
    this.cache = new Map();
    this.trailer = null;
    this.lastXrefOffset = 0;
    this.xrefIsStream = false;
    // Смещения в PDF отсчитываются от «%PDF-»: если перед заголовком есть мусор,
    // Acrobat и другие программы сдвигают все смещения на его длину — делаем так же.
    this.base = 0;
  }

  Doc.prototype.parseAt = function (off, num) {
    var p = new Parser(this.bytes, off);
    var n = p.word(), g = p.word(), kw = p.word();
    if (!/^\d+$/.test(n) || !/^\d+$/.test(g) || kw !== 'obj' || (num != null && +n !== num)) return null;
    var v = p.value(), res = { value: v, n: +n, g: +g };
    var save = p.p;
    if (v.T === 'dict' && p.word() === 'stream') {
      var b = this.bytes, s = p.p;
      if (b[s] === 13) s++;
      if (b[s] === 10) s++;
      res.streamStart = s;
      var len = v.m.get('Length');
      res.streamLen = len ? (len.T === 'ref' ? null : len.v) : null;
    } else {
      p.p = save;
    }
    return res;
  };

  Doc.prototype.findObjBySearch = function (num) {
    if (!this.objIndex) {
      this.objIndex = new Map();
      var s = latin1(this.bytes), re = /(?<![0-9])(\d+)\s+(\d+)\s+obj\b/g, m;
      while ((m = re.exec(s))) this.objIndex.set(+m[1], m.index);
    }
    var off = this.objIndex.get(num);
    return off == null ? null : this.parseAt(off, num);
  };

  Doc.prototype.rawObj = function (num) {
    var e = this.xref.get(num), r = null;
    if (e && e.off != null) r = this.parseAt(e.off + this.base, num);
    if (!r && (!e || e.off != null)) r = this.findObjBySearch(num);
    return r;
  };

  Doc.prototype.streamData = function (r) {
    var self = this;
    var len = r.streamLen;
    if (len == null) {
      var lv = r.value.m.get('Length');
      return this.resolve(lv).then(function (l) {
        r.streamLen = l && l.T === 'num' ? l.v : self.guessStreamLen(r.streamStart);
        return self.streamData(r);
      });
    }
    var raw = this.bytes.subarray(r.streamStart, r.streamStart + len);
    var f = r.value.m.get('Filter'), parms = r.value.m.get('DecodeParms');
    if (f && f.T === 'arr') { if (f.a.length > 1) throw PdfError('Неподдерживаемое сжатие в PDF'); f = f.a[0]; }
    if (parms && parms.T === 'arr') parms = parms.a[0];
    if (!f) return Promise.resolve(raw);
    if (f.v !== 'FlateDecode') throw PdfError('Неподдерживаемое сжатие в PDF: ' + f.v);
    return inflate(raw).then(function (d) { return unpredict(d, parms); });
  };

  Doc.prototype.guessStreamLen = function (start) {
    var s = latin1(this.bytes, start, Math.min(this.bytes.length, start + 50 * 1024 * 1024));
    var i = s.indexOf('endstream');
    if (i < 0) throw PdfError('Не найден конец потока');
    while (i > 0 && (s.charCodeAt(i - 1) === 10 || s.charCodeAt(i - 1) === 13)) i--;
    return i;
  };

  // Значение объекта по ссылке (или само значение, если это не ссылка)
  Doc.prototype.resolve = function (v) {
    if (!v || v.T !== 'ref') return Promise.resolve(v);
    return this.getObj(v.n).then(function (o) { return o ? o.value : null; });
  };

  Doc.prototype.getObj = function (num) {
    var self = this;
    if (this.cache.has(num)) return Promise.resolve(this.cache.get(num));
    var e = this.xref.get(num);
    var pr;
    if (e && e.stm != null) {
      pr = this.objStream(e.stm).then(function (os) {
        var item = os.items[e.idx];
        if (!item || item.n !== num) item = os.items.find(function (x) { return x.n === num; });
        if (!item) return null;
        var p = new Parser(os.data, os.first + item.off);
        return { value: p.value(), n: num, g: 0, inStream: true };
      });
    } else {
      pr = Promise.resolve(this.rawObj(num));
    }
    return pr.then(function (o) { self.cache.set(num, o); return o; });
  };

  Doc.prototype.objStream = function (num) {
    var self = this;
    this.osCache = this.osCache || new Map();
    if (this.osCache.has(num)) return this.osCache.get(num);
    var pr = Promise.resolve(this.rawObj(num)).then(function (r) {
      if (!r || r.streamStart == null) throw PdfError('Не найден поток объектов ' + num);
      return self.streamData(r).then(function (data) {
        var n = r.value.m.get('N').v, first = r.value.m.get('First').v;
        var p = new Parser(data, 0), items = [];
        for (var i = 0; i < n; i++) items.push({ n: +p.word(), off: +p.word() });
        return { data: data, first: first, items: items };
      });
    });
    this.osCache.set(num, pr);
    return pr;
  };

  // ---------------------------------------------------------------- таблица xref
  Doc.prototype.readXrefChain = function (start) {
    var self = this, seen = {};
    function step(off, first) {
      if (off == null || seen[off]) return Promise.resolve();
      seen[off] = 1;
      return self.readXrefAt(off, first).then(function (tr) {
        if (first) self.trailer = tr;
        var chain = Promise.resolve();
        var xs = tr.m.get('XRefStm');
        if (xs && xs.T === 'num') chain = chain.then(function () { return step(xs.v, false); });
        var prev = tr.m.get('Prev');
        if (prev && prev.T === 'num') chain = chain.then(function () { return step(prev.v, false); });
        return chain;
      });
    }
    return step(start, true);
  };

  Doc.prototype.readXrefAt = function (off, first) {
    var b = this.bytes, self = this;
    var p = new Parser(b, off + this.base);
    if (p.peekWord() === 'xref') {
      p.word();
      if (first) this.xrefIsStream = false;
      for (;;) {
        var w = p.peekWord();
        if (w === 'trailer') { p.word(); break; }
        var start = +p.word(), count = +p.word();
        if (!(count >= 0) || isNaN(start)) throw PdfError('Повреждённая таблица xref');
        for (var i = 0; i < count; i++) {
          var o = p.word(), g = p.word(), t = p.word();
          var n = start + i;
          if (!this.xref.has(n)) {
            if (t === 'n') this.xref.set(n, { off: +o, gen: +g });
            else this.xref.set(n, { free: true, gen: +g });
          }
        }
      }
      var tr = p.value();
      if (tr.T !== 'dict') throw PdfError('Повреждённый trailer');
      return Promise.resolve(tr);
    }
    var r = this.parseAt(off + this.base);
    if (!r || r.streamStart == null) throw PdfError('Повреждённая таблица xref');
    if (first) this.xrefIsStream = true;
    return this.streamData(r).then(function (data) {
      var d = r.value.m, W = d.get('W').a.map(function (x) { return x.v; });
      var size = d.get('Size').v;
      var idx = d.get('Index') ? d.get('Index').a.map(function (x) { return x.v; }) : [0, size];
      var rec = W[0] + W[1] + W[2], pos = 0;
      function field(len, def) {
        if (!len) return def;
        var v = 0;
        for (var k = 0; k < len; k++) v = v * 256 + data[pos++];
        return v;
      }
      for (var s = 0; s < idx.length; s += 2) {
        for (var j = 0; j < idx[s + 1]; j++) {
          if (pos + rec > data.length) break;
          var type = field(W[0], 1), f2 = field(W[1], 0), f3 = field(W[2], 0), n = idx[s] + j;
          if (self.xref.has(n)) continue;
          if (type === 1) self.xref.set(n, { off: f2, gen: f3 });
          else if (type === 2) self.xref.set(n, { stm: f2, idx: f3 });
          else self.xref.set(n, { free: true });
        }
      }
      return r.value;
    });
  };

  // Восстановление, если таблица xref битая: ищем объекты и trailer перебором
  Doc.prototype.rebuild = function () {
    var self = this, s = latin1(this.bytes);
    this.xref = new Map(); this.cache = new Map(); this.objIndex = null;
    var re = /(\d+)\s+(\d+)\s+obj\b/g, m, xrefStreams = [];
    while ((m = re.exec(s))) {
      if (m.index > 0 && !/[\s\r\n]/.test(s.charAt(m.index - 1))) continue;
      this.xref.set(+m[1], { off: m.index - this.base, gen: +m[2] });
    }
    var ti = s.lastIndexOf('trailer');
    var chain = Promise.resolve();
    if (ti >= 0) {
      var p = new Parser(this.bytes, ti + 7);
      this.trailer = p.value();
      this.xrefIsStream = false;
    }
    // объекты из потоков объектов и trailer из xref-потоков
    this.xref.forEach(function (e, n) {
      var r = self.parseAt(e.off + self.base, n);
      if (!r || r.value.T !== 'dict') return;
      var type = r.value.m.get('Type');
      if (type && type.v === 'XRef') xrefStreams.push(r);
      if (type && type.v === 'ObjStm') {
        chain = chain.then(function () {
          return self.objStream(n).then(function (os) {
            os.items.forEach(function (it, idx) { if (!self.xref.has(it.n)) self.xref.set(it.n, { stm: n, idx: idx }); });
          }, function () {});
        });
      }
    });
    return chain.then(function () {
      if (!self.trailer || !self.trailer.m.get('Root')) {
        var last = xrefStreams[xrefStreams.length - 1];
        if (!last) throw PdfError('Не удалось прочитать структуру PDF');
        self.trailer = last.value;
        self.xrefIsStream = true;
      }
      var size = 0;
      self.xref.forEach(function (_, n) { if (n >= size) size = n + 1; });
      self.rebuiltSize = size;
      self.rebuilt = true;
    });
  };

  Doc.prototype.pageRefs = function () {
    var self = this, out = [], seen = {};
    function walk(r) {
      if (!r || r.T !== 'ref' || seen[r.n]) return Promise.resolve();
      seen[r.n] = 1;
      return self.resolve(r).then(function (node) {
        if (!node || node.T !== 'dict') return;
        var type = node.m.get('Type');
        var kids = node.m.get('Kids');
        if ((type && type.v === 'Pages') || (kids && !(type && type.v === 'Page'))) {
          return self.resolve(kids).then(function (k) {
            return (k ? k.a : []).reduce(function (c, kid) { return c.then(function () { return walk(kid); }); }, Promise.resolve());
          });
        }
        out.push(r);
      });
    }
    return this.resolve(this.trailer.m.get('Root')).then(function (cat) {
      if (!cat || cat.T !== 'dict') throw PdfError('Не найден каталог документа');
      self.catalog = cat;
      return walk(cat.m.get('Pages'));
    }).then(function () { return out; });
  };

  function open(bytes) {
    if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
    var head = latin1(bytes, 0, Math.min(1024, bytes.length));
    if (head.indexOf('%PDF-') < 0) return Promise.reject(PdfError('Это не PDF-файл'));
    var doc = new Doc(bytes);
    doc.base = Math.max(0, head.indexOf('%PDF-'));
    var tail = latin1(bytes, Math.max(0, bytes.length - 2048));
    var m = /startxref\s+(\d+)/g, last = null, mm;
    while ((mm = m.exec(tail))) last = mm;
    var pr;
    if (last) {
      doc.lastXrefOffset = +last[1];
      pr = Promise.resolve().then(function () { return doc.readXrefChain(doc.lastXrefOffset); }).then(function () {
        if (!doc.trailer || !doc.trailer.m.get('Root')) throw PdfError('нет Root');
      }).catch(function () { return doc.rebuild(); });
    } else {
      pr = doc.rebuild();
    }
    return pr.then(function () {
      if (doc.trailer.m.get('Encrypt')) throw PdfError('PDF защищён (зашифрован), такой файл подписать нельзя. Снимите защиту: откройте PDF в браузере, нажмите «Печать» и выберите «Сохранить как PDF» — получится обычный файл.');
      return doc.pageRefs();
    }).then(function (pages) {
      if (!pages.length) throw PdfError('В документе не найдено страниц');
      doc.pages = pages;
      return doc.checkPerms();
    }).then(function () { return doc; });
  }

  // Запрет изменений после подписи (DocMDP P=1)
  Doc.prototype.checkPerms = function () {
    var self = this, perms = this.catalog.m.get('Perms');
    this.locked = false;
    if (!perms) return Promise.resolve();
    return this.resolve(perms).then(function (p) {
      if (!p || p.T !== 'dict' || !p.m.get('DocMDP')) return;
      return self.resolve(p.m.get('DocMDP')).then(function (sig) {
        var refs = sig && sig.m && sig.m.get('Reference');
        return self.resolve(refs).then(function (ra) {
          (ra && ra.a || []).forEach(function (r0) {
            var r = r0.T === 'dict' ? r0 : null;
            var tp = r && r.m.get('TransformParams');
            var P = tp && tp.T === 'dict' && tp.m.get('P');
            if (P && P.v === 1) self.locked = true;
          });
        });
      });
    }).catch(function () {});
  };

  // ---------------------------------------------------------------- подготовка подписи
  /* opts: {
   *   widgets: [{ page: индекс, rect: [x1,y1,x2,y2] в координатах страницы, rotate: 0|90|180|270,
   *               image: {w, h, rgb: Uint8Array, alpha: Uint8Array|null} }],
   *   name, reason, location, contact: строки (необязательны),
   *   subFilter: 'ETSI.CAdES.detached' | 'adbe.pkcs7.detached',
   *   reserve: байт под подпись (по умолчанию 16384),
   *   date: Date
   * } */
  function prepare(doc, opts) {
    var reserve = opts.reserve || 16384;
    var trailer = doc.trailer.m;
    var nextNum = Math.max(trailer.get('Size') ? trailer.get('Size').v : 0, doc.rebuiltSize || 0);
    var objs = []; // {n, g, body (string|Uint8Array parts)}
    var alloc = function () { return nextNum++; };
    var date = opts.date || new Date();
    var rootRef = trailer.get('Root');

    var sigNum = alloc(), fieldNum = alloc();
    var widgetNums = [];
    var images = {};

    // изображения штампов (одинаковые картинки — один объект)
    var chain = Promise.resolve();
    var imgObjs = [];
    (opts.widgets || []).forEach(function (w) {
      if (!w.image) return;
      var key = w.image.key || ('i' + imgObjs.length);
      if (images[key]) { w.imgNum = images[key]; return; }
      var imgNum = alloc(), smaskNum = w.image.alpha ? alloc() : null;
      images[key] = imgNum;
      w.imgNum = imgNum;
      chain = chain.then(function () {
        return deflate(w.image.rgb).then(function (rgbZ) {
          var p = Promise.resolve(null);
          if (smaskNum) p = deflate(w.image.alpha);
          return p.then(function (aZ) {
            imgObjs.push({ n: imgNum, dict: dict({
              Type: nameOf('XObject'), Subtype: nameOf('Image'), Width: num(w.image.w), Height: num(w.image.h),
              ColorSpace: nameOf('DeviceRGB'), BitsPerComponent: num(8), Filter: nameOf('FlateDecode'),
              SMask: smaskNum ? ref(smaskNum) : null, Length: num(rgbZ.length)
            }), data: rgbZ });
            if (smaskNum) imgObjs.push({ n: smaskNum, dict: dict({
              Type: nameOf('XObject'), Subtype: nameOf('Image'), Width: num(w.image.w), Height: num(w.image.h),
              ColorSpace: nameOf('DeviceGray'), BitsPerComponent: num(8), Filter: nameOf('FlateDecode'), Length: num(aZ.length)
            }), data: aZ });
          });
        });
      });
    });

    return chain.then(function () {
      imgObjs.forEach(function (o) { objs.push(o); });

      // виджеты (видимые штампы) — дочерние элементы одного поля подписи
      var pageAnnots = new Map(); // номер страницы-объекта -> [ref виджета]
      var widgets = opts.widgets && opts.widgets.length ? opts.widgets : null;
      // Первый штамп — виджет самого поля подписи (поле и виджет в одном объекте, как у Acrobat).
      // Остальные штампы — аннотации-«штампы» с тем же оформлением: подписывающие программы и
      // проверяющие сервисы плохо понимают поле подписи с несколькими виджетами.
      var fieldExtra = null;
      if (widgets) {
        widgets.forEach(function (w, wi) {
          var wNum = wi === 0 ? fieldNum : alloc(), apNum = alloc();
          widgetNums.push(wNum);
          var pageRef = doc.pages[w.page];
          var x1 = Math.min(w.rect[0], w.rect[2]), x2 = Math.max(w.rect[0], w.rect[2]);
          var y1 = Math.min(w.rect[1], w.rect[3]), y2 = Math.max(w.rect[1], w.rect[3]);
          var rot = ((w.rotate || 0) % 360 + 360) % 360;
          // внешний вид: BBox в «экранных» размерах, Matrix поворачивает под поворот страницы
          var bw = (rot === 90 || rot === 270) ? y2 - y1 : x2 - x1;
          var bh = (rot === 90 || rot === 270) ? x2 - x1 : y2 - y1;
          var matrix = { 0: [1, 0, 0, 1, 0, 0], 90: [0, 1, -1, 0, 0, 0], 180: [-1, 0, 0, -1, 0, 0], 270: [0, -1, 1, 0, 0, 0] }[rot];
          var content = ascii('q ' + fmtNum(bw) + ' 0 0 ' + fmtNum(bh) + ' 0 0 cm /Img Do Q\n');
          objs.push({ n: apNum, dict: dict({
            Type: nameOf('XObject'), Subtype: nameOf('Form'),
            BBox: arr([num(0), num(0), num(bw), num(bh)]),
            Matrix: arr(matrix.map(num)),
            Resources: dict({ XObject: dict({ Img: ref(w.imgNum) }) }),
            Length: num(content.length)
          }), data: content });
          var rect = arr([num(x1), num(y1), num(x2), num(y2)]);
          if (wi === 0) {
            fieldExtra = { page: pageRef, rect: rect, ap: ref(apNum), flags: 4 };
          } else {
            objs.push({ n: wNum, dict: dict({
              Type: nameOf('Annot'), Subtype: nameOf('Stamp'), Rect: rect, F: num(4 + 128), P: pageRef,
              Name: nameOf('Signed'), Contents: textStr(opts.stampText || 'Документ подписан электронной подписью'),
              AP: dict({ N: ref(apNum) })
            }) });
          }
          var list = pageAnnots.get(w.page) || [];
          list.push(ref(wNum));
          pageAnnots.set(w.page, list);
        });
      } else {
        // невидимая подпись: виджет нулевого размера на первой странице
        fieldExtra = { page: doc.pages[0], rect: arr([num(0), num(0), num(0), num(0)]), ap: null, flags: 132 };
        pageAnnots.set(0, [ref(fieldNum)]);
      }

      objs.push({ n: fieldNum, dict: dict({
        Type: nameOf('Annot'), Subtype: nameOf('Widget'), FT: nameOf('Sig'),
        T: asciiStr('Signature' + date.getTime().toString(36).toUpperCase()),
        V: ref(sigNum), F: num(fieldExtra.flags), P: fieldExtra.page, Rect: fieldExtra.rect,
        AP: fieldExtra.ap ? dict({ N: fieldExtra.ap }) : null
      }) });

      // страницы: добавить виджеты в /Annots
      var updates = [];
      pageAnnots.forEach(function (list, pageIdx) {
        updates.push(function () {
          var pr = doc.pages[pageIdx];
          return doc.getObj(pr.n).then(function (po) {
            var pd = cloneDict(po.value);
            var annots = pd.m.get('Annots');
            if (annots && annots.T === 'ref') {
              return doc.resolve(annots).then(function (a) {
                var na = arr((a && a.a ? a.a.slice() : []).concat(list));
                objs.push({ n: annots.n, g: annots.g, value: na });
              });
            }
            pd.m.set('Annots', arr((annots && annots.a ? annots.a.slice() : []).concat(list)));
            objs.push({ n: pr.n, g: pr.g, dict: pd });
          });
        });
      });

      // каталог / AcroForm: добавить поле, SigFlags 3
      updates.push(function () {
        return doc.getObj(rootRef.n).then(function (co) {
          var cat = cloneDict(co.value);
          var af = cat.m.get('AcroForm');
          var afRefP = Promise.resolve();
          if (af && af.T === 'ref') {
            afRefP = doc.resolve(af).then(function (afd) {
              afd = cloneDict(afd && afd.T === 'dict' ? afd : dict({}));
              return withField(afd).then(function () { objs.push({ n: af.n, g: af.g, dict: afd }); });
            });
            return afRefP;
          }
          var afd = af && af.T === 'dict' ? cloneDict(af) : dict({});
          return withField(afd).then(function () {
            cat.m.set('AcroForm', afd);
            objs.push({ n: rootRef.n, g: rootRef.g, dict: cat });
          });
        });
      });

      function withField(afd) {
        afd.m.set('SigFlags', num(3));
        var fields = afd.m.get('Fields');
        if (fields && fields.T === 'ref') {
          return doc.resolve(fields).then(function (fa) {
            objs.push({ n: fields.n, g: fields.g, value: arr((fa && fa.a ? fa.a.slice() : []).concat([ref(fieldNum)])) });
          });
        }
        afd.m.set('Fields', arr((fields && fields.a ? fields.a.slice() : []).concat([ref(fieldNum)])));
        return Promise.resolve();
      }

      return updates.reduce(function (c, f) { return c.then(f); }, Promise.resolve());
    }).then(function () {
      // словарь подписи с заглушками /ByteRange и /Contents
      var sigParts = [
        '<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /' + (opts.subFilter || 'ETSI.CAdES.detached'),
        ' /ByteRange [0 ' + pad('', 10) + ' ' + pad('', 10) + ' ' + pad('', 10) + ']',
        ' /Contents <'
      ];
      var tail = '>';
      tail += ' /M ' + latin1(asciiStr(pdfDate(date)).raw);
      if (opts.name) tail += ' /Name ' + latin1(textStr(opts.name).raw);
      if (opts.reason) tail += ' /Reason ' + latin1(textStr(opts.reason).raw);
      if (opts.location) tail += ' /Location ' + latin1(textStr(opts.location).raw);
      if (opts.contact) tail += ' /ContactInfo ' + latin1(textStr(opts.contact).raw);
      tail += ' >>';
      objs.push({ n: sigNum, sig: { head: sigParts.join(''), holeLen: reserve * 2, tail: tail } });

      return build(doc, objs, nextNum);
    });
  }

  function pad(s, n) { while (s.length < n) s += ' '; return s; }

  function cloneDict(d) {
    return { T: 'dict', m: new Map(d.m) };
  }

  function pdfDate(d) {
    var z = function (x) { return ('0' + x).slice(-2); };
    var tz = -d.getTimezoneOffset(), sign = tz >= 0 ? '+' : '-';
    tz = Math.abs(tz);
    return 'D:' + d.getFullYear() + z(d.getMonth() + 1) + z(d.getDate()) + z(d.getHours()) + z(d.getMinutes()) + z(d.getSeconds()) +
      sign + z(Math.floor(tz / 60)) + "'" + z(tz % 60) + "'";
  }

  function build(doc, objs, size) {
    var orig = doc.bytes;
    var parts = [], offset = orig.length;
    var last = orig[orig.length - 1];
    if (last !== 10 && last !== 13) { parts.push(ascii('\n')); offset++; }
    var entries = [], sigInfo = null;

    // дубликаты (одна страница обновлена дважды) — оставляем последний
    var byNum = new Map();
    objs.forEach(function (o) { byNum.set(o.n, o); });

    byNum.forEach(function (o) {
      var g = o.g || 0;
      entries.push({ n: o.n, off: offset - doc.base, g: g });
      var head = o.n + ' ' + g + ' obj\n';
      var chunk;
      if (o.sig) {
        var pre = ascii(head + o.sig.head);
        var hole = new Uint8Array(o.sig.holeLen).fill(48);
        var post = ascii(o.sig.tail + '\nendobj\n');
        sigInfo = { objOffset: offset, holeStart: offset + pre.length, holeLen: o.sig.holeLen, head: head + o.sig.head };
        chunk = concat([pre, hole, post]);
      } else if (o.data) {
        chunk = concat([ascii(head + ser(o.dict) + '\nstream\n'), o.data, ascii('\nendstream\nendobj\n')]);
      } else {
        chunk = ascii(head + ser(o.value || o.dict) + '\nendobj\n');
      }
      parts.push(chunk);
      offset += chunk.length;
    });

    // Файл восстанавливали перебором: старая таблица ссылок неверна, поэтому
    // пишем полную таблицу (все объекты) и не ссылаемся на старую через /Prev.
    if (doc.rebuilt) {
      var mine = new Set(entries.map(function (e) { return e.n; }));
      doc.xref.forEach(function (e, n) {
        if (mine.has(n) || n === 0) return;
        if (e.off != null) entries.push({ n: n, off: e.off, g: e.gen || 0 });
        else if (e.stm != null) entries.push({ n: n, stm: e.stm, idx: e.idx });
      });
      entries.push({ n: 0, free: true });
      if (!doc.xrefIsStream && entries.some(function (e) { return e.stm != null; })) doc.xrefIsStream = true;
    }
    entries.sort(function (a, b) { return a.n - b.n; });
    var tr = doc.trailer.m;
    var trailerParts = {
      Root: tr.get('Root'), Info: tr.get('Info'), ID: tr.get('ID'),
      Prev: doc.lastXrefOffset && !doc.rebuilt ? num(doc.lastXrefOffset) : null
    };
    var xrefOff = offset, xref;
    if (doc.xrefIsStream) {
      var xn = size++;
      entries.push({ n: xn, off: xrefOff - doc.base, g: 0 });
      entries.sort(function (a, b) { return a.n - b.n; });
      var idx = [], data = [];
      groups(entries).forEach(function (gr) {
        idx.push(num(gr[0].n), num(gr.length));
        gr.forEach(function (e) {
          if (e.free) data.push(0, 0, 0, 0, 0, 255, 255);
          else if (e.stm != null) data.push(2, (e.stm >>> 24) & 255, (e.stm >>> 16) & 255, (e.stm >>> 8) & 255, e.stm & 255, (e.idx >> 8) & 255, e.idx & 255);
          else data.push(1, (e.off >>> 24) & 255, (e.off >>> 16) & 255, (e.off >>> 8) & 255, e.off & 255, (e.g >> 8) & 255, e.g & 255);
        });
      });
      var bin = new Uint8Array(data);
      var d = dict({
        Type: nameOf('XRef'), Size: num(size), Index: arr(idx), W: arr([num(1), num(4), num(2)]),
        Root: trailerParts.Root, Info: trailerParts.Info, ID: trailerParts.ID, Prev: trailerParts.Prev,
        Length: num(bin.length)
      });
      xref = concat([ascii(xn + ' 0 obj\n' + ser(d) + '\nstream\n'), bin, ascii('\nendstream\nendobj\nstartxref\n' + (xrefOff - doc.base) + '\n%%EOF\n')]);
    } else {
      var s = 'xref\n';
      groups(entries).forEach(function (gr) {
        s += gr[0].n + ' ' + gr.length + '\n';
        gr.forEach(function (e) {
          s += e.free ? '0000000000 65535 f\r\n' : ('0000000000' + e.off).slice(-10) + ' ' + ('00000' + e.g).slice(-5) + ' n\r\n';
        });
      });
      var td = dict({ Size: num(size), Root: trailerParts.Root, Info: trailerParts.Info, ID: trailerParts.ID, Prev: trailerParts.Prev });
      s += 'trailer\n' + ser(td) + '\nstartxref\n' + (xrefOff - doc.base) + '\n%%EOF\n';
      xref = ascii(s);
    }
    parts.push(xref);
    var out = concat([orig].concat(parts));

    // /ByteRange: [0, начало дыры (с «<»), после дыры (с «>»), до конца]
    var holeFrom = sigInfo.holeStart - 1, holeTo = sigInfo.holeStart + sigInfo.holeLen + 1;
    var br = [0, holeFrom, holeTo, out.length - holeTo];
    var brText = '/ByteRange [0 ' + pad(String(br[1]), 10) + ' ' + pad(String(br[2]), 10) + ' ' + pad(String(br[3]), 10) + ']';
    var head = latin1(out, sigInfo.objOffset, sigInfo.holeStart);
    var brPos = head.indexOf('/ByteRange [');
    var brEnd = head.indexOf(']', brPos) + 1;
    if (brText.length !== brEnd - brPos) throw PdfError('Внутренняя ошибка: ByteRange');
    out.set(ascii(brText), sigInfo.objOffset + brPos);
    return { bytes: out, byteRange: br, holeStart: sigInfo.holeStart, holeLen: sigInfo.holeLen };
  }

  function groups(entries) {
    var out = [], cur = null;
    entries.forEach(function (e) {
      if (cur && e.n === cur[cur.length - 1].n + 1) cur.push(e);
      else out.push(cur = [e]);
    });
    return out;
  }

  function signedBytes(prep) {
    var b = prep.bytes, r = prep.byteRange;
    return concat([b.subarray(r[0], r[0] + r[1]), b.subarray(r[2], r[2] + r[3])]);
  }

  function finish(prep, cms) {
    var hex = '';
    for (var i = 0; i < cms.length; i++) hex += ('0' + cms[i].toString(16)).slice(-2);
    hex = hex.toUpperCase();
    if (hex.length > prep.holeLen) throw PdfError('Подпись не помещается в отведённое место (' + cms.length + ' байт)');
    var out = new Uint8Array(prep.bytes);
    out.set(ascii(hex), prep.holeStart);
    return out;
  }

  // ---------------------------------------------------------------- поиск подписей (для проверки)
  function findSignatures(bytes) {
    var s = latin1(bytes), out = [];
    var re = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g, m;
    while ((m = re.exec(s))) {
      var br = [+m[1], +m[2], +m[3], +m[4]];
      // /Contents — шестнадцатеричная строка ровно в дыре ByteRange
      var hs = br[0] + br[1], he = br[2];
      if (s.charAt(hs) !== '<' || s.charAt(he - 1) !== '>') continue;
      var hex = s.slice(hs + 1, he - 1).replace(/\s+/g, '');
      var all = new Uint8Array(hex.length >> 1);
      for (var i = 0; i < all.length; i++) all[i] = parseInt(hex.substr(i * 2, 2), 16);
      // Длину подписи берём из её DER-заголовка: нули в конце — заполнитель, но сама подпись
      // тоже может заканчиваться нулевым байтом, поэтому «отрезать нули» нельзя.
      var cms = all.subarray(0, derLength(all));
      // словарь подписи: от ближайшего «obj» до «endobj»
      var objStart = s.lastIndexOf(' obj', m.index), objEnd = s.indexOf('endobj', he);
      var dictText = s.slice(objStart, objEnd < 0 ? he + 2000 : objEnd);
      var sub = /\/SubFilter\s*\/([A-Za-z0-9.#_-]+)/.exec(dictText);
      var nm = /\/M\s*\((D:[^)]*)\)/.exec(dictText);
      out.push({
        byteRange: br, cms: cms,
        subFilter: sub ? sub[1] : '',
        date: nm ? parsePdfDate(nm[1]) : null,
        coversWhole: br[2] + br[3] === bytes.length,
        coversToEOF: /%%EOF\s*$/.test(s.slice(br[2] + br[3] - 64, br[2] + br[3] + 2)) || br[2] + br[3] === bytes.length,
        signed: function (b, r) { return function () { return concat([b.subarray(r[0], r[0] + r[1]), b.subarray(r[2], r[2] + r[3])]); }; }(bytes, br)
      });
    }
    return out;
  }

  function derLength(b) {
    if (b.length < 2 || b[0] !== 0x30) return b.length;
    var l = b[1];
    if (l < 0x80) return Math.min(b.length, 2 + l);
    if (l === 0x80) return b.length;           // BER, неопределённая длина — разбор сам найдёт конец
    var n = l & 0x7f, len = 0;
    for (var i = 0; i < n; i++) len = len * 256 + b[2 + i];
    return Math.min(b.length, 2 + n + len);
  }

  function parsePdfDate(t) {
    var m = /D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Z+-])?(\d{2})?'?(\d{2})?/.exec(t);
    if (!m) return null;
    var d = Date.UTC(+m[1], (+m[2] || 1) - 1, +m[3] || 1, +m[4] || 0, +m[5] || 0, +m[6] || 0);
    if (m[7] === '+' || m[7] === '-') d -= (m[7] === '+' ? 1 : -1) * ((+m[8] || 0) * 60 + (+m[9] || 0)) * 60000;
    return new Date(d);
  }

  root.PdfInc = { open: open, prepare: prepare, signedBytes: signedBytes, finish: finish, findSignatures: findSignatures, _ser: ser };
})(typeof window !== 'undefined' ? window : globalThis);
