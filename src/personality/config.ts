// Все числа и пороги настроения в одном месте (ТЗ, раздел 4–7: «все числа вынеси в config»).
// Подкручиваются здесь; логика в moodEngine.ts их не знает.
export interface MoodConfig {
  /** как зовут горничную в /mood */
  name: string;
  /** как она обращается к пользователю по умолчанию */
  address: string;
  start: { affection: number; irritation: number };
  /** изменения чисел по событиям */
  events: {
    doneOnTime: { affection: number; irritation: number };
    doneLate: { affection: number; irritation: number };
    miss: { affection: number; irritation: number };
    returnAfterPause: { affection: number };
    polite: { affection: number };
    /** «ара-ара», «ганбатте» и т.п. от хозяина (ТЗ, 5Д): +симпатия, не чаще раза в cooldownHours */
    userWord: { affection: number; cooldownHours: number };
  };
  /** молчание: за каждые idleStepHours дневных часов +idleIrritation, всего не больше idleCap */
  idleStepHours: number;
  idleIrritation: number;
  idleCap: number;
  /** пауза дольше этого считается «вернулся после паузы» */
  returnAfterHours: number;
  /** спад со временем: раздражение уменьшается на N в час; симпатия тянется к neutralAffection на N в час */
  irritationDecayPerHour: number;
  affectionDriftPerHour: number;
  neutralAffection: number;
  /** пороги выбора настроения (раздел 5) */
  thresholds: {
    yandereMiss: number;
    yandereIrritation: number;
    tsundereMiss: number;
    tsundereIrritation: number;
    sulkingSilenceHours: number;
    proudDoneStreak: number;
    proudAffection: number;
  };
  /** новое настроение держится не меньше этого (кроме перехода в yandere), минуты */
  minHoldMinutes: number;
  /** яндере само успокаивается (через tsundere) через столько часов, даже если дел никто не выполнил */
  yandereCalmHours: number;
  /** ночь для настроения sleepy, если «тихие часы» в /settings выключены: «часы:минуты» от полуночи */
  night: { from: number; to: number };
  /** с какой серии выполненных подряд особая похвала */
  praiseStreaks: number[];
  /** шанс случайной скупой похвалы после выполненного дела */
  randomPraiseChance: number;
  /** при 4-м пропуске подряд и далее драматичная реплика не чаще раза в столько минут */
  dramaCooldownMinutes: number;
  /** сколько последних фраз не повторять */
  noRepeat: number;
  /** /quiet без аргумента: на сколько часов «горничная на выходном» */
  quietDefaultHours: number;
}

export const MOOD_CONFIG: MoodConfig = {
  name: "Хару",
  address: "хозяин",
  start: { affection: 50, irritation: 10 },
  events: {
    doneOnTime: { affection: 3, irritation: -10 },
    doneLate: { affection: 1, irritation: -3 },
    miss: { affection: -2, irritation: 15 },
    returnAfterPause: { affection: 2 },
    polite: { affection: 4 },
    userWord: { affection: 1, cooldownHours: 1 },
  },
  idleStepHours: 12,
  idleIrritation: 5,
  idleCap: 20,
  returnAfterHours: 24,
  irritationDecayPerHour: 2,
  affectionDriftPerHour: 1,
  neutralAffection: 50,
  thresholds: {
    yandereMiss: 3,
    yandereIrritation: 80,
    tsundereMiss: 1,
    tsundereIrritation: 40,
    sulkingSilenceHours: 12,
    proudDoneStreak: 3,
    proudAffection: 60,
  },
  minHoldMinutes: 30,
  yandereCalmHours: 24,
  night: { from: 23 * 60, to: 7 * 60 },
  praiseStreaks: [3, 7, 14, 30],
  randomPraiseChance: 0.08,
  dramaCooldownMinutes: 120,
  noRepeat: 5,
  quietDefaultHours: 4,
};
