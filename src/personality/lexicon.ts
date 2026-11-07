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
}

const PINCH: Situation[] = ["missed", "missed_first", "reminder_repeat"];

export const WORDS: Word[] = [
  { id: "yare_yare", cyrillic: "яре яре", latin: "yare yare", meaning: "ну и ну, усталый вздох", ru: "ну и ну", moods: ["tired", "tsundere"], slot: "lead" },
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
