// «Всё ли работает»: читает боевую базу и печатает сводку по-русски. Только чтение. Запуск: npm run status
import { parseExecuteJson, summarizeStatus } from "./lib/helpers.ts";
import { realRunner } from "./lib/runner.ts";

const now = Date.now();
const since = now - 24 * 3600_000;
const sql = [
  "SELECT key, value FROM meta WHERE key IN ('alive_at','owner_id','dm_channel_id')",
  "SELECT key, value FROM settings WHERE key IN ('ch_remind','ch_bot','ch_today','intake')",
  "SELECT state, COUNT(*) AS n FROM occurrences WHERE kind = 'main' AND state IN ('draft','planned','fired','snoozed','overdue') GROUP BY state",
  `SELECT kind, COUNT(*) AS n FROM events WHERE at > ${since} AND kind IN ('send_failed','rate_limited','cron_error','summary_failed','panel_failed','intake_blind') GROUP BY kind`,
].join("; ");

const r = await realRunner().wrangler(["d1", "execute", "meido", "--remote", "--json", "--command", sql], { quiet: true });
if (r.code !== 0) {
  console.error("Не удалось прочитать базу. Выполнен ли вход (wrangler login) и выложен ли бот (setup.cmd)?\n" + r.out.slice(-400));
  process.exit(1);
}
const [meta, settings, open, problems] = parseExecuteJson(r.out).map((x) => x.results);
for (const line of summarizeStatus(
  {
    meta: meta as { key: string; value: string }[],
    settings: settings as { key: string; value: string }[],
    open: open as { state: string; n: number }[],
    problems: problems as { kind: string; n: number }[],
  },
  now,
)) {
  console.log(line);
}
