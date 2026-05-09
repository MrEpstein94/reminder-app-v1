const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");
const { Pool } = require("pg");

const dataDir = path.join(__dirname, "..", "data");
const localStateDir = dataDir;
const localDadCodesPath = path.join(dataDir, "dad-codes.sqlite");
const localActionSecretPath = path.join(dataDir, "public-action-secret.txt");

const stateFiles = {
  settings: path.join(localStateDir, "settings.json"),
  notificationState: path.join(localStateDir, "notification-state.json"),
  calendarState: path.join(localStateDir, "calendar-state.json"),
  taskState: path.join(localStateDir, "task-state.json"),
};

const seedEntries = [
  {
    keyword: "gate",
    title: "Neighborhood Gate",
    responseText: "The neighborhood gate code is 1234.",
    category: "Gate Codes",
  },
  {
    keyword: "home",
    title: "Home Address",
    responseText: "Home address: 123 Main Street, Austin, TX.",
    category: "Addresses",
  },
  {
    keyword: "mom",
    title: "Mom Phone",
    responseText: "Mom's phone number is 555-555-5555.",
    category: "Phone Numbers",
  },
  {
    keyword: "brian",
    title: "Brian Phone",
    responseText: "Brian's phone number is 555-555-5555.",
    category: "Phone Numbers",
  },
  {
    keyword: "wifi",
    title: "Guest WiFi",
    responseText: "Guest WiFi name: Family Guest. Ask Brian or Mom for the password.",
    category: "WiFi",
  },
];

function normalizeKeyword(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ");
}

function rowToEntry(row) {
  if (!row) {
    return null;
  }
  return {
    ...row,
    id: Number(row.id),
    active: Boolean(row.active),
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function ensureDir(targetPath) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
}

function readJsonFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJsonFile(filePath, value) {
  ensureDir(filePath);
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function loadLocalDadCodes() {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(localDadCodesPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS dad_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      keyword TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      responseText TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const rows = db
    .prepare(
      `SELECT id, keyword, title, responseText, category, active, createdAt, updatedAt
       FROM dad_codes
       ORDER BY category COLLATE NOCASE, keyword COLLATE NOCASE`
    )
    .all()
    .map(rowToEntry);

  if (rows.length > 0) {
    db.close();
    return rows;
  }

  const insert = db.prepare(`
    INSERT INTO dad_codes (keyword, title, responseText, category, active)
    VALUES (?, ?, ?, ?, 1)
  `);

  for (const entry of seedEntries) {
    insert.run(
      normalizeKeyword(entry.keyword),
      entry.title,
      entry.responseText,
      entry.category
    );
  }

  const seeded = db
    .prepare(
      `SELECT id, keyword, title, responseText, category, active, createdAt, updatedAt
       FROM dad_codes
       ORDER BY category COLLATE NOCASE, keyword COLLATE NOCASE`
    )
    .all()
    .map(rowToEntry);
  db.close();
  return seeded;
}

function getSupabaseProjectRef() {
  if (process.env.SUPABASE_PROJECT_REF) {
    return process.env.SUPABASE_PROJECT_REF;
  }
  const url = String(process.env.SUPABASE_URL || "").trim();
  const match = url.match(/^https:\/\/([a-z0-9]+)\.supabase\.co/i);
  return match ? match[1] : "";
}

function buildConnectionString() {
  if (process.env.SUPABASE_DB_URL) {
    return process.env.SUPABASE_DB_URL;
  }
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL;
  }

  const ref = getSupabaseProjectRef();
  const password = process.env.SUPABASE_DB_PASSWORD;
  if (!ref || !password) {
    return "";
  }

  return `postgresql://postgres:${encodeURIComponent(password)}@db.${ref}.supabase.co:5432/postgres`;
}

class AppStore {
  constructor() {
    this.mode = buildConnectionString() ? "supabase" : "local";
    this.stateCache = new Map();
    this.dadCodes = [];
    this.nextDadCodeId = 1;
    this.initPromise = null;
    this.pool = null;
  }

  async init() {
    if (!this.initPromise) {
      this.initPromise = this.mode === "supabase" ? this.initSupabase() : this.initLocal();
    }
    return this.initPromise;
  }

  async initLocal() {
    this.dadCodes = loadLocalDadCodes();
    this.nextDadCodeId = this.dadCodes.reduce((max, entry) => Math.max(max, Number(entry.id)), 0) + 1;
  }

  async initSupabase() {
    const connectionString = buildConnectionString();
    this.pool = new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false },
      max: 3,
    });

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS app_state (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS dad_codes (
        id BIGSERIAL PRIMARY KEY,
        keyword TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        response_text TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT '',
        active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    const stateRows = await this.pool.query("SELECT key, value FROM app_state");
    for (const row of stateRows.rows) {
      this.stateCache.set(row.key, row.value);
    }

    const dadCodeRows = await this.pool.query(`
      SELECT id, keyword, title, response_text AS "responseText", category, active,
             created_at AS "createdAt", updated_at AS "updatedAt"
      FROM dad_codes
      ORDER BY lower(category), lower(keyword)
    `);

    if (dadCodeRows.rows.length === 0) {
      const imported = loadLocalDadCodes();
      for (const entry of imported) {
        await this.pool.query(
          `INSERT INTO dad_codes (id, keyword, title, response_text, category, active, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, NOW()), COALESCE($8::timestamptz, NOW()))
           ON CONFLICT (id) DO NOTHING`,
          [
            Number(entry.id),
            entry.keyword,
            entry.title,
            entry.responseText,
            entry.category,
            Boolean(entry.active),
            entry.createdAt || null,
            entry.updatedAt || null,
          ]
        );
      }

      const seededRows = await this.pool.query(`
        SELECT id, keyword, title, response_text AS "responseText", category, active,
               created_at AS "createdAt", updated_at AS "updatedAt"
        FROM dad_codes
        ORDER BY lower(category), lower(keyword)
      `);
      this.dadCodes = seededRows.rows.map(rowToEntry);
    } else {
      this.dadCodes = dadCodeRows.rows.map(rowToEntry);
    }

    this.nextDadCodeId = this.dadCodes.reduce((max, entry) => Math.max(max, Number(entry.id)), 0) + 1;

    for (const [key, filePath] of Object.entries(stateFiles)) {
      if (!this.stateCache.has(key)) {
        const localValue = readJsonFile(filePath);
        if (localValue !== null) {
          await this.setJson(key, localValue);
        }
      }
    }
  }

  getJson(key, fallbackFactory) {
    if (!this.stateCache.has(key)) {
      const fallback = clone(fallbackFactory());
      this.stateCache.set(key, fallback);
      if (this.mode === "local") {
        const filePath = stateFiles[key];
        if (filePath) {
          writeJsonFile(filePath, fallback);
        }
      } else {
        void this.setJson(key, fallback);
      }
    }
    return clone(this.stateCache.get(key));
  }

  async setJson(key, value) {
    const nextValue = clone(value);
    this.stateCache.set(key, nextValue);

    if (this.mode === "local") {
      const filePath = stateFiles[key];
      if (!filePath) {
        throw new Error(`Unknown state key: ${key}`);
      }
      writeJsonFile(filePath, nextValue);
      return clone(nextValue);
    }

    await this.pool.query(
      `INSERT INTO app_state (key, value, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (key)
       DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [key, JSON.stringify(nextValue)]
    );
    return clone(nextValue);
  }

  getPublicActionSecret() {
    const envSecret =
      process.env.PUBLIC_ACTION_SECRET ||
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SENDBLUE_WEBHOOK_SECRET ||
      "";
    if (envSecret) {
      return envSecret;
    }

    if (!fs.existsSync(localActionSecretPath)) {
      ensureDir(localActionSecretPath);
      fs.writeFileSync(localActionSecretPath, crypto.randomBytes(32).toString("hex"));
    }

    return fs.readFileSync(localActionSecretPath, "utf8").trim();
  }

  listDadCodes({ includeInactive = true, search = "" } = {}) {
    const term = String(search || "").trim().toLowerCase();
    return this.dadCodes
      .filter((entry) => includeInactive || entry.active)
      .filter((entry) => {
        if (!term) {
          return true;
        }
        const haystack = [entry.keyword, entry.title, entry.responseText, entry.category]
          .join("\n")
          .toLowerCase();
        return haystack.includes(term);
      })
      .map((entry) => ({ ...entry }));
  }

  getDadCodeById(id) {
    return this.dadCodes.find((entry) => Number(entry.id) === Number(id)) || null;
  }

  getDadCodeByKeyword(keyword) {
    const normalized = normalizeKeyword(keyword);
    return this.dadCodes.find((entry) => entry.keyword === normalized && entry.active) || null;
  }

  async createDadCode(entry) {
    const now = new Date().toISOString();
    const created = rowToEntry({
      id: this.nextDadCodeId++,
      keyword: entry.keyword,
      title: entry.title,
      responseText: entry.responseText,
      category: entry.category,
      active: entry.active,
      createdAt: now,
      updatedAt: now,
    });

    this.dadCodes.push(created);
    await this.persistDadCodesMutation("create", created);
    this.sortDadCodes();
    return { ...created };
  }

  async updateDadCode(id, entry) {
    const index = this.dadCodes.findIndex((item) => Number(item.id) === Number(id));
    if (index === -1) {
      throw new Error("Entry not found.");
    }

    const current = this.dadCodes[index];
    const updated = rowToEntry({
      ...current,
      ...entry,
      id: Number(id),
      updatedAt: new Date().toISOString(),
    });

    this.dadCodes[index] = updated;
    await this.persistDadCodesMutation("update", updated);
    this.sortDadCodes();
    return { ...updated };
  }

  async deleteDadCode(id) {
    const index = this.dadCodes.findIndex((item) => Number(item.id) === Number(id));
    if (index === -1) {
      throw new Error("Entry not found.");
    }

    const [deleted] = this.dadCodes.splice(index, 1);
    await this.persistDadCodesMutation("delete", deleted);
    return { ok: true };
  }

  sortDadCodes() {
    this.dadCodes.sort((left, right) => {
      const categoryCompare = String(left.category || "").localeCompare(String(right.category || ""), undefined, {
        sensitivity: "base",
      });
      if (categoryCompare !== 0) {
        return categoryCompare;
      }
      return String(left.keyword || "").localeCompare(String(right.keyword || ""), undefined, {
        sensitivity: "base",
      });
    });
  }

  async persistDadCodesMutation(kind, entry) {
    if (this.mode === "local") {
      const db = new DatabaseSync(localDadCodesPath);
      if (kind === "create") {
        db.prepare(
          `INSERT INTO dad_codes (id, keyword, title, responseText, category, active, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          entry.id,
          entry.keyword,
          entry.title,
          entry.responseText,
          entry.category,
          entry.active ? 1 : 0,
          entry.createdAt,
          entry.updatedAt
        );
      } else if (kind === "update") {
        db.prepare(
          `UPDATE dad_codes
           SET keyword = ?, title = ?, responseText = ?, category = ?, active = ?, updatedAt = ?
           WHERE id = ?`
        ).run(
          entry.keyword,
          entry.title,
          entry.responseText,
          entry.category,
          entry.active ? 1 : 0,
          entry.updatedAt,
          entry.id
        );
      } else if (kind === "delete") {
        db.prepare("DELETE FROM dad_codes WHERE id = ?").run(entry.id);
      }
      db.close();
      return;
    }

    if (kind === "create") {
      await this.pool.query(
        `INSERT INTO dad_codes (id, keyword, title, response_text, category, active, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz)`,
        [
          Number(entry.id),
          entry.keyword,
          entry.title,
          entry.responseText,
          entry.category,
          Boolean(entry.active),
          entry.createdAt,
          entry.updatedAt,
        ]
      );
      return;
    }

    if (kind === "update") {
      await this.pool.query(
        `UPDATE dad_codes
         SET keyword = $1, title = $2, response_text = $3, category = $4, active = $5, updated_at = $6::timestamptz
         WHERE id = $7`,
        [
          entry.keyword,
          entry.title,
          entry.responseText,
          entry.category,
          Boolean(entry.active),
          entry.updatedAt,
          Number(entry.id),
        ]
      );
      return;
    }

    await this.pool.query("DELETE FROM dad_codes WHERE id = $1", [Number(entry.id)]);
  }
}

const store = new AppStore();

module.exports = {
  store,
  normalizeKeyword,
};
