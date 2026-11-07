// Оболочка с интерфейсом D1Database поверх node:sqlite — для тестов и сухого прогона.
// Считает подзапросы так же, как Cloudflare: каждый prepare().all/first/run = 1, весь batch = 1.
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

interface Row {
  [k: string]: unknown;
}

class Stmt {
  readonly shim: FakeD1;
  readonly sql: string;
  readonly params: unknown[];
  constructor(shim: FakeD1, sql: string, params: unknown[] = []) {
    this.shim = shim;
    this.sql = sql;
    this.params = params;
  }
  bind(...params: unknown[]): Stmt {
    return new Stmt(this.shim, this.sql, params);
  }
  returnsRows(): boolean {
    return /^\s*(select|with|pragma)/i.test(this.sql) || /\breturning\b/i.test(this.sql);
  }
  runRaw(): { results: Row[]; meta: Row } {
    const st = this.shim.sqlite.prepare(this.sql);
    if (this.returnsRows()) {
      const rows = (st.all(...(this.params as never[])) as Row[]).map((r) => ({ ...r }));
      return { results: rows, meta: { changes: 0, last_row_id: 0, rows_read: rows.length } };
    }
    const r = st.run(...(this.params as never[]));
    return { results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
  private wrap(): { success: true; results: Row[]; meta: Row } {
    const r = this.runRaw();
    return { success: true, results: r.results, meta: r.meta };
  }
  async all(): Promise<unknown> {
    this.shim.calls++;
    return this.wrap();
  }
  async first(col?: string): Promise<unknown> {
    this.shim.calls++;
    const r = this.runRaw().results[0] ?? null;
    return col && r ? r[col] : r;
  }
  async run(): Promise<unknown> {
    this.shim.calls++;
    return this.wrap();
  }
  async raw(): Promise<unknown> {
    this.shim.calls++;
    return this.runRaw().results.map((r) => Object.values(r));
  }
}

export class FakeD1 {
  sqlite = new DatabaseSync(":memory:");
  /** число подзапросов в понимании Cloudflare */
  calls = 0;

  constructor() {
    const dir = join(root, "migrations");
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
      this.sqlite.exec(readFileSync(join(dir, f), "utf8"));
    }
  }
  prepare(sql: string): Stmt {
    return new Stmt(this, sql);
  }
  async batch(stmts: Stmt[]): Promise<unknown[]> {
    this.calls++;
    this.sqlite.exec("BEGIN");
    try {
      const out = stmts.map((s) => {
        const r = s.runRaw();
        return { success: true, results: r.results, meta: r.meta };
      });
      this.sqlite.exec("COMMIT");
      return out;
    } catch (e) {
      this.sqlite.exec("ROLLBACK");
      throw e;
    }
  }
  /** Прямой запрос для проверок в тестах (не считается подзапросом). */
  q<T = Row>(sql: string, ...params: unknown[]): T[] {
    return (this.sqlite.prepare(sql).all(...(params as never[])) as Row[]).map((r) => ({ ...r })) as T[];
  }
  get asD1(): D1Database {
    return this as unknown as D1Database;
  }
}
