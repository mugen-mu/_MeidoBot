// Определения команд (для скрипта регистрации scripts/register-commands.ts).
// integration_types: 0 — установка на сервер, 1 — на пользователя (команды работают в любом чате).
// contexts: 0 — сервер, 1 — личка с ботом, 2 — другие личные чаты.

const BOTH = [0, 1];
const EVERYWHERE = [0, 1, 2];

export const COMMANDS = [
  {
    name: "remind",
    description: "Напомнить: время и дело одной фразой («завтра в 10 купить хлеб»)",
    type: 1,
    integration_types: BOTH,
    contexts: EVERYWHERE,
    options: [{ type: 3, name: "text", description: "Когда и что, например: в пятницу в 15:00 отчёт", required: true, max_length: 400 }],
  },
  {
    name: "every",
    description: "Повторять («каждые 20 минут проверить плиту до 23:00», «каждый месяц 20-го …»)",
    type: 1,
    integration_types: BOTH,
    contexts: EVERYWHERE,
    options: [{ type: 3, name: "text", description: "Как часто и что, например: каждую вторую пятницу в 15:00 отчёт", required: true, max_length: 400 }],
  },
  { name: "list", description: "Открытые дела", type: 1, integration_types: BOTH, contexts: EVERYWHERE },
  { name: "week", description: "Что на ближайшие 7 дней", type: 1, integration_types: BOTH, contexts: EVERYWHERE },
  {
    name: "cancel",
    description: "Отменить дело (повторяющееся — всю серию)",
    type: 1,
    integration_types: BOTH,
    contexts: EVERYWHERE,
    options: [{ type: 4, name: "id", description: "Номер дела из /list", required: true, autocomplete: true }],
  },
  {
    name: "snooze",
    description: "Отложить дело на конкретное время",
    type: 1,
    integration_types: BOTH,
    contexts: EVERYWHERE,
    options: [
      { type: 4, name: "id", description: "Номер дела из /list", required: true, autocomplete: true },
      { type: 3, name: "when", description: "На когда, например: завтра 10:30 (по умолчанию через час)", required: false, max_length: 100 },
    ],
  },
  { name: "settings", description: "Настройки: настойчивость, тихие часы, сводки, отъезд", type: 1, integration_types: BOTH, contexts: EVERYWHERE },
  {
    name: "away",
    description: "Я в отъезде: бот молчит N дней, при возвращении одна сводка",
    type: 1,
    integration_types: BOTH,
    contexts: EVERYWHERE,
    options: [{ type: 4, name: "days", description: "Сколько дней (0 — вернуться сейчас)", required: false, min_value: 0, max_value: 90 }],
  },
  {
    name: "power",
    description: "Ссылки для телефона: «свет пропал / появился» (видны только вам)",
    type: 1,
    integration_types: BOTH,
    contexts: EVERYWHERE,
    options: [{ type: 5, name: "reset", description: "Выдать новый ключ (старые ссылки перестанут работать)", required: false }],
  },
  { name: "setup", description: "Завести каналы бота на этом сервере (один раз)", type: 1, integration_types: [0], contexts: [0] },
  // Команда из меню сообщения (долгое нажатие -> Приложения). Описание у такой команды не указывается.
  { name: "Напомнить об этом", type: 3, integration_types: BOTH, contexts: EVERYWHERE },
];
