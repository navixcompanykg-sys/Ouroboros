// Хранилище таблиц, которые заполняются на страницах (баланс компонентов и всё подобное).
//
// ПРАВИЛО (требование пользователя): введённое им НЕ ДОЛЖНО жить только в браузере. Истина —
// файл в папке data/ рядом с кодом: его видно в репозитории, он переживает чистку браузера,
// смену формата и мои правки. localStorage остаётся только зеркалом на случай, если страницу
// открыли без сервера (file://) — тогда хотя бы не потеряется до следующего запуска.
//
//   Store.load(name)        → {data, from}   — 'file' | 'local' | null
//   Store.save(name, obj)   → {ok, where}    — пишет в файл (POST /data/<name>.json) и в зеркало
//   Store.backup(name, obj) → имя копии      — сохраняет копию перед опасной операцией
//
// name — короткое имя без расширения: 'parts' → data/parts.json.
const Store = (() => {
  const key = name => `ouro.v3.${name}`;
  const url = name => `data/${name}.json`;

  async function load(name) {
    // 1. Файл проекта — главный источник.
    try {
      const r = await fetch(url(name) + '?t=' + Date.now(), { cache: 'no-store' });
      if (r.ok) {
        const data = await r.json();
        if (data && typeof data === 'object') {
          try { localStorage.setItem(key(name), JSON.stringify(data)); } catch (_) {}
          return { data, from: 'file' };
        }
      }
    } catch (_) { /* нет сервера или файла — ниже зеркало */ }
    // 2. Зеркало в браузере.
    try {
      const s = JSON.parse(localStorage.getItem(key(name)));
      if (s && typeof s === 'object') return { data: s, from: 'local' };
    } catch (_) {}
    return { data: null, from: null };
  }

  async function save(name, obj) {
    let local = false;
    try { localStorage.setItem(key(name), JSON.stringify(obj)); local = true; } catch (_) {}
    try {
      const r = await fetch(url(name), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj, null, 1),
      });
      if (r.ok) return { ok: true, where: 'file' };
    } catch (_) { /* страница открыта без serve.js */ }
    return { ok: local, where: local ? 'local' : 'none' };
  }

  // Копия перед опасной операцией (замена пресетом, сброс, смена формата): data/<name>-<дата>.json
  async function backup(name, obj) {
    const d = new Date(), p = n => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    const copy = `${name}-${stamp}`;
    const r = await save(copy, obj);
    return r.where === 'file' ? `data/${copy}.json` : null;
  }

  return { load, save, backup };
})();
