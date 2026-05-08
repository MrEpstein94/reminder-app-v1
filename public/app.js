let settings;
let activeProfileId = "brian";
let autoSaveTimer;
let inFlightSavePromise = null;

const nodes = {
  profileList: document.querySelector("#profileList"),
  profileTitle: document.querySelector("#profileTitle"),
  profileEnabled: document.querySelector("#profileEnabled"),
  eveningCheckInEnabled: document.querySelector("#eveningCheckInEnabled"),
  smsEnabled: document.querySelector("#smsEnabled"),
  eventNotificationsEnabled: document.querySelector("#eventNotificationsEnabled"),
  eventNotificationLeadMinutes: document.querySelector("#eventNotificationLeadMinutes"),
  profileName: document.querySelector("#profileName"),
  recipientPhone: document.querySelector("#recipientPhone"),
  summaryTime: document.querySelector("#summaryTime"),
  eveningTime: document.querySelector("#eveningTime"),
  rolloverDays: document.querySelector("#rolloverDays"),
  timezone: document.querySelector("#timezone"),
  calendarUrls: document.querySelector("#calendarUrls"),
  smsStatus: document.querySelector("#smsStatus"),
  events: document.querySelector("#events"),
  eventCount: document.querySelector("#eventCount"),
  completionLog: document.querySelector("#completionLog"),
  toast: document.querySelector("#toast"),
};

function showToast(message) {
  nodes.toast.textContent = message;
  nodes.toast.classList.add("show");
  setTimeout(() => nodes.toast.classList.remove("show"), 2800);
}

function activeProfile() {
  return settings.profiles.find((profile) => profile.id === activeProfileId) || settings.profiles[0];
}

function padTime(value) {
  return String(value || "0").padStart(2, "0");
}

function toTimeValue(hour, minute) {
  return `${padTime(hour)}:${padTime(minute)}`;
}

function fromTimeValue(value, fallbackHour, fallbackMinute) {
  if (!value || !value.includes(":")) {
    return {
      hour: String(fallbackHour || "5"),
      minute: String(fallbackMinute || "30"),
    };
  }

  const [hour, minute] = value.split(":");
  return {
    hour: String(Number(hour)),
    minute: String(Number(minute)),
  };
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDateTime(value) {
  if (!value) {
    return "";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function collectForm() {
  const profile = activeProfile();
  profile.enabled = nodes.profileEnabled.checked;
  profile.eveningCheckInEnabled = nodes.eveningCheckInEnabled.checked;
  profile.smsEnabled = nodes.smsEnabled.checked;
  profile.eventNotificationsEnabled = nodes.eventNotificationsEnabled.checked;
  profile.eventNotificationLeadMinutes = nodes.eventNotificationLeadMinutes.value || "60";
  profile.name = nodes.profileName.value.trim() || "Profile";
  profile.recipientPhone = nodes.recipientPhone.value.trim();
  profile.rolloverDays = nodes.rolloverDays.value || "1";
  profile.timezone = nodes.timezone.value.trim() || "America/Chicago";
  profile.calendarUrls = nodes.calendarUrls.value
    .split("\n")
    .map((url) => url.trim())
    .filter(Boolean);

  const morningTime = fromTimeValue(
    nodes.summaryTime.value,
    profile.dailySummaryHour || "5",
    profile.dailySummaryMinute || "30"
  );
  profile.dailySummaryHour = morningTime.hour;
  profile.dailySummaryMinute = morningTime.minute;

  const eveningTime = fromTimeValue(
    nodes.eveningTime.value,
    profile.eveningCheckInHour || "20",
    profile.eveningCheckInMinute || "0"
  );
  profile.eveningCheckInHour = eveningTime.hour;
  profile.eveningCheckInMinute = eveningTime.minute;
}

function profileSummary(profile) {
  const pieces = [];
  if (profile.enabled) pieces.push("morning");
  if (profile.eveningCheckInEnabled) pieces.push("check-in");
  if (profile.smsEnabled) pieces.push("text");
  if (profile.eventNotificationsEnabled) pieces.push(`${profile.eventNotificationLeadMinutes || 60}m events`);
  if (pieces.length === 0) return "Off";
  return pieces.join(" · ");
}

function renderProfiles() {
  nodes.profileList.innerHTML = "";
  settings.profiles.forEach((profile) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `profileButton ${profile.id === activeProfileId ? "active" : ""}`;
    button.innerHTML = `
      <span class="profileButtonName">${profile.name}</span>
      <span class="profileButtonMeta">${profileSummary(profile)}</span>
    `;
    button.addEventListener("click", () => {
      collectForm();
      queueAutoSave();
      activeProfileId = profile.id;
      window.localStorage.setItem("activeProfileId", activeProfileId);
      render();
      loadEvents();
      loadCompletionLog();
    });
    nodes.profileList.appendChild(button);
  });
}

function renderForm() {
  const profile = activeProfile();
  nodes.profileTitle.textContent = profile.name || "Profile";
  nodes.profileEnabled.checked = Boolean(profile.enabled);
  nodes.eveningCheckInEnabled.checked = profile.eveningCheckInEnabled !== false;
  nodes.smsEnabled.checked = Boolean(profile.smsEnabled);
  nodes.eventNotificationsEnabled.checked = Boolean(profile.eventNotificationsEnabled);
  nodes.eventNotificationLeadMinutes.value = profile.eventNotificationLeadMinutes || "60";
  nodes.profileName.value = profile.name || "";
  nodes.recipientPhone.value = profile.recipientPhone || "";
  nodes.summaryTime.value = toTimeValue(profile.dailySummaryHour || "5", profile.dailySummaryMinute || "30");
  nodes.eveningTime.value = toTimeValue(profile.eveningCheckInHour || "20", profile.eveningCheckInMinute || "0");
  nodes.rolloverDays.value = profile.rolloverDays || "1";
  nodes.timezone.value = profile.timezone || "America/Chicago";
  nodes.calendarUrls.value = (profile.calendarUrls || []).join("\n");
  nodes.smsStatus.textContent = profile.smsEnabled
    ? "Using Sendblue for now"
    : "Off";
}

function render() {
  renderProfiles();
  renderForm();
}

async function updateTaskStatus(taskId, nextAction) {
  const response = await fetch(`/api/tasks/${activeProfileId}/${taskId}/${nextAction}`, {
    method: "POST",
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.error || "Could not update task.");
  }
}

async function loadCompletionLog() {
  nodes.completionLog.innerHTML = '<p class="muted">Loading completions...</p>';
  const response = await fetch(`/api/completions/${activeProfileId}`);
  const body = await response.json();
  if (!response.ok) {
    nodes.completionLog.innerHTML = `<p class="muted">${escapeHtml(body.error)}</p>`;
    return;
  }

  renderCompletionLog(body.completions || []);
}

function renderCompletionLog(completions) {
  if (completions.length === 0) {
    nodes.completionLog.innerHTML = '<p class="muted">No completed tasks recorded yet.</p>';
    return;
  }

  nodes.completionLog.innerHTML = completions
    .map((entry) => `
      <article class="completionItem">
        <div class="completionTitle">${escapeHtml(entry.summary || "Completed task")}</div>
        <div class="completionMeta">
          Completed ${escapeHtml(formatDateTime(entry.completedAt))}
          ${entry.dueDateKey ? ` · Was due ${escapeHtml(entry.dueDateKey)}` : ""}
          ${entry.via ? ` · ${escapeHtml(entry.via)}` : ""}
        </div>
      </article>
    `)
    .join("");
}

function renderEvents(tasks) {
  nodes.eventCount.textContent = `${tasks.length} open`;
  nodes.events.innerHTML = "";

  if (tasks.length === 0) {
    nodes.events.innerHTML = '<p class="muted">Nothing open right now.</p>';
    return;
  }

  tasks.forEach((task) => {
    const item = document.createElement("article");
    item.className = `event ${task.completed ? "done" : ""}`;
    item.innerHTML = `
      <div class="eventTop">
        <div>
          <div class="eventTitle">${escapeHtml(task.summary)}</div>
          <div class="eventTime">${escapeHtml(task.dueLabel)} · ${escapeHtml(task.timeLabel)}</div>
          ${task.location ? `<div class="eventLocation">${escapeHtml(task.location)}</div>` : ""}
          ${task.recurrenceNote ? `<div class="eventLocation">${escapeHtml(task.recurrenceNote)}</div>` : ""}
        </div>
        <span class="taskBadge">${task.completed ? "Completed" : "Open"}</span>
      </div>
      <div class="taskMeta">
        ${task.completed ? `Marked complete ${formatDateTime(task.completedAt)}.` : "Use the button below when this task is completed."}
      </div>
      <div class="taskActions">
        <button class="${task.completed ? "secondary" : ""}" data-action="${task.completed ? "incomplete" : "complete"}" data-task-id="${task.id}" type="button">
          ${task.completed ? "Reopen task" : "Mark done"}
        </button>
      </div>
    `;
    item.querySelector("button").addEventListener("click", async () => {
      try {
        await updateTaskStatus(task.id, task.completed ? "incomplete" : "complete");
        await loadEvents();
        await loadCompletionLog();
        showToast(task.completed ? "Task reopened" : "Task completed");
      } catch (err) {
        showToast(err.message);
      }
    });
    nodes.events.appendChild(item);
  });
}

async function loadSettings() {
  const response = await fetch("/api/settings");
  settings = await response.json();
  settings.profiles = Array.isArray(settings.profiles) ? settings.profiles : [];
  const savedProfileId = window.localStorage.getItem("activeProfileId");
  activeProfileId = settings.profiles.some((profile) => profile.id === savedProfileId)
    ? savedProfileId
    : settings.profiles[0]?.id || "brian";
  render();
  await loadEvents();
  await loadCompletionLog();
}

async function saveSettings(options = {}) {
  collectForm();
  clearTimeout(autoSaveTimer);

  if (!options.force && inFlightSavePromise) {
    return inFlightSavePromise;
  }

  const request = (async () => {
    const response = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    });

    if (!response.ok) {
      const body = await response.json();
      throw new Error(body.error || "Could not save settings.");
    }

    settings = await response.json();
    render();
  })();

  inFlightSavePromise = request;

  try {
    await request;
  } finally {
    if (inFlightSavePromise === request) {
      inFlightSavePromise = null;
    }
  }
}

function queueAutoSave() {
  if (!settings) {
    return;
  }

  collectForm();
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(async () => {
    try {
      await saveSettings();
    } catch (err) {
      showToast(err.message);
    }
  }, 400);
}

async function loadEvents() {
  collectForm();
  nodes.eventCount.textContent = "Loading";
  nodes.events.innerHTML = '<p class="muted">Checking tasks...</p>';

  const response = await fetch(`/api/tasks/${activeProfileId}`);
  const body = await response.json();
  if (!response.ok) {
    nodes.eventCount.textContent = "Error";
    nodes.events.innerHTML = `<p class="muted">${body.error}</p>`;
    return;
  }
  renderEvents(body.tasks);
}

document.querySelector("#saveSettings").addEventListener("click", async () => {
  try {
    await saveSettings();
    await loadEvents();
    await loadCompletionLog();
    showToast("Settings saved");
  } catch (err) {
    showToast(err.message);
  }
});

document.querySelector("#sendTest").addEventListener("click", async () => {
  try {
    await saveSettings();
    const response = await fetch(`/api/send-test/${activeProfileId}`, { method: "POST" });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Could not send test.");
    showToast("Morning test sent");
  } catch (err) {
    showToast(err.message);
  }
});

document.querySelector("#sendCheckInTest").addEventListener("click", async () => {
  try {
    await saveSettings();
    const response = await fetch(`/api/send-checkin-test/${activeProfileId}`, { method: "POST" });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Could not send check-in.");
    showToast(body.skipped ? "No open tasks for check-in" : "Evening test sent");
  } catch (err) {
    showToast(err.message);
  }
});

document.querySelector("#refreshEvents").addEventListener("click", loadEvents);

document.querySelector("#addProfile").addEventListener("click", () => {
  collectForm();
  const id = `profile-${Date.now()}`;
  settings.profiles.push({
    id,
    name: "New Profile",
    enabled: false,
    eveningCheckInEnabled: true,
    smsEnabled: false,
    eventNotificationsEnabled: false,
    eventNotificationLeadMinutes: "60",
    recipientPhone: "",
    timezone: "America/Chicago",
    dailySummaryHour: "5",
    dailySummaryMinute: "30",
    eveningCheckInHour: "20",
    eveningCheckInMinute: "0",
    rolloverDays: "150",
    calendarUrls: [],
  });
  activeProfileId = id;
  window.localStorage.setItem("activeProfileId", activeProfileId);
  render();
  queueAutoSave();
  loadEvents();
});

document.querySelectorAll("input, textarea").forEach((node) => {
  if (node.type === "button") {
    return;
  }
  node.addEventListener("input", queueAutoSave);
  node.addEventListener("change", queueAutoSave);
});

loadSettings().catch((err) => showToast(err.message));
