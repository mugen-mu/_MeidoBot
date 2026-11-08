// Общий «мир» для тестов cron и обработчика: база, поддельный Discord, запуск с честным счётчиком подзапросов.
import { type CronEnv, type CronReport, runCron } from "../src/cron.ts";
import { Counter, Repo, setMeta, setSetting } from "../src/db/repo.ts";
import { countedApi } from "../src/discord/api.ts";
import { createFromText } from "../src/intake.ts";
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
    ops.push(setSetting("mood_on", "0"), setSetting("character", "neutral"));
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
      if (url.includes("grmu.com.ua")) {
        this.gasFetches++;
        const isFile = url.endsWith(".docx");
        const body = isFile ? this.gasDocx : this.gasHome;
        return body === null ? new Response("down", { status: 503 }) : new Response(body as BodyInit);
      }
      this.lightFetches++;
      return this.light === null ? new Response("down", { status: 503 }) : Response.json(this.light);
    }) as unknown as typeof fetch;
    return runCron({ repo, api, now, env, fetchFn, ping: async (u) => void this.pings.push(u) });
  }

  occ(id: number) {
    return this.d1.q<Record<string, unknown>>("SELECT * FROM occurrences WHERE id = ?", id)[0];
  }
}
