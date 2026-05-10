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
  messageLog: path.join(localStateDir, "message-log.json"),
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

function hasSupabaseRestConfig() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function buildSupabaseRestConfig() {
  const baseUrl = String(process.env.SUPABASE_URL || "").trim().replace(/\/$/, "");
  const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!baseUrl || !serviceRoleKey) {
    return null;
  }
  return {
    baseUrl,
    serviceRoleKey,
    restUrl: `${baseUrl}/rest/v1`,
  };
}

class AppStore {
  constructor() {
    this.mode = buildConnectionString() ? "supabase" : hasSupabaseRestConfig() ? "supabase-rest" : "local";
    this.stateCache = new Map();
    this.dadCodes = [];
    this.nextDadCodeId = 1;
    this.initPromise = null;
    this.pool = null;
    this.restConfig = null;
  }

  async init() {
    if (!this.initPromise) {
      this.initPromise =
        this.mode === "supabase"
          ? this.initSupabase()
          : this.mode === "supabase-rest"
            ? this.initSupabaseRest()
            : this.initLocal();
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

  async initSupabaseRest() {
    this.restConfig = buildSupabaseRestConfig();
    if (!this.restConfig) {
      throw new Error("Supabase REST mode requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
    }

    const [stateRows, dadCodeRows] = await Promise.all([
      this.restRequest("/app_state?select=key,value"),
      this.restRequest(
        '/dad_codes?select=id,keyword,title,response_text,category,active,created_at,updated_at&order=category.asc.nullslast,keyword.asc'
      ),
    ]);

    for (const row of stateRows) {
      this.stateCache.set(row.key, row.value);
    }

    if (dadCodeRows.length === 0) {
      const imported = loadLocalDadCodes();
      for (const entry of imported) {
        await this.restRequest("/dad_codes", {
          method: "POST",
          headers: {
            Prefer: "resolution=merge-duplicates,return=representation",
          },
          body: [
            {
              id: Number(entry.id),
              keyword: entry.keyword,
              title: entry.title,
              response_text: entry.responseText,
              category: entry.category,
              active: Boolean(entry.active),
              created_at: entry.createdAt || new Date().toISOString(),
              updated_at: entry.updatedAt || new Date().toISOString(),
            },
          ],
        });
      }

      const seededRows = await this.restRequest(
        '/dad_codes?select=id,keyword,title,response_text,category,active,created_at,updated_at&order=category.asc.nullslast,keyword.asc'
      );
      this.dadCodes = seededRows.map((row) =>
        rowToEntry({
          ...row,
          responseText: row.response_text,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        })
      );
    } else {
      this.dadCodes = dadCodeRows.map((row) =>
        rowToEntry({
          ...row,
          responseText: row.response_text,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        })
      );
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

    if (this.mode === "supabase") {
      await this.pool.query(
        `INSERT INTO app_state (key, value, updated_at)
         VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (key)
         DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [key, JSON.stringify(nextValue)]
      );
      return clone(nextValue);
    }

    await this.restRequest("/app_state?on_conflict=key", {
      method: "POST",
      headers: {
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: [
        {
          key,
          value: nextValue,
        },
      ],
    });
    return clone(nextValue);
  }

  async restRequest(pathname, options = {}) {
    if (!this.restConfig) {
      throw new Error("Supabase REST config is not initialized.");
    }

    const response = await fetch(`${this.restConfig.restUrl}${pathname}`, {
      method: options.method || "GET",
      headers: {
        apikey: this.restConfig.serviceRoleKey,
        Authorization: `Bearer ${this.restConfig.serviceRoleKey}`,
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Supabase REST request failed (${response.status}): ${body || response.statusText}`);
    }

    const text = await response.text();
    return text ? JSON.parse(text) : null;
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

    if (this.mode === "supabase") {
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
      return;
    }

    if (kind === "create") {
      await this.restRequest("/dad_codes", {
        method: "POST",
        headers: {
          Prefer: "return=minimal",
        },
        body: [
          {
            id: Number(entry.id),
            keyword: entry.keyword,
            title: entry.title,
            response_text: entry.responseText,
            category: entry.category,
            active: Boolean(entry.active),
            created_at: entry.createdAt,
            updated_at: entry.updatedAt,
          },
        ],
      });
      return;
    }

    if (kind === "update") {
      await this.restRequest(`/dad_codes?id=eq.${Number(entry.id)}`, {
        method: "PATCH",
        headers: {
          Prefer: "return=minimal",
        },
        body: {
          keyword: entry.keyword,
          title: entry.title,
          response_text: entry.responseText,
          category: entry.category,
          active: Boolean(entry.active),
          updated_at: entry.updatedAt,
        },
      });
      return;
    }

    await this.restRequest(`/dad_codes?id=eq.${Number(entry.id)}`, {
      method: "DELETE",
      headers: {
        Prefer: "return=minimal",
      },
    });
  }
}

const store = new AppStore();

module.exports = {
  store,
  normalizeKeyword,
};
