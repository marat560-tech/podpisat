/* подписатьэцп.рф — общая часть подписи: Рутокен Плагин и КриптоПро ЭЦП Browser plug-in.
 * ESign.start({onSelect})            — проверить плагины, показать список подписей
 * ESign.selected()                   — выбранный сертификат
 * ESign.signMany(cert, items, pin, opts, onProgress) — подписать несколько наборов данных (base64),
 *     PIN Рутокена вводится один раз; вернёт массив CMS (Uint8Array)
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var state = { certs: [], selected: null, rt: null, cp: false, onSelect: null };
  var SLOW_MS = 15000;

  function withTimeout(promise, ms) {
    return Promise.race([promise, new Promise(function (_, rej) {
      setTimeout(function () { rej(new Error('timeout')); }, ms);
    })]);
  }

  function setPlug(id, ok, text) {
    var el = $(id);
    if (!el) return;
    el.querySelector('.dot').className = 'dot ' + (ok === true ? 'ok' : ok === false ? 'err' : 'wait');
    el.querySelector('.st').innerHTML = text;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function fmtDate(d) {
    if (!d) return '';
    var dt = (d instanceof Date) ? d : new Date(d);
    if (isNaN(dt)) return String(d);
    return dt.toLocaleDateString('ru-RU');
  }

  function b64ToBytes(b64) {
    b64 = String(b64).replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
    var bin = atob(b64), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function bytesToB64(bytes) {
    var s = '', CH = 0x8000;
    for (var i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    return btoa(s);
  }

  // Разбор строки субъекта КриптоПро: "CN=..., O=..., ИНН=..."
  function parseDn(dn) {
    var out = {}, re = /(?:^|,\s*)([^=,]+)=("(?:[^"]|"")*"|[^,]*)/g, m;
    while ((m = re.exec(dn))) {
      var v = m[2].trim();
      if (v.charAt(0) === '"') v = v.slice(1, -1).replace(/""/g, '"');
      out[m[1].trim().toUpperCase()] = v;
    }
    return out;
  }

  function cleanSerial(s) { return String(s || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase(); }

  // ФИО: «Фамилия Имя Отчество» из SN + G, иначе CN
  function personName(sn, g, cn) {
    if (sn && g) return sn + ' ' + g;
    return cn || [sn, g].filter(Boolean).join(' ');
  }

  // ---------------------------------------------------------------- Рутокен Плагин
  // Настоящий Рутокен Плагин (через расширение-адаптер) возвращает не обычные Promise,
  // а «thenable»: у них есть .then, но нет .catch/.finally. Оборачиваем все методы,
  // чтобы дальше работать с обычными Promise.
  function promisifyPlugin(plugin) {
    var w = {};
    for (var k in plugin) (function (k) {
      var v = plugin[k];
      if (typeof v === 'function') {
        w[k] = function () {
          var args = arguments;
          return new Promise(function (res, rej) {
            try { Promise.resolve(v.apply(plugin, args)).then(res, rej); } catch (e) { rej(e); }
          });
        };
      } else {
        w[k] = v;
      }
    })(k);
    return w;
  }

  function initRutoken() {
    if (!window.rutoken) { setPlug('plug-rt', false, 'Не удалось загрузить модуль.'); return Promise.resolve(); }
    return withTimeout(rutoken.ready, 8000).then(function () {
      var isChromium = !!window.chrome || /Firefox|YaBrowser|Edg\//.test(navigator.userAgent);
      return isChromium ? rutoken.isExtensionInstalled() : true;
    }).then(function (ext) {
      if (!ext) throw new Error('noext');
      return rutoken.isPluginInstalled();
    }).then(function (plug) {
      if (!plug) throw new Error('noplugin');
      return rutoken.loadPlugin();
    }).then(function (plugin) {
      state.rt = promisifyPlugin(plugin);
      var ver = plugin.version ? ' (версия ' + esc(plugin.version) + ')' : '';
      setPlug('plug-rt', true, 'Установлен' + ver + '.');
    }).catch(function (e) {
      if (e && e.message === 'noext') {
        setPlug('plug-rt', false, 'Нет расширения «Адаптер Рутокен Плагин» в браузере. <a href="https://chromewebstore.google.com/detail/ohedcglhbbfdgaogjhcclacoccbagkjg" target="_blank" rel="noopener">Установить расширение</a>');
        return;
      }
      var msg = e && e.message === 'noplugin' ? 'Расширение есть, но не установлен сам Рутокен Плагин.' : 'Не найден.';
      setPlug('plug-rt', false, msg + ' <a href="https://www.rutoken.ru/support/download/rutoken-plugin/" target="_blank" rel="noopener">Установить</a>');
    });
  }

  function rtCertList() {
    var p = state.rt, list = [];
    if (!p) return Promise.resolve(list);
    return p.enumerateDevices().then(function (devices) {
      return devices.reduce(function (chain, dev) {
        return chain.then(function () {
          var label = '';
          return p.getDeviceInfo(dev, p.TOKEN_INFO_LABEL).then(function (l) { label = l; }, function () {})
            .then(function () { return p.enumerateCertificates(dev, p.CERT_CATEGORY_USER); })
            .then(function (ids) {
              return ids.reduce(function (c2, id) {
                return c2.then(function () {
                  return p.parseCertificate(dev, id).then(function (info) {
                    var subj = {}, iss = {};
                    (info.subject || []).forEach(function (x) { subj[x.rdn] = x.value; });
                    (info.issuer || []).forEach(function (x) { iss[x.rdn] = x.value; });
                    list.push({
                      src: 'rt', device: dev, id: id, label: label,
                      who: subj.commonName || subj.surname || 'Сертификат',
                      person: personName(subj.surname, subj.givenName, subj.commonName),
                      org: subj.organizationName || '',
                      title: subj.title || '',
                      inn: subj.INN || subj.INNLE || subj['1.2.643.3.131.1.1'] || subj['1.2.643.100.4'] || '',
                      issuer: iss.commonName || iss.organizationName || '',
                      serial: cleanSerial(info.serialNumber),
                      validFrom: info.validNotBefore,
                      validTo: info.validNotAfter,
                      expired: info.validNotAfter ? new Date(info.validNotAfter) < new Date() : false
                    });
                  });
                });
              }, Promise.resolve());
            }).catch(function () {});
        });
      }, Promise.resolve());
    }).then(function () { return list; });
  }

  function rtErrorText(e) {
    var p = state.rt, code = e && (e.message || e);
    var codes = (p && p.errorCodes) || {};
    if (String(code) === String(codes.PIN_INCORRECT)) return 'Неверный PIN-код.';
    if (String(code) === String(codes.PIN_LOCKED)) return 'PIN-код заблокирован — слишком много неверных попыток.';
    if (String(code) === String(codes.DEVICE_NOT_FOUND)) return 'Рутокен не найден — проверьте, что он вставлен.';
    if (String(code) === String(codes.CERTIFICATE_NOT_FOUND)) return 'Сертификат не найден на Рутокене.';
    if (String(code) === String(codes.KEY_NOT_FOUND)) return 'На Рутокене нет закрытого ключа для этого сертификата.';
    if (e && e.friendly) return e.message;
    return 'Ошибка Рутокен Плагина: ' + esc(code);
  }

  function rtSignMany(cert, items, pin, opts, onProgress) {
    var p = state.rt, out = [];
    if (typeof p.DATA_FORMAT_BASE64 === 'undefined') {
      var err = new Error('Установленная версия Рутокен Плагина слишком старая — обновите её.');
      err.friendly = true;
      return Promise.reject(err);
    }
    var options = {
      detached: true,
      addUserCertificate: true,
      addSignTime: opts.signTime !== false,
      addEssCertV2: true,
      useHardwareHash: false
    };
    return p.login(cert.device, pin).then(function () {
      return items.reduce(function (chain, b64, i) {
        return chain.then(function () {
          if (onProgress) onProgress(i, items.length);
          return p.sign(cert.device, cert.id, b64, p.DATA_FORMAT_BASE64, options).then(function (cms) { out.push(b64ToBytes(cms)); });
        });
      }, Promise.resolve());
    }).then(function () {
      return p.logout(cert.device).then(function () { return out; }, function () { return out; });
    }, function (e) {
      return p.logout(cert.device).then(function () { throw e; }, function () { throw e; });
    });
  }

  // ---------------------------------------------------------------- КриптоПро
  function initCryptoPro() {
    if (!window.cadesplugin) {
      setPlug('plug-cp', false, 'Не найден. <a href="https://www.cryptopro.ru/products/cades/plugin" target="_blank" rel="noopener">Установить</a>');
      return Promise.resolve();
    }
    return withTimeout(Promise.resolve(window.cadesplugin), 10000).then(function () {
      return cadesplugin.CreateObjectAsync('CAdESCOM.About');
    }).then(function (about) {
      return about.PluginVersion.then(function (v) { return v.toString(); }).catch(function () { return ''; });
    }).then(function (ver) {
      state.cp = true;
      setPlug('plug-cp', true, 'Установлен' + (ver ? ' (версия ' + esc(ver) + ')' : '') + '.');
    }).catch(function () {
      setPlug('plug-cp', false, 'Не найден. <a href="https://www.cryptopro.ru/products/cades/plugin" target="_blank" rel="noopener">Установить</a>');
    });
  }

  function cpCertList() {
    if (!state.cp) return Promise.resolve([]);
    var c = window.cadesplugin, list = [];
    return c.CreateObjectAsync('CAdESCOM.Store').then(function (store) {
      return store.Open(c.CAPICOM_CURRENT_USER_STORE, c.CAPICOM_MY_STORE, c.CAPICOM_STORE_OPEN_MAXIMUM_ALLOWED)
        .then(function () { return store.Certificates; })
        .then(function (certs) {
          return certs.Count.then(function (n) {
            var chain = Promise.resolve();
            for (var i = 1; i <= n; i++) (function (i) {
              chain = chain.then(function () {
                return certs.Item(i).then(function (cert) {
                  return Promise.all([cert.SubjectName, cert.ValidToDate, cert.Thumbprint, cert.HasPrivateKey(),
                    cert.SerialNumber, cert.ValidFromDate, cert.IssuerName])
                    .then(function (v) {
                      if (!v[3]) return;
                      var dn = parseDn(v[0]), idn = parseDn(v[6]);
                      list.push({
                        src: 'cp', cert: cert, id: v[2],
                        who: dn.CN || 'Сертификат',
                        person: personName(dn.SN, dn.G, dn.CN),
                        org: dn.O || '', title: dn.T || '',
                        inn: dn['ИНН'] || dn['INN'] || dn['ИНН ЮЛ'] || dn['INNLE'] || '',
                        issuer: idn.CN || idn.O || '',
                        serial: cleanSerial(v[4]),
                        validFrom: v[5], validTo: v[1], expired: new Date(v[1]) < new Date()
                      });
                    });
                }).catch(function () {});
              });
            })(i);
            return chain;
          });
        })
        .then(function () { return store.Close(); });
    }).then(function () { return list; });
  }

  function cpSignOne(cert, b64, opts) {
    var c = window.cadesplugin;
    var signer, sd;
    return c.CreateObjectAsync('CAdESCOM.CPSigner').then(function (s) {
      signer = s;
      return signer.propset_Certificate(cert.cert);
    }).then(function () {
      return signer.propset_Options(c.CAPICOM_CERTIFICATE_INCLUDE_END_ENTITY_ONLY);
    }).then(function () {
      if (opts.signTime === false) return;
      return c.CreateObjectAsync('CADESCOM.CPAttribute').then(function (attr) {
        return attr.propset_Name(c.CAPICOM_AUTHENTICATED_ATTRIBUTE_SIGNING_TIME)
          .then(function () { return attr.propset_Value(new Date()); })
          .then(function () { return signer.AuthenticatedAttributes2; })
          .then(function (attrs) { return attrs.Add(attr); });
      }).catch(function () { /* время подписи добавит сам КриптоПро */ });
    }).then(function () {
      return c.CreateObjectAsync('CAdESCOM.CadesSignedData');
    }).then(function (o) {
      sd = o;
      return sd.propset_ContentEncoding(c.CADESCOM_BASE64_TO_BINARY);
    }).then(function () {
      return sd.propset_Content(b64);
    }).then(function () {
      return sd.SignCades(signer, c.CADESCOM_CADES_BES, true);
    }).then(b64ToBytes);
  }

  function cpSignMany(cert, items, opts, onProgress) {
    var out = [];
    return items.reduce(function (chain, b64, i) {
      return chain.then(function () {
        if (onProgress) onProgress(i, items.length);
        return cpSignOne(cert, b64, opts).then(function (cms) { out.push(cms); });
      });
    }, Promise.resolve()).then(function () { return out; });
  }

  function cpErrorText(e) {
    var msg = (window.cadesplugin && cadesplugin.getLastError) ? cadesplugin.getLastError(e) : (e && e.message) || String(e);
    if (/0x8010006E|отменен|cancel/i.test(msg)) return 'Подписание отменено.';
    if (/0x8009001D|пароль|PIN/i.test(msg)) return 'Неверный пароль (PIN) от ключа.';
    return 'Ошибка КриптоПро: ' + esc(msg);
  }

  // ---------------------------------------------------------------- список подписей
  function renderCerts() {
    var box = $('certs');
    var notes = (state.certNotes || []).map(function (t) { return '<div class="note wait">' + t + '</div>'; }).join('');
    if (!state.certs.length) {
      box.innerHTML = notes || (state.searching ? '' :
        '<div class="note info">Подписей не найдено. Вставьте ключ и нажмите «Обновить список». Если ключ вставлен — проверьте плагины выше.</div>');
      return;
    }
    box.innerHTML = notes + state.certs.map(function (c, i) {
      var badge = c.src === 'rt' ? '<span class="badge rt">Рутокен</span>' : '<span class="badge cp">КриптоПро</span>';
      var sel = state.selected === c ? ' sel' : '';
      var bad = c.expired ? ' bad' : '';
      var meta = [c.org !== c.who ? c.org : '', c.inn ? 'ИНН ' + c.inn : '', c.validTo ? (c.expired ? 'истёк ' : 'действует до ') + fmtDate(c.validTo) : '']
        .filter(Boolean).map(esc).join(' · ');
      return '<label class="cert' + sel + bad + '"><input type="radio" name="cert" value="' + i + '"' + (sel ? ' checked' : '') + (c.expired ? ' disabled' : '') + '>' +
        '<div><div class="who">' + esc(c.who) + badge + '</div><div class="meta">' + meta + '</div></div></label>';
    }).join('');
    Array.prototype.forEach.call(box.querySelectorAll('input[name=cert]'), function (inp) {
      inp.addEventListener('change', function () {
        select(state.certs[+inp.value]);
        renderCerts();
      });
    });
  }

  function select(c) {
    var changed = state.selected !== c;
    state.selected = c;
    var pf = $('pin-field');
    if (pf) pf.hidden = !(c && c.src === 'rt');
    if (changed && state.onSelect) state.onSelect(c);
  }

  // Каждый плагин опрашиваем отдельно: подписи показываем по мере появления,
  // а если плагин молчит (обычно ждёт ответа в своём окне, спрятанном за браузером) — подсказываем.
  function refreshCerts() {
    var gen = state.refreshGen = (state.refreshGen || 0) + 1;
    var found = { rt: [], cp: [] }, errs = {};
    var st = { rt: state.rt ? 'wait' : 'off', cp: state.cp ? 'wait' : 'off' };

    function update() {
      if (gen !== state.refreshGen) return;
      state.certs = found.rt.concat(found.cp);
      var sel = state.selected;
      if (sel && state.certs.indexOf(sel) < 0) {
        // тот же сертификат после обновления списка
        sel = state.certs.find(function (c) { return c.src === sel.src && c.id === sel.id; }) || null;
      }
      var valid = state.certs.filter(function (c) { return !c.expired; });
      if (!sel && valid.length === 1) sel = valid[0];
      state.searching = st.rt === 'wait' || st.rt === 'slow' || st.cp === 'wait' || st.cp === 'slow';
      var notes = [];
      if (st.rt === 'slow') notes.push('Рутокен Плагин долго не отвечает. Проверьте, что Рутокен вставлен, и нет ли окна плагина с вопросом о доступе — оно может прятаться за браузером.');
      if (st.cp === 'slow') notes.push('КриптоПро долго не отвечает. Скорее всего, открыто окно «Подтверждение доступа» — оно может прятаться за браузером. Найдите его на панели задач и нажмите «Да», подписи появятся сами.');
      if (errs.rt) notes.push(errs.rt);
      if (errs.cp) notes.push(errs.cp);
      state.certNotes = notes;
      $('refresh').disabled = st.rt === 'wait' || st.cp === 'wait';
      select(sel);
      renderCerts();
      $('cert-hint').textContent = state.searching ? 'Ищем подписи…'
        : state.certs.length ? 'Найдено подписей: ' + state.certs.length : 'Вставьте ключ и нажмите «Обновить список».';
    }

    function run(key, list) {
      if (st[key] === 'off') return Promise.resolve();
      var slow = setTimeout(function () { if (st[key] === 'wait') { st[key] = 'slow'; update(); } }, SLOW_MS);
      return list().then(function (l) { found[key] = l; st[key] = 'ok'; }, function (e) {
        st[key] = 'err';
        errs[key] = key === 'rt' ? rtErrorText(e) : cpErrorText(e);
      }).then(function () { clearTimeout(slow); update(); });
    }

    update();
    return Promise.all([run('rt', rtCertList), run('cp', cpCertList)]);
  }

  var ready = null;

  window.ESign = {
    start: function (opts) {
      state.onSelect = opts && opts.onSelect;
      $('refresh').addEventListener('click', refreshCerts);
      ready = Promise.all([initRutoken(), initCryptoPro()]).then(function () {
        var names = [state.rt ? 'Рутокен' : '', state.cp ? 'КриптоПро' : ''].filter(Boolean);
        var sum = $('plug-sum'), dot = $('plug-sum-dot'), box = $('plugbox');
        if (sum) {
          sum.textContent = names.length ? 'Плагин для подписи готов: ' + names.join(' и ') : 'Не найден плагин для подписи — установите его, это бесплатно';
          dot.className = 'dot ' + (names.length ? 'ok' : 'err');
          box.classList.toggle('bad', !names.length);
          if (!names.length) box.open = true;
        }
        if (!state.rt && !state.cp) {
          $('cert-hint').innerHTML = 'Сначала установите плагин для подписи (подсказка выше).';
        }
      });
      return ready;
    },
    // Запросить список подписей (один раз, когда пользователь выбрал файл)
    ensureCerts: function () {
      if (state.certsRequested) return;
      state.certsRequested = true;
      (ready || Promise.resolve()).then(refreshCerts);
    },
    selected: function () { return state.selected; },
    signMany: function (cert, items, pin, opts, onProgress) {
      opts = opts || {};
      return (cert.src === 'rt' ? rtSignMany(cert, items, pin, opts, onProgress) : cpSignMany(cert, items, opts, onProgress))
        .catch(function (e) {
          var err = new Error(cert.src === 'rt' ? rtErrorText(e) : cpErrorText(e));
          err.friendly = true;
          throw err;
        });
    },
    esc: esc, fmtDate: fmtDate, b64ToBytes: b64ToBytes, bytesToB64: bytesToB64
  };
})();
