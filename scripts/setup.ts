// Установка одним действием (запускает setup.cmd): npm run setup
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { realAsker, realRunner } from "./lib/runner.ts";
import { runSetup } from "./lib/setup.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const res = await runSetup({ root, runner: realRunner(), asker: realAsker(), log: (l) => console.log(l) });
process.exit(res.ok ? 0 : 1);
