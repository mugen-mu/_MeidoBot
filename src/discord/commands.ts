// Определения команд (для скрипта регистрации scripts/register-commands.ts).
// integration_types: 0 — установка на сервер, 1 — на пользователя (команды работают в любом чате).
// contexts: 0 — сервер, 1 — личка с ботом, 2 — другие личные чаты.

const BOTH = [0, 1];
const EVERYWHERE = [0, 1, 2];

export const COMMANDS = [
  {
    name: "remind",
    description: "Напомнить: время и дело одной фразой («завтра в 10 купить хлеб», «каждый день в 9 таблетки»)",
    type: 1,
    integration_types: BOTH,
    contexts: EVERYWHERE,
    options: [{ type: 3, name: "text", description: "Когда и что, например: в пятницу в 15:00 отчёт", required: true, max_length: 400 }],
  },
  { name: "list", description: "Открытые дела", type: 1, integration_types: BOTH, contexts: EVERYWHERE },
  { name: "week", description: "Что на ближайшие 7 дней", type: 1, integration_types: BOTH, contexts: EVERYWHERE },
  { name: "menu", description: "Кнопочное меню: сегодня, добавить дело, ещё (видно только вам)", type: 1, integration_types: BOTH, contexts: EVERYWHERE, options: [{ type: 5, name: "panel", description: "Поставить закреплённую панель с кнопками в канал «бот»", required: false }] },
  { name: "settings", description: "Настройки: как часто напоминать, тишина, сводки, характер", type: 1, integration_types: BOTH, contexts: EVERYWHERE },
  { name: "setup", description: "Редко: завести каналы бота на этом сервере (один раз)", type: 1, integration_types: [0], contexts: [0] },
  // Команда из меню сообщения (долгое нажатие -> Приложения). Описание у такой команды не указывается.
  { name: "Напомнить об этом", type: 3, integration_types: BOTH, contexts: EVERYWHERE },
];
