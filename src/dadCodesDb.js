const { store, normalizeKeyword } = require("./store");

function validateEntry(input) {
  const keyword = normalizeKeyword(input.keyword);
  const title = String(input.title || "").trim();
  const responseText = String(input.responseText || "").trim();
  const category = String(input.category || "").trim();
  const active = !(input.active === false || input.active === "false");

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

function ensureUniqueKeyword(keyword, excludeId = null) {
  const existing = store.listDadCodes().find(
    (entry) => entry.keyword === keyword && Number(entry.id) !== Number(excludeId)
  );
  if (existing) {
    throw new Error("Keyword already exists.");
  }
}

function listDadCodes(options = {}) {
  return store.listDadCodes(options);
}

function getDadCodeByKeyword(keyword) {
  return store.getDadCodeByKeyword(keyword);
}

async function createDadCode(input) {
  const entry = validateEntry(input);
  ensureUniqueKeyword(entry.keyword);
  return store.createDadCode(entry);
}

async function updateDadCode(id, input) {
  const entry = validateEntry(input);
  ensureUniqueKeyword(entry.keyword, id);
  return store.updateDadCode(id, entry);
}

async function deleteDadCode(id) {
  return store.deleteDadCode(id);
}

module.exports = {
  normalizeKeyword,
  listDadCodes,
  getDadCodeByKeyword,
  createDadCode,
  updateDadCode,
  deleteDadCode,
};
