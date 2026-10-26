/* подписатьэцп.рф — передача выбранных файлов с главной на нужную страницу.
 * Файлы хранятся в IndexedDB этого браузера несколько секунд и никуда не отправляются.
 * Handoff.put(files) -> Promise;  Handoff.take() -> Promise<File[]>
 */
(function () {
  'use strict';
  var DB = 'podp-handoff', STORE = 'files', KEY = 'pending', TTL = 2 * 60 * 1000;

  function open() {
    return new Promise(function (res, rej) {
      if (!window.indexedDB) { rej(new Error('no idb')); return; }
      var r = indexedDB.open(DB, 1);
      r.onupgradeneeded = function () { r.result.createObjectStore(STORE); };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  }

  function tx(mode, fn) {
    return open().then(function (db) {
      return new Promise(function (res, rej) {
        var t = db.transaction(STORE, mode), st = t.objectStore(STORE), out;
        fn(st, function (v) { out = v; });
        t.oncomplete = function () { db.close(); res(out); };
        t.onerror = function () { db.close(); rej(t.error); };
      });
    });
  }

  window.Handoff = {
    put: function (files) {
      var list = Array.prototype.slice.call(files);
      return tx('readwrite', function (st) { st.put({ at: Date.now(), files: list }, KEY); });
    },
    take: function () {
      return tx('readwrite', function (st, set) {
        var g = st.get(KEY);
        g.onsuccess = function () { set(g.result); st.delete(KEY); };
      }).then(function (v) {
        return v && Date.now() - v.at < TTL ? v.files : [];
      }).catch(function () { return []; });
    }
  };
})();
