// Запуск wrangler и ввод в консоли. Секреты передаём только через stdin процесса, никогда в командной строке.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface RunResult {
  code: number;
  out: string;
}

export interface RunOpts {
  /** значение для stdin (секрет) */
  input?: string;
  /** отдать консоль пользователю (вход в Cloudflare, ответы на вопросы wrangler) */
  interactive?: boolean;
  /** при interactive: всё равно собрать вывод (чтобы найти в нём адрес Worker) */
  capture?: boolean;
  /** не печатать вывод */
  quiet?: boolean;
}

export interface Runner {
  wrangler(args: string[], opts?: RunOpts): Promise<RunResult>;
  node(script: string, args?: string[], opts?: RunOpts): Promise<RunResult>;
}

export interface Asker {
  ask(prompt: string): Promise<string>;
  askHidden(prompt: string): Promise<string>;
}

export const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Окружение для wrangler этого проекта. Свой каталог входа (`.cf-home` в папке проекта, в git не попадает):
 * вход в Cloudflare здесь отдельный и не смешивается с общим входом на ПК (там может быть рабочий аккаунт).
 * Токены Cloudflare из окружения сбрасываем: иначе они перебили бы вход.
 */
export function wranglerEnv(projectRoot: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, FORCE_COLOR: "0", NO_COLOR: "1" };
  for (const k of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_KEY", "CLOUDFLARE_EMAIL", "CF_API_TOKEN", "CF_ACCOUNT_ID"]) delete env[k];
  env.XDG_CONFIG_HOME = join(projectRoot, ".cf-home");
  return env;
}

function exec(file: string, args: string[], opts: RunOpts): Promise<RunResult> {
  return new Promise((resolve) => {
    const stdin = opts.interactive ? "inherit" : opts.input !== undefined ? "pipe" : "ignore";
    const outMode = opts.interactive && !opts.capture ? "inherit" : "pipe";
    mkdirSync(join(root, ".cf-home"), { recursive: true });
    const child: ChildProcess = spawn(process.execPath, [file, ...args], {
      cwd: root,
      stdio: [stdin, outMode, outMode],
      env: wranglerEnv(root),
    });
    let out = "";
    const take = (b: Buffer) => {
      const s = b.toString("utf8");
      out += s;
      if (!opts.quiet) process.stdout.write(s);
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    if (opts.input !== undefined && child.stdin) child.stdin.end(opts.input);
    child.on("error", (e) => resolve({ code: 1, out: out + String(e) }));
    child.on("close", (code) => resolve({ code: code ?? 1, out }));
  });
}

export function realRunner(): Runner {
  const wranglerJs = join(root, "node_modules", "wrangler", "bin", "wrangler.js");
  return {
    wrangler: (args, opts = {}) => exec(wranglerJs, args, opts),
    node: (script, args = [], opts = {}) => exec(join(root, script), args, opts),
  };
}

export function realAsker(): Asker {
  return {
    async ask(prompt) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return (await rl.question(prompt)).trim();
      } finally {
        rl.close();
      }
    },
    askHidden(prompt) {
      if (!process.stdin.isTTY) return realAsker().ask(prompt);
      return new Promise((resolve) => {
        process.stdout.write(prompt);
        let buf = "";
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.setEncoding("utf8");
        const onData = (chunk: string) => {
          for (const ch of chunk) {
            if (ch === "\r" || ch === "\n") {
              process.stdin.setRawMode(false);
              process.stdin.pause();
              process.stdin.off("data", onData);
              process.stdout.write("\n");
              return resolve(buf.trim());
            }
            if (ch === "\u0003") process.exit(130);
            if (ch === "\u007f" || ch === "\b") buf = buf.slice(0, -1);
            else buf += ch;
          }
        };
        process.stdin.on("data", onData);
      });
    },
  };
}
