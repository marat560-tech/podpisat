/* Все внутренние ссылки и файлы на страницах сайта ведут туда, где что-то есть.
 *
 *   python3 build.py && node tests/links/run.js
 *
 * Адреса разбираем как Caddy на сервере: /help → help.html, /help/fns → help/fns.html, / → index.html.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SITE = path.join(__dirname, '..', '..', 'site');
if (!fs.existsSync(path.join(SITE, 'index.html'))) { console.error('Нет site/ — сначала python3 build.py'); process.exit(2); }

function pages(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? (e.name === 'static' || e.name === 'files' ? [] : pages(p)) : e.name.endsWith('.html') ? [p] : [];
  });
}
function resolves(url) {
  let p = decodeURIComponent(url.split(/[?#]/)[0]);
  if (p === '' || p === '/') p = '/index.html';
  const f = path.join(SITE, p);
  if (fs.existsSync(f) && fs.statSync(f).isFile()) return true;
  return fs.existsSync(f + '.html');
}

let checked = 0;
const broken = [];
for (const file of pages(SITE)) {
  const html = fs.readFileSync(file, 'utf8');
  const page = '/' + path.relative(SITE, file).replace(/\\/g, '/').replace(/\.html$/, '');
  const re = /\s(?:href|src)="(\/[^"]*)"/g;
  let m;
  while ((m = re.exec(html))) {
    const url = m[1];
    if (url.startsWith('//')) continue;                 // протокол-относительная внешняя ссылка
    if (url.startsWith('/files/')) continue;            // Help4x — кладётся при сборке на GitHub
    if (url.startsWith('/static/vendor/cadesplugin_api.js')) continue;  // скрипт КриптоПро: по лицензии не в репозитории, сервер скачивает при установке
    checked++;
    if (!resolves(url)) broken.push(page + ' → ' + url);
  }
}
const uniq = [...new Set(broken)];
uniq.forEach((b) => console.log('  ✗ ' + b));
console.log((uniq.length ? '' : '  ✓ все внутренние ссылки ведут на существующие страницы и файлы\n') +
  '\nСсылки — проверено: ' + checked + ', битых: ' + uniq.length);
process.exit(uniq.length ? 1 : 0);
