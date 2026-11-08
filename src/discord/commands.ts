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
  {
    name: "mood",
    description: "Настроение горничной: как она к вам сейчас относится (видно только вам)",
    type: 1,
    integration_types: BOTH,
    contexts: EVERYWHERE,
    options: [
      {
        type: 3,
        name: "set",
        description: "Задать настроение вручную (для проверки)",
        required: false,
        choices: [
          { name: "устала (tired)", value: "tired" },
          { name: "цундере (tsundere)", value: "tsundere" },
          { name: "яндере (yandere)", value: "yandere" },
          { name: "обижена (sulking)", value: "sulking" },
          { name: "гордится (proud)", value: "proud" },
          { name: "сонная (sleepy)", value: "sleepy" },
        ],
      },
      {
        type: 3,
        name: "show",
        description: "Показать пример редкой сцены («кино-момент»)",
        required: false,
        choices: [{ name: "кино-момент", value: "cinema" }],
      },
    ],
  },
  { name: "reset_mood", description: "Сбросить настроение, отношение, серии и выученные слова к начальным", type: 1, integration_types: BOTH, contexts: EVERYWHERE },
  {
    name: "style",
    description: "Стиль речи горничной: сколько в ней аниме (без параметров — показать и дать примеры)",
    type: 1,
    integration_types: BOTH,
    contexts: EVERYWHERE,
    options: [
      {
        type: 4,
        name: "level",
        description: "Уровень «анимешности»",
        required: false,
        choices: [
          { name: "0 — обычный русский", value: 0 },
          { name: "1 — лёгкие вставки", value: 1 },
          { name: "2 — фансаб-стиль", value: 2 },
          { name: "3 — полный отаку", value: 3 },
        ],
      },
      {
        type: 3,
        name: "script",
        description: "Как писать японские слова",
        required: false,
        choices: [
          { name: "кириллицей (ара-ара)", value: "cyrillic" },
          { name: "латиницей (ara ara)", value: "latin" },
          { name: "вперемешку", value: "mixed" },
        ],
      },
      {
        type: 3,
        name: "sfx",
        description: "Манга-звуки отдельной строкой",
        required: false,
        choices: [
          { name: "кана (ゴゴゴゴ)", value: "kana" },
          { name: "кириллицей (гогого)", value: "cyrillic" },
          { name: "выключить", value: "off" },
        ],
      },
      { type: 5, name: "honorifics", description: "Обращения по настроению («госюдзин-сама», заикание)", required: false },
      {
        type: 3,
        name: "kaomoji",
        description: "Каомодзи в конце фразы",
        required: false,
        choices: [
          { name: "только на уровне 3", value: "auto" },
          { name: "включить", value: "on" },
          { name: "выключить", value: "off" },
        ],
      },
    ],
  },
  {
    name: "hints",
    description: "Подсказки перевода японских слов в скобках (первые 2 раза)",
    type: 1,
    integration_types: BOTH,
    contexts: EVERYWHERE,
    options: [
      {
        type: 3,
        name: "mode",
        description: "Включить или выключить",
        required: false,
        choices: [
          { name: "включить", value: "on" },
          { name: "выключить", value: "off" },
        ],
      },
    ],
  },
  { name: "glossary", description: "Какие слова Хару уже говорила и что они значат (видно только вам)", type: 1, integration_types: BOTH, contexts: EVERYWHERE },
  {
    name: "quiet",
    description: "Горничная на выходном: бот молчит несколько часов (по умолчанию 4)",
    type: 1,
    integration_types: BOTH,
    contexts: EVERYWHERE,
    options: [{ type: 4, name: "hours", description: "Сколько часов (0 — вернуть сейчас)", required: false, min_value: 0, max_value: 72 }],
  },
  { name: "light", description: "График отключений света: сегодня, завтра и что сейчас (видно только вам)", type: 1, integration_types: BOTH, contexts: EVERYWHERE },
  {
    name: "menu",
    description: "Кнопочное меню: дела, добавление, свет, настройки (видно только вам)",
    type: 1,
    integration_types: BOTH,
    contexts: EVERYWHERE,
    options: [{ type: 5, name: "panel", description: "Поставить закреплённую панель с кнопками в канал «бот»", required: false }],
  },
  { name: "setup", description: "Завести каналы бота на этом сервере (один раз)", type: 1, integration_types: [0], contexts: [0] },
  // Команда из меню сообщения (долгое нажатие -> Приложения). Описание у такой команды не указывается.
  { name: "Напомнить об этом", type: 3, integration_types: BOTH, contexts: EVERYWHERE },
];
