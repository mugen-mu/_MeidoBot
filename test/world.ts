// Общий «мир» для тестов cron и обработчика: база, поддельный Discord, запуск с честным счётчиком подзапросов.
import { type CronEnv, type CronReport, runCron } from "../src/cron.ts";
import { Counter, Repo, setMeta, setSetting } from "../src/db/repo.ts";
import { countedApi } from "../src/discord/api.ts";
import { createFromText } from "../src/intake.ts";
import type { AiBinding } from "../src/llm.ts";
import { type AppSettings, readSettings } from "../src/settings.ts";
import { FakeD1 } from "./d1shim.ts";
import { FakeDiscord } from "./fakeDiscord.ts";
import { NOW } from "./helpers.ts";

export const OWNER = "999";
export const CH_REMIND = "100";
export const CH_TODAY = "101";
export const CH_BOT = "102";

export class World {
  d1 = new FakeD1();
  discord = new FakeDiscord();
  pings: string[] = [];
  /** что вернёт «Yasno»; null — сервис не отвечает */
  light: unknown = null;
  lightFetches = 0;
  /** что вернёт лента водоканала (wp-json); null — сайт не отвечает */
  water: unknown = null;
  waterFetches = 0;
  /** главная страница газовиков (html) и файл графика (.docx); null — сайт не отвечает */
  gasHome: string | null = null;
  gasDocx: Uint8Array | null = null;
  gasFetches = 0;
  /** лента Укрэнерго (html страницы t.me/s/Ukrenergo); null — не отвечает */
  ukr: string | null = null;
  ukrFetches = 0;
  /** Shikimori: ответ на поиск (массив) и на «один тайтл» по номеру; null — не отвечает */
  shikiSearch: unknown[] | null = [];
  shikiById: Record<number, unknown> = {};
  /** Shikimori: календарь недели (массив); null — не отвечает */
  shikiCalendar: unknown[] | null = [];
  animeFetches = 0;
  /** Shikimori: связанные тайтлы по номеру MAL (для продолжений); по умолчанию пусто */
  shikiRelated: Record<number, unknown[]> = {};
  relatedFetches = 0;
  /** AniLibria: расписание недели (массив); null — не отвечает */
  voice: unknown[] | null = [];
  voiceFetches = 0;
  /** Open-Meteo (дождь): ответ-объект; функция — по текущему времени запуска; null — не отвечает; Error — сбой сети */
  rain: unknown | ((now: number) => unknown) | Error | null = null;
  rainFetches = 0;
  /** строки журнала, которые cron передал через log */
  logs: string[] = [];
  /** привязка модели (env.AI) для запуска cron; по умолчанию нет */
  ai?: AiBinding;

  /** Репозиторий с новым счётчиком (как новый запуск Worker). */
  repo(limit = 50): Repo {
    return new Repo(this.d1.asD1, new Counter(limit));
  }

  async seed(opts: { remind?: boolean; today?: boolean; intake?: boolean; settings?: Record<string, string> } = {}): Promise<void> {
    const ops = [setMeta("owner_id", OWNER)];
    if (opts.remind !== false) ops.push(setSetting("ch_remind", CH_REMIND));
    if (opts.today) ops.push(setSetting("ch_today", CH_TODAY));
    if (opts.intake) ops.push(setSetting("ch_bot", CH_BOT), setSetting("intake", JSON.stringify([CH_BOT])));
    // с 2026-11-08 характер включён по умолчанию; старые тесты проверяют нейтральный тон — выключаем явно (settings перекрывает)
    ops.push(setSetting("mood_on", "0"), setSetting("character", "neutral"), setSetting("chores", "0")); // дела-сопровождение (этап 4) включают только свои тесты
    ops.push(setSetting("rain", "off")); // дождь (src/rain.ts) включают только его тесты: иначе старые тесты считали бы лишние запросы
    ops.push(setSetting("anime_pick", "off")); // субботняя подборка аниме (NOW по умолчанию — суббота 12:00, как раз её время): включают только её тесты
    for (const [k, v] of Object.entries(opts.settings ?? {})) ops.push(setSetting(k, v));
    await this.repo().exec(ops);
  }

  async settings(): Promise<AppSettings> {
    return (await this.repo().loadConfig()).settings;
  }

  /** Создать дело текстом, как это сделает пользователь. */
  async create(text: string, now = NOW) {
    const repo = this.repo();
    const r = await createFromText({ repo, settings: await this.settings(), now }, text, "slash");
    if (r.kind !== "created") throw new Error(`не создано: ${r.kind}`);
    return r;
  }

  async run(now: number, env: CronEnv = {}, limit = 50): Promise<CronReport> {
    const repo = this.repo(limit);
    const api = countedApi(this.discord, repo.counter);
    const fetchFn = (async (input: unknown) => {
      if (String(typeof input === "string" ? input : (input as { url?: string; href?: string })?.url ?? (input as { href?: string })?.href).includes("vodokanal")) {
        this.waterFetches++;
        return this.water === null ? new Response("down", { status: 503 }) : Response.json(this.water);
      }
      const url = String(typeof input === "string" ? input : (input as { url?: string; href?: string })?.url ?? (input as { href?: string })?.href);
      if (url.includes("open-meteo")) {
        this.rainFetches++;
        const r = typeof this.rain === "function" ? (this.rain as (n: number) => unknown)(now) : this.rain;
        if (r instanceof Error) throw r;
        return r === null ? new Response("down", { status: 503 }) : Response.json(r);
      }
      if (url.includes("anilibria")) {
        this.voiceFetches++;
        return this.voice === null ? new Response("down", { status: 503 }) : Response.json(this.voice);
      }
      if (url.includes("shikimori")) {
        this.animeFetches++;
        const rel = /\/api\/animes\/(\d+)\/related/.exec(url);
        if (rel) {
          this.relatedFetches++;
          return Response.json(this.shikiRelated[Number(rel[1])] ?? []);
        }
        if (url.includes("/api/calendar")) return this.shikiCalendar === null ? new Response("down", { status: 503 }) : Response.json(this.shikiCalendar);
        const one = /\/api\/animes\/(\d+)/.exec(url);
        if (one) return this.shikiById[Number(one[1])] ? Response.json(this.shikiById[Number(one[1])]) : new Response("none", { status: 404 });
        return this.shikiSearch === null ? new Response("down", { status: 503 }) : Response.json(this.shikiSearch);
      }
      if (url.includes("grmu.com.ua")) {
        this.gasFetches++;
        const isFile = url.endsWith(".docx");
        const body = isFile ? this.gasDocx : this.gasHome;
        return body === null ? new Response("down", { status: 503 }) : new Response(body as BodyInit);
      }
      if (url.includes("t.me/s/")) {
        this.ukrFetches++;
        return this.ukr === null ? new Response("down", { status: 503 }) : new Response(this.ukr);
      }
      this.lightFetches++;
      return this.light === null ? new Response("down", { status: 503 }) : Response.json(this.light);
    }) as unknown as typeof fetch;
    return runCron({ repo, api, now, env, fetchFn, ai: this.ai, ping: async (u) => void this.pings.push(u), log: (l) => void this.logs.push(l) });
  }

  occ(id: number) {
    return this.d1.q<Record<string, unknown>>("SELECT * FROM occurrences WHERE id = ?", id)[0];
  }
}
