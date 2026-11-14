// Простейший статический сервер для разработки: node serve.js
// Слушает все интерфейсы — с телефона в той же сети открывайте адрес, напечатанный при старте.
//
// Кроме раздачи статики умеет ОДНУ вещь: сохранять таблицы, которые заполняются на страницах
// (баланс компонентов и всё подобное), в файлы проекта — папка data/. Требование пользователя:
// «все создаваемые таблицы должны сохраняться в файлы, а не умирать после каждой смены».
// Браузерное хранилище ненадёжно и не видно в репозитории, поэтому истина — файл на диске.
//   GET  /data/<имя>.json   — отдаётся как обычная статика
//   POST /data/<имя>.json   — тело запроса пишется в файл (создаётся папка, пишется атомарно)
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = process.env.PORT || 8080;
const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };
const MAX_BODY = 8 * 1024 * 1024;             // таблицы маленькие; защита от случайного мусора

// Сохранение таблицы: имя — только из латиницы, цифр, дефиса и подчёркивания, всегда .json.
function saveData(req, res, name) {
  if (!/^[a-z0-9_-]+\.json$/i.test(name)) { res.writeHead(400); return res.end('bad name'); }
  let body = '', tooBig = false;
  req.on('data', c => {
    body += c;
    if (body.length > MAX_BODY && !tooBig) { tooBig = true; res.writeHead(413); res.end('too big'); req.destroy(); }
  });
  req.on('end', () => {
    if (tooBig) return;
    try { JSON.parse(body); } catch (_) { res.writeHead(400); return res.end('not json'); }
    try {
      fs.mkdirSync(DATA, { recursive: true });
      const file = path.join(DATA, name), tmp = file + '.tmp';
      fs.writeFileSync(tmp, body);            // сперва во временный, потом заменяем — не потеряем
      fs.renameSync(tmp, file);               // файл при обрыве записи
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, file: 'data/' + name, bytes: Buffer.byteLength(body) }));
      console.log(`сохранено data/${name} (${Buffer.byteLength(body)} б)`);
    } catch (e) {
      res.writeHead(500); res.end(String(e && e.message || e));
    }
  });
}

http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (req.method === 'POST' && p.startsWith('/data/')) return saveData(req, res, p.slice('/data/'.length));
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  if (p === '/') p = '/menu.html'; // вход — меню игры
  else if (p.endsWith('/')) p += 'index.html';
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': (TYPES[path.extname(file)] || 'application/octet-stream') + '; charset=utf-8',
      'Cache-Control': 'no-store' });
    res.end(data);
  });
}).listen(PORT, () => {
  console.log(`http://localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces()))
    for (const a of list) if (a.family === 'IPv4' && !a.internal) console.log(`телефон: http://${a.address}:${PORT}`);
});
