# OUROBOROS — инструкции для Claude Code

## Git / GitHub
- **Не коммитить и не пушить автоматически.** Делать это только по явной просьбе пользователя («сохрани в гит», «загрузи на гитхаб», «закоммить» и т.п.).
- Синхронизировать три файла при любом изменении конфига: `galaxy.html` (блок CFG), `config.json`, `config.html` (getDefaults).

## Структура проекта
- `server/galaxy.html` — основная симуляция, физика, рендер, UI
- `server/config.json` — конфигурация (читается сервером и клиентом)
- `server/config.html` — UI-редактор конфига, должен совпадать с config.json и CFG в galaxy.html
- `server/main.go` — Go HTTP-сервер
- `docs/OUROBOROS_design.md` — основное ТЗ
- `docs/TZStarsGEN.md` — ТЗ по кодам генерации звёзд
