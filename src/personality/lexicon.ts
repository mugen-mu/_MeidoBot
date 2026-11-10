// Словарь аниме-слоя («Характер 2», этап Х2): ТОЛЬКО ДАННЫЕ. Новое слово = новая запись в WORDS, без правки логики
// (ТЗ `docs/personality/maid_bot_anime_style_addon.md`, разделы 3–5).
// Японские слова пишутся кириллицей (как в русских фансабах), латиница — по настройке; кана — только у манга-звуков.
import type { Mood } from "./moodEngine.ts";
import type { Situation } from "./phrases.ts";

export interface Word {
  id: string;
  cyrillic: string;
  latin: string;
  /** -сама / -сан: добавляется только при уровне 2+ и включённых обращениях */
  suffix?: { cyrillic: string; latin: string };
  /** коротко по-русски: подсказка в скобках и строка в /glossary */
  meaning: string;
  /** русский эквивалент: подставляется вместо слова на уровне 0 */
  ru: string;
  /** в каких настроениях слово уместно */
  moods: Mood[];
  /** в каких ситуациях (пусто — в любых) */
  situations?: Situation[];
  /**
   * lead — вставляется в начало сообщения («Яре яре… …»), tail — в конец («… Ганбатте.»),
   * token — только по явной подстановке {id} в тексте фразы.
   */
  slot: "lead" | "tail" | "token";
  /** свой знак после слова (иначе по настроению); пустая строка — слово уже со знаком */
  punct?: string;
  /** не чаще раза в столько сообщений со стилем (по умолчанию `STYLE_LIMITS.wordCooldown`); у любимого, но частого слова — дольше */
  cooldown?: number;
}

const ACHIEVE: Situation[] = ["done", "done_late", "streak_praise", "good_streak", "achieve_tail", "achieve_week_clean", "achieve_week_ontime"];

const PINCH: Situation[] = ["missed", "missed_first", "reminder_repeat"];

export const WORDS: Word[] = [
  // «яре яре» — любимое слово хозяина, но звучало слишком часто: оставлено, только реже (пауза 15 сообщений со стилем)
  { id: "yare_yare", cyrillic: "яре яре", latin: "yare yare", meaning: "ну и ну, усталый вздох", ru: "ну и ну", moods: ["tired", "tsundere"], slot: "lead", cooldown: 15 },
  { id: "ara_ara", cyrillic: "ара-ара", latin: "ara ara", meaning: "ой-ой, мягкое удивление", ru: "ой-ой", moods: ["yandere", "tired", "proud"], slot: "lead" },
  { id: "mendokusai", cyrillic: "мендокусай", latin: "mendokusai", meaning: "как же лень, как хлопотно", ru: "как же лень", moods: ["tired"], slot: "lead" },
  { id: "shikata_nai", cyrillic: "сиката-най", latin: "shikata nai", meaning: "ничего не поделаешь", ru: "ничего не поделаешь", moods: ["tired", "tsundere"], slot: "lead" },
  { id: "mou", cyrillic: "мо-о", latin: "mou", meaning: "ну вот опять, раздражение", ru: "ну вот опять", moods: ["tsundere"], situations: [...PINCH, "chat_fallback"], slot: "lead", punct: "!" },
  { id: "fun", cyrillic: "хмпф", latin: "fun", meaning: "отвернулась и дуется", ru: "хм", moods: ["tsundere", "sulking"], slot: "lead" },
  { id: "baka", cyrillic: "бака", latin: "baka", meaning: "дурак (по-доброму)", ru: "глупый", moods: ["tsundere"], situations: PINCH, slot: "lead", punct: "!" },
  { id: "urusai", cyrillic: "урусай", latin: "urusai", meaning: "не шумите", ru: "потише", moods: ["tsundere"], situations: ["reminder_repeat", "chat_fallback"], slot: "lead", punct: "!" },
  { id: "haa", cyrillic: "ха-а", latin: "haa", meaning: "вздох", ru: "*вздох*", moods: ["tired", "sleepy"], slot: "lead" },
  { id: "ufufu", cyrillic: "уфуфу", latin: "ufufu", meaning: "смешок", ru: "хи-хи", moods: ["yandere"], slot: "lead", punct: "~" },
  { id: "nee", cyrillic: "нэ-нэ", latin: "nee nee", meaning: "послушайте…", ru: "послушайте", moods: ["yandere", "sulking"], slot: "lead" },
  { id: "eeh", cyrillic: "э-э", latin: "eeh", meaning: "удивление", ru: "что?!", moods: ["tsundere", "proud"], slot: "lead", punct: "?!" },
  { id: "ganbatte", cyrillic: "ганбатте", latin: "ganbatte", meaning: "держитесь, вы справитесь", ru: "держитесь", moods: ["tired", "proud"], situations: ["reminder", "reminder_repeat", "missed_first"], slot: "tail" },
  {
    id: "otsukare",
    cyrillic: "отсукарэ",
    latin: "otsukare",
    suffix: { cyrillic: "-сама", latin: "-sama" },
    meaning: "спасибо за труд",
    ru: "спасибо за труд",
    moods: ["proud", "tired"],
    situations: ["done", "done_late", "streak_praise"],
    slot: "tail",
  },
  { id: "gomen", cyrillic: "гомэн", latin: "gomen", meaning: "простите", ru: "простите", moods: ["proud", "sulking"], situations: ["missed", "missed_first", "done_late"], slot: "tail" },
  { id: "kudasai", cyrillic: "кудасай", latin: "kudasai", meaning: "пожалуйста", ru: "пожалуйста", moods: ["yandere"], situations: ["reminder", "reminder_repeat", "missed"], slot: "tail", punct: "~" },
  { id: "onegai", cyrillic: "онэгай", latin: "onegai", meaning: "прошу вас", ru: "прошу вас", moods: ["yandere"], situations: ["reminder_repeat", "missed"], slot: "tail", punct: "~" },
  { id: "okaeri", cyrillic: "окаэри", latin: "okaeri", meaning: "с возвращением", ru: "с возвращением", moods: ["tired", "tsundere", "yandere", "sulking", "proud", "sleepy"], situations: ["return_after_pause", "greeting"], slot: "tail" },
  { id: "daijoubu", cyrillic: "дайдзёбу", latin: "daijoubu", meaning: "всё в порядке?", ru: "всё в порядке", moods: ["tired", "proud"], situations: ["return_after_pause", "missed_first"], slot: "tail", punct: "?" },
  { id: "hai", cyrillic: "хай", latin: "hai", meaning: "да", ru: "да", moods: ["tired", "tsundere", "yandere", "sulking", "proud", "sleepy"], slot: "token" },
  // ---- 2026-11-10: пул шире (просьба владельца: разнообразить, «яре яре» слишком часто) ----
  { id: "naruhodo", cyrillic: "наруходо", latin: "naruhodo", meaning: "понятно, вот оно что", ru: "понятно", moods: ["tired", "tsundere", "proud"], slot: "lead" },
  { id: "mattaku", cyrillic: "маттаку", latin: "mattaku", meaning: "ну надо же, вот же", ru: "ну надо же", moods: ["tired", "tsundere"], slot: "lead" },
  { id: "taihen", cyrillic: "тайхэн", latin: "taihen", meaning: "вот беда, ну и дела", ru: "ну и дела", moods: ["tired", "sleepy", "sulking"], situations: ["missed", "missed_first", "reminder_repeat"], slot: "lead", punct: "!" },
  { id: "maa_maa", cyrillic: "маа-маа", latin: "maa maa", meaning: "ну-ну, спокойно, ладно", ru: "ну-ну", moods: ["tired", "proud", "sleepy"], slot: "lead" },
  { id: "eeto", cyrillic: "ээто", latin: "eeto", meaning: "э-э, ну…", ru: "ну…", moods: ["tired", "sleepy", "sulking"], slot: "lead" },
  { id: "yakkai", cyrillic: "яккай", latin: "yakkai", meaning: "морока, хлопотно", ru: "морока", moods: ["tired"], slot: "lead" },
  { id: "uun", cyrillic: "уун", latin: "uun", meaning: "хм-м, дайте подумать", ru: "хм-м", moods: ["tired", "tsundere", "sleepy"], slot: "lead" },
  { id: "fuun", cyrillic: "фу-ун", latin: "fuun", meaning: "ну-ну, надо же", ru: "ну-ну", moods: ["tsundere", "sulking"], slot: "lead" },
  { id: "hidoi", cyrillic: "хидой", latin: "hidoi", meaning: "жестоко!", ru: "жестоко", moods: ["tsundere", "sulking"], slot: "lead", punct: "!" },
  { id: "zurui", cyrillic: "дзурий", latin: "zurui", meaning: "нечестно!", ru: "нечестно", moods: ["tsundere", "sulking"], situations: [...PINCH, "snoozed", "snooze_5"], slot: "lead", punct: "!" },
  { id: "nani", cyrillic: "нани", latin: "nani", meaning: "что?!", ru: "что?!", moods: ["tsundere", "proud"], slot: "lead", punct: "?!" },
  { id: "sugoi", cyrillic: "сугои", latin: "sugoi", meaning: "ух ты, здорово", ru: "ух ты", moods: ["proud", "tired", "tsundere"], situations: ACHIEVE, slot: "lead", punct: "!" },
  { id: "kawaii", cyrillic: "кавай", latin: "kawaii", meaning: "мило", ru: "мило", moods: ["proud", "yandere", "sleepy"], situations: [...ACHIEVE, "recorded", "thanks", "greeting"], slot: "lead", punct: "~" },
  { id: "nemui", cyrillic: "нэмуй", latin: "nemui", meaning: "спать хочется", ru: "спать хочется", moods: ["sleepy"], slot: "lead" },
  { id: "kufufu", cyrillic: "куфуфу", latin: "kufufu", meaning: "тихий смешок", ru: "хи-хи", moods: ["yandere"], slot: "lead", punct: "~" },
  { id: "matte", cyrillic: "маттэ", latin: "matte", meaning: "подождите", ru: "подождите", moods: ["yandere"], situations: ["reminder_repeat", "missed", "missed_first"], slot: "lead", punct: "~" },
  { id: "yokatta", cyrillic: "ёкатта", latin: "yokatta", meaning: "слава богу, ну и славно", ru: "слава богу", moods: ["tired", "proud", "sleepy"], situations: ["done", "relief", "good_streak", "achieve_tail", "achieve_week_clean", "achieve_week_ontime"], slot: "tail", punct: "." },
  { id: "sumimasen", cyrillic: "сумимасэн", latin: "sumimasen", meaning: "прошу прощения", ru: "прошу прощения", moods: ["sulking", "proud", "tired"], situations: ["missed", "missed_first", "done_late"], slot: "tail" },
  { id: "ganbare", cyrillic: "ганбарэ", latin: "ganbare", meaning: "давайте, вперёд", ru: "вперёд", moods: ["tsundere", "proud"], situations: ["reminder", "reminder_repeat", "snooze_5"], slot: "tail", punct: "!" },
  { id: "isshoni", cyrillic: "иссёни", latin: "isshoni", meaning: "вместе", ru: "вместе", moods: ["yandere"], situations: ["reminder", "reminder_repeat", "missed"], slot: "tail", punct: "~" },
];

export const WORD_BY_ID: Map<string, Word> = new Map(WORDS.map((w) => [w.id, w]));

/** Манга-звуки (ТЗ, 5В): кана — по умолчанию, кириллица — по настройке. */
export type SfxId = "menace" | "heart" | "turn_away" | "stare" | "sleep" | "sigh" | "startle";
export const SFX: Record<SfxId, { kana: string; cyrillic: string }> = {
  menace: { kana: "ゴゴゴゴ…", cyrillic: "гогого…" },
  heart: { kana: "ドキドキ…", cyrillic: "доки-доки…" },
  turn_away: { kana: "プイ", cyrillic: "пуй" },
  stare: { kana: "ジー…", cyrillic: "джи-и…" },
  sleep: { kana: "ぐぅ…", cyrillic: "гу-у…" },
  sigh: { kana: "ハァ…", cyrillic: "ха-а…" },
  startle: { kana: "ハッ！", cyrillic: "ха!" },
};
export const isSfx = (v: string): v is SfxId => v in SFX;

/** Какие звуки к какому настроению (ТЗ, 5В); startle — отдельно, на «вернулись». */
export const MOOD_SFX: Record<Mood, SfxId[]> = {
  tired: ["sigh"],
  tsundere: ["turn_away"],
  yandere: ["menace", "stare"],
  sulking: ["turn_away", "stare"],
  proud: ["heart"],
  sleepy: ["sleep"],
};

/** Каомодзи (ТЗ, 5В): только уровень 3 или по настройке; спецсимволы Markdown экранируются при выводе. */
export const KAOMOJI: Partial<Record<Mood, string>> = {
  tired: "(－_－;)",
  tsundere: "(｀へ´)",
  yandere: "(◕‿◕)",
  proud: "(//▽//)",
  sleepy: "(¦3[▓▓]",
};

/**
 * Обращение к пользователю по настроению (ТЗ, раздел 3). Берётся при уровне 2+ и включённых обращениях,
 * иначе — обычное `config.address`. Список — варианты; первый — основной, остальные редкие.
 * null — не называет вовсе (sulking: «говорит в пустоту»).
 */
export const ADDRESS: Record<Mood, { cyrillic: string[]; latin: string[] } | null> = {
  tired: { cyrillic: ["госюдзин-сама"], latin: ["goshujin-sama"] },
  tsundere: null, // обычное обращение с заиканием («х-хозяин»); см. animeStyle.ts
  yandere: { cyrillic: ["госюдзин-сама~", "госюдзин-сама~", "аната"], latin: ["goshujin-sama~", "goshujin-sama~", "anata"] },
  proud: { cyrillic: ["госюдзин-сама", "госюдзин-сама", "госюдзин-кун... то есть сама"], latin: ["goshujin-sama", "goshujin-sama", "goshujin-kun... I mean sama"] },
  sulking: null,
  sleepy: { cyrillic: ["госюдзин-сама", "хозя... то есть госюдзин-сама"], latin: ["goshujin-sama", "goshu... I mean goshujin-sama"] },
};

/** Шёпот цундере в спойлере (уровень 3): читать надо кликнуть. По-русски, без японских слов. */
export const WHISPERS: Partial<Record<Mood, { situations: Situation[]; lines: string[] }>> = {
  tsundere: {
    situations: ["missed", "missed_first", "reminder_repeat"],
    lines: ["только не пропустите опять", "я совсем не переживала, честно", "и не думайте, что я ждала ответа", "мне просто было неудобно перед делом"],
  },
};
