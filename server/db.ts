import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { config } from "./config.ts";

type Params = SQLInputValue[];

export class Db {
  readonly raw: DatabaseSync;
  constructor(file: string) {
    this.raw = new DatabaseSync(file);
    this.raw.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  }
  run(sql: string, ...params: Params) {
    return this.raw.prepare(sql).run(...params);
  }
  get<T>(sql: string, ...params: Params): T | undefined {
    return this.raw.prepare(sql).get(...params) as T | undefined;
  }
  all<T>(sql: string, ...params: Params): T[] {
    return this.raw.prepare(sql).all(...params) as T[];
  }
  /** Synchronous transaction. Never await inside. */
  tx<T>(fn: () => T): T {
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.raw.exec("COMMIT");
      return out;
    } catch (e) {
      this.raw.exec("ROLLBACK");
      throw e;
    }
  }
}

const MIGRATIONS: string[] = [
  `
  CREATE TABLE admin (id INTEGER PRIMARY KEY CHECK (id = 1), password_hash TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE secrets (name TEXT PRIMARY KEY, ciphertext TEXT NOT NULL, hint TEXT NOT NULL, updated_at TEXT NOT NULL);

  CREATE TABLE accounts (
    id TEXT PRIMARY KEY,
    exchange TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('paper','live')),
    enabled INTEGER NOT NULL DEFAULT 0,
    execution TEXT NOT NULL DEFAULT 'approval' CHECK (execution IN ('auto','approval')),
    halted INTEGER NOT NULL DEFAULT 0,
    halt_reason TEXT,
    initial_krw REAL NOT NULL DEFAULT 10000000,
    cash_krw REAL NOT NULL DEFAULT 10000000,
    fee_pct REAL NOT NULL DEFAULT 0.05,
    slippage_pct REAL NOT NULL DEFAULT 0.05,
    daily_loss_limit_pct REAL NOT NULL DEFAULT 10,
    default_stop_loss_pct REAL NOT NULL DEFAULT 7,
    default_take_profit_pct REAL NOT NULL DEFAULT 20,
    rebalance_band_pct REAL NOT NULL DEFAULT 2,
    day_start_date TEXT,
    day_start_equity REAL,
    last_equity REAL,
    last_equity_at INTEGER,
    updated_at TEXT NOT NULL,
    UNIQUE (exchange, mode)
  );

  CREATE TABLE positions (
    account_id TEXT NOT NULL REFERENCES accounts(id),
    symbol TEXT NOT NULL,
    qty REAL NOT NULL,
    cost_krw REAL NOT NULL,
    opened_at TEXT NOT NULL,
    stop_loss_pct REAL,
    take_profit_pct REAL,
    last_price REAL,
    last_price_at INTEGER,
    PRIMARY KEY (account_id, symbol)
  );

  CREATE TABLE orders (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    plan_id TEXT,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL CHECK (side IN ('buy','sell')),
    kind TEXT NOT NULL,
    requested_krw REAL,
    requested_qty REAL,
    status TEXT NOT NULL,
    exchange_order_id TEXT,
    executed_qty REAL NOT NULL DEFAULT 0,
    executed_krw REAL NOT NULL DEFAULT 0,
    fee_krw REAL NOT NULL DEFAULT 0,
    avg_price REAL,
    pnl_krw REAL,
    reason TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX orders_account_time ON orders(account_id, created_at DESC);

  CREATE TABLE equity_snapshots (account_id TEXT NOT NULL, ts INTEGER NOT NULL, equity REAL NOT NULL, cash REAL NOT NULL, PRIMARY KEY (account_id, ts));

  CREATE TABLE research_runs (
    id TEXT PRIMARY KEY,
    exchange TEXT NOT NULL,
    trigger TEXT NOT NULL,
    model TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    candidates TEXT,
    result TEXT,
    error TEXT,
    response_id TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    cached_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    web_searches INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0
  );
  CREATE INDEX research_time ON research_runs(started_at DESC);

  CREATE TABLE plans (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    research_id TEXT,
    status TEXT NOT NULL,
    targets TEXT NOT NULL,
    preview TEXT,
    result TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    decided_at TEXT,
    decided_via TEXT,
    telegram_message_id INTEGER
  );
  CREATE INDEX plans_time ON plans(created_at DESC);

  CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, level TEXT NOT NULL, account_id TEXT, message TEXT NOT NULL);
  `,
];

function migrate(db: Db) {
  db.raw.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
  const row = db.get<{ version: number }>("SELECT version FROM schema_version");
  let version = row?.version ?? 0;
  if (!row) db.run("INSERT INTO schema_version (version) VALUES (0)");
  for (; version < MIGRATIONS.length; version++) {
    db.tx(() => {
      db.raw.exec(MIGRATIONS[version]);
      db.run("UPDATE schema_version SET version = ?", version + 1);
    });
  }
}

let instance: Db | null = null;

export function db(): Db {
  if (!instance) {
    instance = new Db(config.dbFile);
    migrate(instance);
  }
  return instance;
}

/** For tests: use an isolated database. */
export function useDatabase(file: string) {
  instance = new Db(file);
  migrate(instance);
  return instance;
}

export const nowIso = () => new Date().toISOString();
