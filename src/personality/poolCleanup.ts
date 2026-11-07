// Чистка пула фраз после загрузки (ручные правки поверх Gemini). Чистая логика, только данные и функции:
// scripts/import-phrases.ts вызывает cleanupPool после проверки, scripts/clean-phrases.ts — на уже загруженном пуле.
// Благодаря этому повторная загрузка пула не откатывает чистку.
//
// Что делает:
//   1. Обращение. В Gemini-фразах «господин»/«хозяин» вшиты словами и не зависят от настройки. Заменяем на {user}:
//      как зовут пользователя, решает движок (config.address, а в аниме-слое — обращение настроения).
//   2. Ручные замены (PHRASE_FIXES): слабая яндере, выдуманное слово «просрочек», лишнее «сегодня» там, где дело старое.
import type { Phrases } from "./phrases.ts";

/** Слова обращения, вшитые в фразы (именительный падеж; других форм в пуле нет). */
const ADDRESS_RE = /(?<![\p{L}])(?:господин|хозяин)(?![\p{L}])/giu;

/** «Господин {user}» → «{user}»: имя после слова обращения не нужно. */
export function normalizeAddress(text: string): string {
  return text
    .replace(/(?:господин|хозяин)\s+\{user\}/giu, "{user}")
    .replace(ADDRESS_RE, "{user}")
    .replace(/\{user\}(\s*,?\s*)\{user\}/gu, "{user}");
}

export interface PhraseFix {
  mood: string;
  situation: string;
  /** начало старой фразы (после замены обращения на {user}); совпавшая фраза целиком заменяется на `to` */
  from: string;
  to: string;
  why: "yandere" | "word" | "time";
}

const fx = (mood: string, situation: string, why: PhraseFix["why"], from: string, to: string): PhraseFix => ({ mood, situation, from, to, why });

// Яндере: только комедийная «приторная жуть» (чашки, пыль, слишком долгая улыбка), без угроз, слежки, принадлежности и запертых дверей
// (правила — docs/gemini-phrase-pool-prompt.md).
export const PHRASE_FIXES: PhraseFix[] = [
  // reminder
  fx("yandere", "reminder", "yandere", "Пришло время для «{task}». Я буду стоять", "Пришло время для «{task}». *улыбается чуть дольше, чем нужно* Я так красиво это записала!"),
  fx("yandere", "reminder", "yandere", "{user}, вам пора сделать «{task}»", "{user}, пора за «{task}». Я прошу так мило, что отказать просто невозможно, правда?"),
  fx("yandere", "reminder", "yandere", "{user}, отвлекитесь от всего", "{user}, у меня для вас дельце. Крохотное, милое, совсем не страшное. *улыбается слишком долго*"),
  fx("yandere", "reminder", "yandere", "Пожалуйста, выполните всё вовремя", "Пожалуйста, сделайте всё вовремя! Я так старалась: переписала напоминание девять раз красивым почерком."),
  fx("yandere", "reminder", "yandere", "Вы забыли про дела?", "Вы забыли про дела? Ничего! Я помню за двоих. И за троих. И за целую чайную церемонию."),
  fx("yandere", "reminder", "yandere", "Давайте закончим всё прямо сейчас", "Давайте сделаем это прямо сейчас, вместе, с чаем и улыбкой! Я налила две чашки. На всякий случай — три."),
  // reminder_repeat
  fx("yandere", "reminder_repeat", "yandere", "Я всё ещё жду, {user}", "Я всё ещё жду, {user}. «{task}» само себя не сделает, а я так терпелива. Так-так-так терпелива."),
  fx("yandere", "reminder_repeat", "yandere", "Вы забыли про «{task}»?", "Вы забыли про «{task}»? Ничего страшного, я мило напомню снова. И снова. И снова. Это же так приятно!"),
  fx("yandere", "reminder_repeat", "yandere", "Я стояла тут всё это время", "Я стояла тут и пересчитала узоры на фартуке: сорок. Сделайте «{task}», и мне будет чем заняться, кроме счёта."),
  fx("yandere", "reminder_repeat", "yandere", "{user}, я слышу ваше дыхание", "{user}, тишина такая громкая... *улыбается слишком долго* Скажите «готово», и я перестану улыбаться. Наверное."),
  fx("yandere", "reminder_repeat", "yandere", "Вы думали, я забуду?", "Вы думали, я забуду? Я записала это в шести местах и ещё на чайной чашке, {user}."),
  fx("yandere", "reminder_repeat", "yandere", "{user}, вы ведь не пытаетесь от меня спрятаться", "{user}, вы ведь не прячетесь за шторой? Я проверила. Просто на всякий случай. Дело ждёт."),
  // missed
  fx("yandere", "missed", "yandere", "Снова всё проспали?", "Снова всё проспали? Поручение «{task}» висит, а я так мило жду. Уже налила ещё три чашки на случай вашего прихода."),
  fx("yandere", "missed", "yandere", "Ничего не сделано...", "Ничего не сделано... Ничего-ничего, я улыбнусь и подам вам ещё один шанс. И ещё чаю. И ещё улыбку."),
  // done: слишком пресные
  fx("yandere", "done", "yandere", "Задание выполнено. Теперь я могу дышать", "Задание выполнено. Я так счастлива, что три раза поправила одну и ту же чашку."),
  fx("yandere", "done", "yandere", "Дело «{task}» завершено. Какая прекрасная работа", "Дело «{task}» завершено! Я хочу вставить эту минуту в рамочку. В очень красивую рамочку. Уже заказала."),
  // return_after_pause, idle_ping, greeting
  fx("yandere", "return_after_pause", "yandere", "*смотрит в потолок* Я уже думала искать вас", "Я уже начала писать объявление «Пропал {user}». Красивым шрифтом, с рамочкой."),
  fx("yandere", "idle_ping", "yandere", "Тишина затянулась", "Тишина затянулась... Я протёрла все чашки. Дважды. Они блестят, как мои надежды."),
  fx("yandere", "idle_ping", "yandere", "Я вижу ваш статус", "Пожалуйста, напишите мне хотя бы одно слово. Я готова считать «ага» целым сочинением."),
  fx("yandere", "greeting", "yandere", "С возвращением, {user}. Я пристально следила", "С возвращением, {user}. Я пристально следила за порядком. За пылью — особенно. Она не посмела."),
  // слова
  fx("tired", "missed", "word", "*тяжело вздыхает* Срок прошёл. Теперь это официальный просрочек", "*тяжело вздыхает* Срок прошёл. Теперь это официальная просрочка."),
  fx("tired", "streak_praise", "word", "*поправляет фартук* Уже {done_streak} дел подряд без просрочек", "*поправляет фартук* Уже {done_streak} дел подряд без пропусков. Не сбавьте темп."),
  // время: «сегодня» в ситуации, где дело могло быть вчерашним
  fx("proud", "missed", "time", "Эх... время вышло. Ничего, бывает", "Эх... время вышло. Ничего, бывает, вы всё равно хорошо постарались."),
  fx("sleepy", "missed", "time", "Срок вышел, а ответа нет.", "Срок вышел, а ответа нет. Мои сверхурочные бессмысленны."),
];

export interface CleanupReport {
  /** сколько обращений заменено на {user} */
  addressReplaced: number;
  /** ручных замен выполнено (или уже были выполнены раньше) */
  fixesApplied: number;
  /** замены, для которых старой фразы нет и новой тоже: пул изменился, правку надо пересмотреть */
  fixesStale: PhraseFix[];
}

/** Применить чистку к пулу. Идемпотентна: повторный запуск ничего не меняет. */
export function cleanupPool(pool: Phrases, fixes: PhraseFix[] = PHRASE_FIXES): { pool: Phrases; report: CleanupReport } {
  const report: CleanupReport = { addressReplaced: 0, fixesApplied: 0, fixesStale: [] };
  const out: Phrases = {};
  for (const [mood, sits] of Object.entries(pool)) {
    out[mood] = {};
    for (const [sit, list] of Object.entries(sits)) {
      out[mood][sit as keyof (typeof out)[string]] = (list ?? []).map((t) => {
        const n = normalizeAddress(t);
        if (n !== t) report.addressReplaced++;
        return n;
      });
    }
  }
  for (const f of fixes) {
    const list = out[f.mood]?.[f.situation as keyof (typeof out)[string]];
    const i = list ? list.findIndex((t) => t.startsWith(f.from)) : -1;
    if (list && i >= 0) {
      list[i] = f.to;
      report.fixesApplied++;
    } else if (list?.includes(f.to)) report.fixesApplied++;
    else report.fixesStale.push(f);
  }
  return { pool: out, report };
}
