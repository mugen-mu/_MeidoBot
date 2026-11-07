// Точка входа Cloudflare Worker: приём действий из Discord (HTTP) и запуск по расписанию (cron раз в минуту).
import { type CronEnv, runCron } from "./cron.ts";
import { Counter, Repo } from "./db/repo.ts";
import { countedApi, createDiscordApi } from "./discord/api.ts";
import { type Interaction, handleInteraction } from "./discord/interactions.ts";
import { verifySignature } from "./discord/verify.ts";

export interface Env {
  DB: D1Database;
  DISCORD_PUBLIC_KEY: string;
  DISCORD_BOT_TOKEN: string;
  DISCORD_APP_ID?: string;
  WATCHDOG_URL?: string;
  OWNER_ID?: string;
}

const FAIL_REPLY = {
  type: 4,
  data: { content: "Что-то пошло не так. Повторите действие ещё раз.", flags: 64 },
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    // Снаружи ничего лишнего не показываем.
    if (request.method !== "POST" || url.pathname !== "/interactions") return new Response("ok", { status: url.pathname === "/" ? 200 : 404 });

    const body = await request.text();
    const ok = await verifySignature(
      env.DISCORD_PUBLIC_KEY ?? "",
      request.headers.get("x-signature-ed25519") ?? "",
      request.headers.get("x-signature-timestamp") ?? "",
      body,
    );
    if (!ok) return new Response("bad request signature", { status: 401 });

    let interaction: Interaction;
    try {
      interaction = JSON.parse(body) as Interaction;
    } catch {
      return new Response("bad request", { status: 400 });
    }
    try {
      const repo = new Repo(env.DB, new Counter(1000));
      const api = createDiscordApi(env.DISCORD_BOT_TOKEN);
      const reply = await handleInteraction(interaction, {
        repo,
        api,
        now: Date.now(),
        env: { ownerId: env.OWNER_ID },
        defer: (p) => ctx.waitUntil(p),
      });
      return Response.json(reply);
    } catch {
      return Response.json(FAIL_REPLY);
    }
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // Бесплатный план: 50 подзапросов за запуск — считаем их (D1 и Discord вместе).
    const counter = new Counter(50);
    const repo = new Repo(env.DB, counter);
    const api = countedApi(createDiscordApi(env.DISCORD_BOT_TOKEN), counter);
    const cronEnv: CronEnv = { ownerId: env.OWNER_ID, watchdogUrl: env.WATCHDOG_URL };
    ctx.waitUntil(runCron({ repo, api, now: Date.now(), env: cronEnv }));
  },
};
