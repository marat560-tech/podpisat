/* подписатьэцп.рф — подпись файлов в браузере.
 * Рутокен Плагин и КриптоПро ЭЦП Browser plug-in.
 * Результат: отделённая подпись CMS (CAdES-BES), ГОСТ Р 34.10-2012,
 * упакованная как у СБИС/КриптоАРМ: <имя>.zip = <имя> + <имя без расширения>SGN1.sig
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var state = { file: null, fileB64: null, certs: [], selected: null, rt: null, cp: false };
  var MAX_SIZE = 50 * 1024 * 1024;
  var SLOW_MS = 15000;

  // ---------------------------------------------------------------- помощники
  function withTimeout(promise, ms) {
    return Promise.race([promise, new Promise(function (_, rej) {
      setTimeout(function () { rej(new Error('timeout')); }, ms);
    })]);
  }

  function setPlug(id, ok, text) {
    var el = $(id);
    el.querySelector('.dot').className = 'dot ' + (ok === true ? 'ok' : ok === false ? 'err' : 'wait');
    el.querySelector('.st').innerHTML = text;
  }

  function status(kind, html) {
    $('status').innerHTML = html ? '<div class="note ' + kind + '">' + html + '</div>' : '';
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function fmtSize(n) {
    if (n < 1024) return n + ' Б';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1).replace('.', ',') + ' КБ';
    return (n / 1024 / 1024).toFixed(1).replace('.', ',') + ' МБ';
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

  function readFileB64(file) {
    return new Promise(function (res, rej) {
      var r = new FileReader();
      r.onload = function () { res(String(r.result).split(',')[1] || ''); };
      r.onerror = function () { rej(r.error); };
      r.readAsDataURL(file);
    });
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

  function sigNames(fileName) {
    var dot = fileName.lastIndexOf('.');
    var base = dot > 0 ? fileName.slice(0, dot) : fileName;
    return { sig: base + 'SGN1.sig', zip: fileName + '.zip' };
  }

  // ---------------------------------------------------------------- Рутокен Плагин
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
      state.rt = plugin;
      var ver = plugin.version ? ' (версия ' + esc(plugin.version) + ')' : '';
      setPlug('plug-rt', true, 'Установлен' + ver + '.');
    }).catch(function (e) {
      if (e && e.message === 'noext') {
        setPlug('plug-rt', false, 'Нет расширения «Адаптер Рутокен Плагин» в браузере. <a href="https://chromewebstore.google.com/detail/ohedcglhbbfdgaogjhcclacoccbagkjg" target="_blank" rel="noopener">Установить расширение</a>');
        return;
      }
      var msg = e && e.message === 'noext'
        ? 'Нет расширения «Адаптер Рутокен Плагин» в браузере.'
        : e && e.message === 'noplugin'
          ? 'Расширение есть, но не установлен сам Рутокен Плагин.'
          : 'Не найден.';
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
                    var subj = {};
                    (info.subject || []).forEach(function (x) { subj[x.rdn] = x.value; });
                    list.push({
                      src: 'rt', device: dev, id: id, label: label,
                      who: subj.commonName || subj.surname || 'Сертификат',
                      org: subj.organizationName || '',
                      inn: subj.INN || subj.INNLE || subj['1.2.643.3.131.1.1'] || subj['1.2.643.100.4'] || '',
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
    return 'Ошибка Рутокен Плагина: ' + esc(code);
  }

  function rtSign(cert, pin) {
    var p = state.rt;
    var options = {
      detached: true,
      addUserCertificate: true,
      addSignTime: true,
      addEssCertV2: true,
      useHardwareHash: false
    };
    var doSign = function () {
      if (typeof p.DATA_FORMAT_BASE64 !== 'undefined') {
        return p.sign(cert.device, cert.id, state.fileB64, p.DATA_FORMAT_BASE64, options);
      }
      throw new Error('Установленная версия Рутокен Плагина слишком старая — обновите её.');
    };
    return p.login(cert.device, pin)
      .then(doSign)
      .then(function (cms) {
        return p.logout(cert.device).then(function () { return cms; }, function () { return cms; });
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
                  return Promise.all([cert.SubjectName, cert.ValidToDate, cert.Thumbprint, cert.HasPrivateKey()])
                    .then(function (v) {
                      if (!v[3]) return;
                      var dn = parseDn(v[0]);
                      list.push({
                        src: 'cp', cert: cert, id: v[2],
                        who: dn.CN || 'Сертификат', org: dn.O || '',
                        inn: dn['ИНН'] || dn['INN'] || dn['ИНН ЮЛ'] || dn['INNLE'] || '',
                        validTo: v[1], expired: new Date(v[1]) < new Date()
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

  function cpSign(cert) {
    var c = window.cadesplugin;
    var signer, sd;
    return c.CreateObjectAsync('CAdESCOM.CPSigner').then(function (s) {
      signer = s;
      return signer.propset_Certificate(cert.cert);
    }).then(function () {
      return signer.propset_Options(c.CAPICOM_CERTIFICATE_INCLUDE_END_ENTITY_ONLY);
    }).then(function () {
      return c.CreateObjectAsync('CADESCOM.CPAttribute');
    }).then(function (attr) {
      return attr.propset_Name(c.CAPICOM_AUTHENTICATED_ATTRIBUTE_SIGNING_TIME)
        .then(function () { return attr.propset_Value(new Date()); })
        .then(function () { return signer.AuthenticatedAttributes2; })
        .then(function (attrs) { return attrs.Add(attr); })
        .catch(function () { /* время подписи добавит сам КриптоПро */ });
    }).then(function () {
      return c.CreateObjectAsync('CAdESCOM.CadesSignedData');
    }).then(function (o) {
      sd = o;
      return sd.propset_ContentEncoding(c.CADESCOM_BASE64_TO_BINARY);
    }).then(function () {
      return sd.propset_Content(state.fileB64);
    }).then(function () {
      return sd.SignCades(signer, c.CADESCOM_CADES_BES, true);
    });
  }

  function cpErrorText(e) {
    var msg = (window.cadesplugin && cadesplugin.getLastError) ? cadesplugin.getLastError(e) : (e && e.message) || String(e);
    if (/0x8010006E|отменен|cancel/i.test(msg)) return 'Подписание отменено.';
    if (/0x8009001D|пароль|PIN/i.test(msg)) return 'Неверный пароль (PIN) от ключа.';
    return 'Ошибка КриптоПро: ' + esc(msg);
  }

  // ---------------------------------------------------------------- интерфейс
  function enable(stepId, on) { $(stepId).classList.toggle('off', !on); }

  function updateSignButton() {
    var ready = state.file && state.selected && !state.selected.expired;
    $('sign').disabled = !ready;
    $('pin-field').hidden = !(state.selected && state.selected.src === 'rt');
    enable('st3', !!ready);
  }

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
        state.selected = state.certs[+inp.value];
        renderCerts();
        updateSignButton();
      });
    });
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
      if (state.selected && state.certs.indexOf(state.selected) < 0) state.selected = null;
      var valid = state.certs.filter(function (c) { return !c.expired; });
      if (!state.selected && valid.length === 1) state.selected = valid[0];
      state.searching = st.rt === 'wait' || st.rt === 'slow' || st.cp === 'wait' || st.cp === 'slow';
      var notes = [];
      if (st.rt === 'slow') notes.push('Рутокен Плагин долго не отвечает. Проверьте, что Рутокен вставлен, и нет ли окна плагина с вопросом о доступе — оно может прятаться за браузером.');
      if (st.cp === 'slow') notes.push('КриптоПро долго не отвечает. Скорее всего, открыто окно «Подтверждение доступа» — оно может прятаться за браузером. Найдите его на панели задач и нажмите «Да», подписи появятся сами.');
      if (errs.rt) notes.push(errs.rt);
      if (errs.cp) notes.push(errs.cp);
      state.certNotes = notes;
      $('refresh').disabled = st.rt === 'wait' || st.cp === 'wait';
      renderCerts();
      updateSignButton();
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

  function setFile(file) {
    $('result').hidden = true;
    status();
    if (!file) return;
    if (file.size > MAX_SIZE) {
      status('err', 'Файл больше 50 МБ — такой большой файл браузерный плагин может не осилить.');
      return;
    }
    state.file = file;
    state.fileB64 = null;
    $('chip').hidden = false;
    $('chip').innerHTML = '📄 <div><b>' + esc(file.name) + '</b><div class="small muted">' + fmtSize(file.size) + ' · <a href="#" id="change">выбрать другой</a></div></div>';
    $('drop').hidden = true;
    $('change').addEventListener('click', function (e) { e.preventDefault(); $('file').value = ''; $('drop').hidden = false; $('chip').hidden = true; state.file = null; updateSignButton(); });
    enable('st2', true);
    updateSignButton();
    if (!state.certs.length) refreshCerts();
  }

  function doSign() {
    var cert = state.selected, file = state.file;
    if (!cert || !file) return;
    var pin = $('pin').value;
    if (cert.src === 'rt' && !pin) { status('err', 'Введите PIN-код Рутокена.'); $('pin').focus(); return; }
    $('sign').disabled = true;
    $('result').hidden = true;
    status('wait', 'Подписываем… Если появится окно плагина — подтвердите.');
    var names = sigNames(file.name);
    readFileB64(file).then(function (b64) {
      state.fileB64 = b64;
      return cert.src === 'rt' ? rtSign(cert, pin) : cpSign(cert);
    }).then(function (cmsB64) {
      var sig = b64ToBytes(cmsB64);
      var zip = new JSZip();
      zip.file(file.name, file);
      zip.file(names.sig, sig);
      return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' }).then(function (zipBlob) {
        var sigBlob = new Blob([sig], { type: 'application/pkcs7-signature' });
        var a = $('dl-zip'), b = $('dl-sig');
        if (a.href) URL.revokeObjectURL(a.href);
        if (b.href) URL.revokeObjectURL(b.href);
        a.href = URL.createObjectURL(zipBlob); a.download = names.zip;
        b.href = URL.createObjectURL(sigBlob); b.download = names.sig;
        $('sig-info').innerHTML =
          '<dt>Подписант</dt><dd>' + esc(cert.who) + (cert.org && cert.org !== cert.who ? ', ' + esc(cert.org) : '') + '</dd>' +
          (cert.inn ? '<dt>ИНН</dt><dd>' + esc(cert.inn) + '</dd>' : '') +
          '<dt>Время</dt><dd>' + esc(new Date().toLocaleString('ru-RU')) + '</dd>' +
          '<dt>Архив</dt><dd>' + esc(names.zip) + ' (' + fmtSize(zipBlob.size) + ')</dd>' +
          '<dt>Подпись</dt><dd>' + esc(names.sig) + ' (' + fmtSize(sig.length) + ')</dd>';
        status();
        $('result').hidden = false;
        $('pin').value = '';
      });
    }).catch(function (e) {
      status('err', cert.src === 'rt' ? rtErrorText(e) : cpErrorText(e));
    }).finally(function () {
      state.fileB64 = null;
      updateSignButton();
    });
  }

  // ---------------------------------------------------------------- старт
  document.addEventListener('DOMContentLoaded', function () {
    var drop = $('drop'), input = $('file');
    input.addEventListener('change', function () { setFile(input.files[0]); });
    ['dragenter', 'dragover'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); });
    });
    drop.addEventListener('drop', function (e) { if (e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]); });
    $('refresh').addEventListener('click', refreshCerts);
    $('sign').addEventListener('click', doSign);
    $('pin').addEventListener('keydown', function (e) { if (e.key === 'Enter' && !$('sign').disabled) doSign(); });
    Promise.all([initRutoken(), initCryptoPro()]).then(function () {
      if (!state.rt && !state.cp) {
        $('cert-hint').innerHTML = 'Не найден ни один плагин для подписи — установите один из них (ссылки выше).';
      }
    });
  });
})();
