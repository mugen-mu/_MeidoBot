// Запуск wrangler этого проекта с отдельным входом в Cloudflare (`.cf-home`), а не с общим входом на ПК.
// Использование: node scripts/wrangler.ts deploy | dev | whoami | login | logout ...
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { root, wranglerEnv } from "./lib/runner.ts";

mkdirSync(join(root, ".cf-home"), { recursive: true });
const child = spawn(process.execPath, [join(root, "node_modules", "wrangler", "bin", "wrangler.js"), ...process.argv.slice(2)], {
  cwd: root,
  stdio: "inherit",
  env: wranglerEnv(root),
});
child.on("close", (code) => {
  process.exitCode = code ?? 1; // не process.exit: в Node на Windows он иногда печатает «Assertion failed» из libuv
});
