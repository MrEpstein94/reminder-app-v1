const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const dataDir = path.join(__dirname, "..", "data");
const dbPath = path.join(dataDir, "dad-codes.sqlite");

fs.mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(dbPath);
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
    active: Boolean(row.active),
  };
}

function seedDadCodes() {
  const count = db.prepare("SELECT COUNT(*) AS count FROM dad_codes").get().count;
  if (count > 0) {
    return;
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
}

function listDadCodes({ includeInactive = true, search = "" } = {}) {
  const filters = [];
  const params = {};

  if (!includeInactive) {
    filters.push("active = 1");
  }

  const term = String(search || "").trim();
  if (term) {
    params.search = `%${term}%`;
    filters.push(
      "(keyword LIKE :search OR title LIKE :search OR responseText LIKE :search OR category LIKE :search)"
    );
  }

  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  return db
    .prepare(
      `SELECT id, keyword, title, responseText, category, active, createdAt, updatedAt
       FROM dad_codes
       ${where}
       ORDER BY category COLLATE NOCASE, keyword COLLATE NOCASE`
    )
    .all(params)
    .map(rowToEntry);
}

function getDadCodeById(id) {
  return rowToEntry(
    db
      .prepare(
        `SELECT id, keyword, title, responseText, category, active, createdAt, updatedAt
         FROM dad_codes
         WHERE id = ?`
      )
      .get(Number(id))
  );
}

function getDadCodeByKeyword(keyword) {
  return rowToEntry(
    db
      .prepare(
        `SELECT id, keyword, title, responseText, category, active, createdAt, updatedAt
         FROM dad_codes
         WHERE keyword = ? AND active = 1`
      )
      .get(normalizeKeyword(keyword))
  );
}

function validateEntry(input) {
  const keyword = normalizeKeyword(input.keyword);
  const title = String(input.title || "").trim();
  const responseText = String(input.responseText || "").trim();
  const category = String(input.category || "").trim();
  const active = input.active === false || input.active === "false" ? 0 : 1;

  if (!keyword) {
    throw new Error("Keyword is required.");
  }
  if (!title) {
    throw new Error("Title is required.");
  }
  if (!responseText) {
    throw new Error("Response text is required.");
  }

  return { keyword, title, responseText, category, active };
}

function createDadCode(input) {
  const entry = validateEntry(input);
  const result = db
    .prepare(
      `INSERT INTO dad_codes (keyword, title, responseText, category, active)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(entry.keyword, entry.title, entry.responseText, entry.category, entry.active);
  return getDadCodeById(result.lastInsertRowid);
}

function updateDadCode(id, input) {
  const entry = validateEntry(input);
  const result = db
    .prepare(
      `UPDATE dad_codes
       SET keyword = ?, title = ?, responseText = ?, category = ?, active = ?, updatedAt = CURRENT_TIMESTAMP
       WHERE id = ?`
    )
    .run(entry.keyword, entry.title, entry.responseText, entry.category, entry.active, Number(id));

  if (result.changes === 0) {
    throw new Error("Entry not found.");
  }

  return getDadCodeById(id);
}

function deleteDadCode(id) {
  const result = db.prepare("DELETE FROM dad_codes WHERE id = ?").run(Number(id));
  if (result.changes === 0) {
    throw new Error("Entry not found.");
  }
  return { ok: true };
}

seedDadCodes();

module.exports = {
  normalizeKeyword,
  listDadCodes,
  getDadCodeByKeyword,
  createDadCode,
  updateDadCode,
  deleteDadCode,
};
