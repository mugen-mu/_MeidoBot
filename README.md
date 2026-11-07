# DiscordBot (Meido)

Личный Discord-бот Ihor: напоминания, которые не исчезают, пока не нажато «Готово»; повторяющиеся дела и сроки; позже — «Входящие» и порядок в заметках. Бесплатно: Cloudflare Workers + D1, Discord по HTTP Interactions, без включённого ПК.

**Статус (2026-11-07):** этап 1 (ядро) написан и проверен локально (149 тестов, сухой прогон, локальный движок Cloudflare). Дальше этап 2 — установка и проверка на живом боте (`NEXT-STEPS.md`).

## Команды разработчика

```bash
npm install
npm test            # 149 тестов (время, повторы, лестница, база, cron, Discord)
npm run typecheck   # tsc --noEmit
npm run dry-run     # сутки работы бота на базе-заглушке и поддельном Discord
npm run register    # регистрация команд в Discord (нужны DISCORD_APP_ID и DISCORD_BOT_TOKEN в .dev.vars)
```

## Карта

- `CLAUDE.md` — правила проекта.
- `docs/DESIGN.md` — как устроено и почему; `docs/DECISIONS.md` — решения; `docs/BRIEF-original.md` — исходное ТЗ.
- `src/time/` — часовые пояса, разбор русских фраз, подписи; `src/recur.ts` — повторы; `src/ladder.ts` — лестница настойчивости.
- `src/db/` + `migrations/` — слой D1 и схема; `src/service.ts` — действия над делами; `src/settings.ts` — настройки.
- `src/cron.ts` — цикл раз в минуту; `src/discord/` — подпись, REST, команды, кнопки и окна; `src/worker.ts` — вход Worker.
- `test/` — тесты (`d1shim.ts` — оболочка D1 на `node:sqlite`, `fakeDiscord.ts` — поддельный Discord); `scripts/` — регистрация команд и сухой прогон.
- `design/` — исходники страницы решений.
