const state = {
  entries: [],
  search: "",
};

const elements = {
  form: document.getElementById("entryForm"),
  formTitle: document.getElementById("formTitle"),
  entryId: document.getElementById("entryId"),
  keyword: document.getElementById("keyword"),
  title: document.getElementById("title"),
  responseText: document.getElementById("responseText"),
  category: document.getElementById("category"),
  active: document.getElementById("active"),
  resetForm: document.getElementById("resetForm"),
  search: document.getElementById("search"),
  entriesBody: document.getElementById("entriesBody"),
  emptyState: document.getElementById("emptyState"),
  toast: document.getElementById("toast"),
};

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("show");
  setTimeout(() => elements.toast.classList.remove("show"), 2500);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || "Request failed.");
  }
  return payload;
}

function resetForm() {
  elements.form.reset();
  elements.entryId.value = "";
  elements.active.checked = true;
  elements.formTitle.textContent = "Add entry";
  elements.keyword.focus();
}

function entryFromForm() {
  return {
    keyword: elements.keyword.value,
    title: elements.title.value,
    responseText: elements.responseText.value,
    category: elements.category.value,
    active: elements.active.checked,
  };
}

function fillForm(entry) {
  elements.entryId.value = entry.id;
  elements.keyword.value = entry.keyword;
  elements.title.value = entry.title;
  elements.responseText.value = entry.responseText;
  elements.category.value = entry.category || "";
  elements.active.checked = Boolean(entry.active);
  elements.formTitle.textContent = `Edit: ${entry.keyword}`;
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function filteredEntries() {
  const term = state.search.trim().toLowerCase();
  if (!term) {
    return state.entries;
  }
  return state.entries.filter((entry) =>
    [entry.keyword, entry.title, entry.responseText, entry.category]
      .join(" ")
      .toLowerCase()
      .includes(term)
  );
}

function renderEntries() {
  const entries = filteredEntries();
  elements.entriesBody.innerHTML = "";
  elements.emptyState.hidden = entries.length > 0;

  for (const entry of entries) {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td><strong>${escapeHtml(entry.keyword)}</strong></td>
      <td>${escapeHtml(entry.title)}</td>
      <td class="dadResponseCell">${escapeHtml(entry.responseText)}</td>
      <td>${escapeHtml(entry.category || "")}</td>
      <td><span class="dadStatus ${entry.active ? "on" : "off"}">${entry.active ? "true" : "false"}</span></td>
      <td class="dadActions">
        <button class="secondary" type="button" data-action="edit" data-id="${entry.id}">Edit</button>
        <button class="danger" type="button" data-action="delete" data-id="${entry.id}">Delete</button>
      </td>
    `;
    elements.entriesBody.appendChild(row);
  }
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

async function loadEntries() {
  const payload = await api("/api/dad-codes");
  state.entries = payload.entries || [];
  renderEntries();
}

async function saveEntry(event) {
  event.preventDefault();
  const id = elements.entryId.value;
  const payload = entryFromForm();

  if (id) {
    await api(`/api/dad-codes/${id}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    showToast("Entry updated.");
  } else {
    await api("/api/dad-codes", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    showToast("Entry added.");
  }

  resetForm();
  await loadEntries();
}

async function handleTableClick(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) {
    return;
  }

  const id = Number(button.dataset.id);
  const entry = state.entries.find((item) => item.id === id);
  if (!entry) {
    return;
  }

  if (button.dataset.action === "edit") {
    fillForm(entry);
    return;
  }

  if (button.dataset.action === "delete") {
    const confirmed = window.confirm(`Delete "${entry.keyword}"?`);
    if (!confirmed) {
      return;
    }
    await api(`/api/dad-codes/${id}`, { method: "DELETE" });
    showToast("Entry deleted.");
    await loadEntries();
  }
}

function bindEvents() {
  elements.form.addEventListener("submit", (event) => {
    saveEntry(event).catch((error) => showToast(error.message));
  });
  elements.resetForm.addEventListener("click", resetForm);
  elements.entriesBody.addEventListener("click", (event) => {
    handleTableClick(event).catch((error) => showToast(error.message));
  });
  elements.search.addEventListener("input", () => {
    state.search = elements.search.value;
    renderEntries();
  });
}

bindEvents();
loadEntries().catch((error) => showToast(error.message));
