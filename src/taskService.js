const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezonePlugin = require("dayjs/plugin/timezone");
const { getSettings, getCalendarEventsForProfile } = require("./reminderService");

dayjs.extend(utc);
dayjs.extend(timezonePlugin);

const taskStatePath = path.join(__dirname, "..", "data", "task-state.json");
const publicActionSecretPath = path.join(__dirname, "..", "data", "public-action-secret.txt");
const actionLinksPath = path.join(__dirname, "..", "data", "action-links.json");
const completeActionLabel = "Click When Task is Completed";
const heartWormRule = {
  profileId: "josh",
  titlePattern: /heart\s*worm/i,
  intervalDays: 30,
};

function ensureTaskStateFile() {
  if (fs.existsSync(taskStatePath)) {
    return;
  }

  fs.mkdirSync(path.dirname(taskStatePath), { recursive: true });
  fs.writeFileSync(taskStatePath, JSON.stringify({ completed: {}, history: [], reschedules: {} }, null, 2));
}

function getTaskState() {
  ensureTaskStateFile();
  const state = JSON.parse(fs.readFileSync(taskStatePath, "utf8"));
  state.completed = state.completed || {};
  state.history = Array.isArray(state.history) ? state.history : [];
  state.reschedules = state.reschedules || {};
  return state;
}

function saveTaskState(state) {
  fs.mkdirSync(path.dirname(taskStatePath), { recursive: true });
  fs.writeFileSync(taskStatePath, JSON.stringify(state, null, 2));
}

function ensureActionLinksFile() {
  if (fs.existsSync(actionLinksPath)) {
    return;
  }

  fs.mkdirSync(path.dirname(actionLinksPath), { recursive: true });
  fs.writeFileSync(actionLinksPath, JSON.stringify({ links: {} }, null, 2));
}

function getActionLinks() {
  ensureActionLinksFile();
  return JSON.parse(fs.readFileSync(actionLinksPath, "utf8"));
}

function saveActionLinks(state) {
  fs.mkdirSync(path.dirname(actionLinksPath), { recursive: true });
  fs.writeFileSync(actionLinksPath, JSON.stringify(state, null, 2));
}

function getPublicActionSecret() {
  if (!fs.existsSync(publicActionSecretPath)) {
    fs.mkdirSync(path.dirname(publicActionSecretPath), { recursive: true });
    fs.writeFileSync(publicActionSecretPath, crypto.randomBytes(32).toString("hex"));
  }
  return fs.readFileSync(publicActionSecretPath, "utf8").trim();
}

function stableTaskId(profileId, event) {
  return crypto
    .createHash("sha1")
    .update([profileId, event.id, event.dueDateKey].join("|"))
    .digest("hex")
    .slice(0, 16);
}

function shortReplyCode(taskId) {
  return taskId.slice(-4).toUpperCase();
}

function withReplyNumbers(tasks) {
  return tasks.map((task, index) => ({
    ...task,
    replyNumber: index + 1,
  }));
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function createActionToken(profileId, taskId, action, expiresAt) {
  const payload = `${profileId}|${taskId}|${action}|${expiresAt}`;
  const signature = crypto
    .createHmac("sha256", getPublicActionSecret())
    .update(payload)
    .digest("base64url");
  return Buffer.from(`${payload}|${signature}`, "utf8").toString("base64url");
}

function verifyActionToken(token) {
  try {
    const decoded = Buffer.from(String(token || ""), "base64url").toString("utf8");
    const [profileId, taskId, action, expiresAt, signature] = decoded.split("|");
    if (!profileId || !taskId || !action || !expiresAt || !signature) {
      throw new Error("Invalid token.");
    }

    const payload = `${profileId}|${taskId}|${action}|${expiresAt}`;
    const expected = crypto
      .createHmac("sha256", getPublicActionSecret())
      .update(payload)
      .digest("base64url");

    if (signature !== expected) {
      throw new Error("Invalid signature.");
    }

    if (Date.now() > Number(expiresAt)) {
      throw new Error("Link expired.");
    }

    return { profileId, taskId, action };
  } catch (error) {
    throw new Error("Invalid or expired action link.");
  }
}

function createShortActionCode(profileId, taskId, action, expiresAt) {
  const state = getActionLinks();
  const existing = Object.entries(state.links).find(([, link]) =>
    link.profileId === profileId &&
    link.taskId === taskId &&
    link.action === action &&
    Number(link.expiresAt) > Date.now()
  );

  if (existing) {
    return existing[0];
  }

  let code = "";
  do {
    code = crypto.randomBytes(5).toString("base64url");
  } while (state.links[code]);

  state.links[code] = {
    profileId,
    taskId,
    action,
    expiresAt,
    createdAt: new Date().toISOString(),
  };
  saveActionLinks(state);
  return code;
}

function verifyActionCode(code) {
  const state = getActionLinks();
  const link = state.links[String(code || "")];
  if (!link || Date.now() > Number(link.expiresAt)) {
    throw new Error("Invalid or expired action link.");
  }

  return {
    profileId: link.profileId,
    taskId: link.taskId,
    action: link.action,
  };
}

function buildTaskFromEvent(profileId, timezone, event, completedMap) {
  const taskId = stableTaskId(profileId, event);
  const completion = completedMap[taskId] || null;
  const dueDay = dayjs.utc(`${event.dueDateKey}T12:00:00Z`).tz(timezone);

  return {
    id: taskId,
    sourceEventId: event.id,
    summary: event.summary,
    location: event.location,
    allDay: event.allDay,
    timeLabel: event.timeLabel,
    dayLabel: event.dayLabel,
    dueDateKey: event.dueDateKey,
    dueLabel: dueDay.format("ddd, MMM D"),
    completed: Boolean(completion),
    completedAt: completion?.completedAt || null,
    completedVia: completion?.via || null,
    replyCode: shortReplyCode(taskId),
  };
}

function isHeartWormTask(profileId, task) {
  return profileId === heartWormRule.profileId && heartWormRule.titlePattern.test(task.summary || "");
}

function heartWormRescheduleKey(profileId) {
  return `${profileId}:heart-worm`;
}

function completionDateKey(completedAt, timezone) {
  return dayjs(completedAt).tz(timezone).format("YYYY-MM-DD");
}

function nextDateKeyFromCompletion(completedAt, timezone) {
  return dayjs(completedAt).tz(timezone).startOf("day").add(heartWormRule.intervalDays, "day").format("YYYY-MM-DD");
}

function buildVirtualTaskFromReschedule(reschedule, timezone, completedMap) {
  const dueDay = dayjs.utc(`${reschedule.nextDueDateKey}T12:00:00Z`).tz(timezone);
  const taskId = stableTaskId(reschedule.profileId, {
    id: `${reschedule.rule}:${reschedule.nextDueDateKey}`,
    dueDateKey: reschedule.nextDueDateKey,
  });
  const completion = completedMap[taskId] || null;

  return {
    id: taskId,
    sourceEventId: reschedule.sourceEventId || "",
    summary: reschedule.summary || "Heart Worm Pills",
    location: reschedule.location || "",
    allDay: true,
    timeLabel: "All day",
    dayLabel: dueDay.format("ddd, MMM D"),
    dueDateKey: reschedule.nextDueDateKey,
    dueLabel: dueDay.format("ddd, MMM D"),
    completed: Boolean(completion),
    completedAt: completion?.completedAt || null,
    completedVia: completion?.via || null,
    replyCode: shortReplyCode(taskId),
    rescheduledFromCompletionAt: reschedule.completedAt,
    rescheduledFromTaskId: reschedule.sourceTaskId,
    recurrenceNote: `${heartWormRule.intervalDays} days after last completion`,
  };
}

function applyReschedules(profileId, timezone, tasks, completedMap, reschedules) {
  const reschedule = reschedules[heartWormRescheduleKey(profileId)];
  if (!reschedule) {
    return tasks;
  }

  const completedKey = completionDateKey(reschedule.completedAt, timezone);
  const withoutStaleHeartWorm = tasks.filter((task) => {
    if (!isHeartWormTask(profileId, task)) {
      return true;
    }
    return task.dueDateKey < completedKey;
  });

  return [
    ...withoutStaleHeartWorm,
    buildVirtualTaskFromReschedule(reschedule, timezone, completedMap),
  ];
}

function buildTaskWindow(timezone, days) {
  const start = dayjs().tz(timezone).startOf("day");
  const end = start.add(days, "day");
  const dateKeys = [];
  for (let cursor = start; cursor.isBefore(end); cursor = cursor.add(1, "day")) {
    dateKeys.push(cursor.format("YYYY-MM-DD"));
  }
  return { start, end, dateKeys, todayKey: start.format("YYYY-MM-DD") };
}

async function getTasksForProfile(profileId, options = {}) {
  const settings = getSettings({ includeSecrets: true });
  const profile = settings.profiles.find((item) => item.id === profileId);
  if (!profile) {
    throw new Error("Profile not found.");
  }

  const timezone = profile.timezone || "America/Chicago";
  const days = Math.max(1, Number(options.days || 1));
  const lookbackDays = Math.max(0, Number(options.lookbackDays ?? profile.rolloverDays ?? 1));
  const window = buildTaskWindow(timezone, days);
  const state = getTaskState();

  const calendarEvents = await getCalendarEventsForProfile(profileId, {
    startOffsetDays: -lookbackDays,
    days: lookbackDays + days,
  });

  const tasks = applyReschedules(
    profileId,
    timezone,
    calendarEvents.map((event) => buildTaskFromEvent(profileId, timezone, event, state.completed)),
    state.completed,
    state.reschedules
  );

  const filtered = tasks.filter((task) => {
    const inRequestedWindow = window.dateKeys.includes(task.dueDateKey);
    const carryForward = task.dueDateKey < window.todayKey && !task.completed;
    const completedToday = task.completed && completionDateKey(task.completedAt, timezone) === window.todayKey;
    return inRequestedWindow || carryForward || completedToday;
  });

  filtered.sort((left, right) => {
    if (left.completed !== right.completed) {
      return left.completed ? 1 : -1;
    }
    if (left.dueDateKey !== right.dueDateKey) {
      return left.dueDateKey.localeCompare(right.dueDateKey);
    }
    return left.summary.localeCompare(right.summary);
  });

  return filtered;
}

async function markTaskComplete(profileId, taskId, via = "dashboard") {
  const settings = getSettings({ includeSecrets: true });
  const profile = settings.profiles.find((item) => item.id === profileId);
  if (!profile) {
    throw new Error("Profile not found.");
  }

  const tasks = await getTasksForProfile(profileId, { days: 45, lookbackDays: 30 });
  const task = tasks.find((item) => item.id === taskId);
  if (!task) {
    throw new Error("Task not found.");
  }

  const state = getTaskState();
  const completedAt = new Date().toISOString();
  state.completed[taskId] = {
    profileId,
    completedAt,
    via,
  };
  state.history.push({
    profileId,
    taskId,
    summary: task.summary,
    dueDateKey: task.dueDateKey,
    completedAt,
    via,
  });

  if (isHeartWormTask(profileId, task)) {
    state.reschedules[heartWormRescheduleKey(profileId)] = {
      rule: "heart-worm",
      profileId,
      summary: task.summary || "Heart Worm Pills",
      location: task.location || "",
      sourceTaskId: taskId,
      sourceEventId: task.sourceEventId || "",
      completedAt,
      nextDueDateKey: nextDateKeyFromCompletion(completedAt, profile.timezone || "America/Chicago"),
      intervalDays: heartWormRule.intervalDays,
    };
  }

  saveTaskState(state);

  return {
    ok: true,
    taskId,
  };
}

async function markTaskIncomplete(profileId, taskId) {
  const state = getTaskState();
  const completion = state.completed[taskId];
  if (completion && completion.profileId === profileId) {
    delete state.completed[taskId];
    const rescheduleKey = heartWormRescheduleKey(profileId);
    if (state.reschedules[rescheduleKey]?.sourceTaskId === taskId) {
      delete state.reschedules[rescheduleKey];
    }
    saveTaskState(state);
  }

  return {
    ok: true,
    taskId,
  };
}

function getCompletionHistory(profileId, options = {}) {
  const limit = Math.max(1, Math.min(200, Number(options.limit || 50)));
  const state = getTaskState();
  const historyTaskIds = new Set(state.history.map((entry) => entry.taskId));
  const legacyCompletions = Object.entries(state.completed)
    .filter(([taskId, completion]) => completion.profileId === profileId && !historyTaskIds.has(taskId))
    .map(([taskId, completion]) => ({
      profileId,
      taskId,
      summary: "",
      dueDateKey: "",
      completedAt: completion.completedAt,
      via: completion.via,
    }));

  return [...state.history, ...legacyCompletions]
    .filter((entry) => entry.profileId === profileId)
    .slice()
    .sort((left, right) => String(right.completedAt).localeCompare(String(left.completedAt)))
    .slice(0, limit);
}

async function processReply(profileId, message, via = "reply") {
  const normalized = String(message || "").trim();
  const settings = getSettings({ includeSecrets: true });
  const profile = settings.profiles.find((item) => item.id === profileId);
  if (!profile) {
    throw new Error("Profile not found.");
  }

  const openTasks = await getTasksForProfile(profileId, { days: 1, lookbackDays: 30 });
  const incompleteTasks = buildTaskSections(profile, openTasks.filter((task) => !task.completed)).numberedTasks;
  const simpleDone = /^(done|complete|completed|yes)$/i;

  if (incompleteTasks.length === 1 && simpleDone.test(normalized)) {
    await markTaskComplete(profileId, incompleteTasks[0].id, via);
    return {
      ok: true,
      matched: true,
      taskId: incompleteTasks[0].id,
    };
  }

  const numberMatch = normalized.match(/^(?:done\s+)?(\d{1,2})$/i);
  if (numberMatch) {
    const replyNumber = Number(numberMatch[1]);
    const matchedTask = incompleteTasks.find((task) => task.replyNumber === replyNumber);
    if (!matchedTask) {
      return {
        ok: false,
        matched: false,
        reason: "Reply number did not match an open task.",
      };
    }

    await markTaskComplete(profileId, matchedTask.id, via);
    return {
      ok: true,
      matched: true,
      taskId: matchedTask.id,
    };
  }

  const match = normalized.match(/^(?:done\s+)?([a-z0-9]{4})$/i);
  if (!match) {
    return {
      ok: false,
      matched: false,
      reason: "No matching task reply found.",
    };
  }

  const replyCode = match[1].toUpperCase();
  const matchedTask = incompleteTasks.find((task) => task.replyCode === replyCode);
  if (!matchedTask) {
    return {
      ok: false,
      matched: false,
      reason: "Reply code did not match an open task.",
    };
  }

  await markTaskComplete(profileId, matchedTask.id, via);
  return {
    ok: true,
    matched: true,
    taskId: matchedTask.id,
  };
}

function buildTaskSummary(profile, tasks, options = {}) {
  const todayKey = dayjs().tz(profile.timezone || "America/Chicago").format("YYYY-MM-DD");
  const todayTasks = tasks.filter((task) => task.dueDateKey === todayKey);
  const carriedTasks = tasks.filter((task) => task.dueDateKey < todayKey);
  const numberedTasks = withReplyNumbers([...todayTasks, ...carriedTasks]);
  const numberedTodayTasks = numberedTasks.filter((task) => task.dueDateKey === todayKey);
  const numberedCarriedTasks = numberedTasks.filter((task) => task.dueDateKey < todayKey);
  const baseUrl = String(options.baseUrl || "").replace(/\/$/, "");

  function formatTaskLine(task) {
    const details = [];
    if (!task.allDay) {
      details.push(task.timeLabel);
    } else {
      details.push("All day");
    }
    if (task.location) {
      details.push(task.location);
    }

    const lines = [
      `${task.replyNumber}. ${task.summary}`,
      `   ${details.join(" | ")}`,
    ];

    if (baseUrl) {
      lines.push(`   ${completeActionLabel}: ${taskActionLinks(baseUrl, profile.id, task.id).done}`);
    }

    return lines.join("\n");
  }

  function formatSection(title, sectionTasks, options = {}) {
    if (sectionTasks.length === 0) {
      return `${title}\n- None`;
    }

    const lines = sectionTasks.map((task) => {
      const lead = options.showDue ? `${task.dueLabel} | ` : "";
      const body = formatTaskLine(task).replace(/^/, `- ${lead}`).replace(/\n/g, "\n  ");
      return body;
    });

    return `${title}\n${lines.join("\n")}`;
  }

  const sections = [formatSection("Today", numberedTodayTasks)];
  if (numberedCarriedTasks.length) {
    sections.push(formatSection("Still Open", numberedCarriedTasks, { showDue: true }));
  }

  return `Good morning, ${profile.name}.

${sections.join("\n\n")}

Unfinished tasks will appear again tomorrow.`;
}

function buildTaskSections(profile, tasks) {
  const todayKey = dayjs().tz(profile.timezone || "America/Chicago").format("YYYY-MM-DD");
  const todayTasks = tasks.filter((task) => task.dueDateKey === todayKey);
  const carriedTasks = tasks.filter((task) => task.dueDateKey < todayKey);
  const numberedTasks = withReplyNumbers([...todayTasks, ...carriedTasks]);

  return {
    numberedTasks,
    todayTasks: numberedTasks.filter((task) => task.dueDateKey === todayKey),
    carriedTasks: numberedTasks.filter((task) => task.dueDateKey < todayKey),
  };
}

function taskActionLinks(baseUrl, profileId, taskId) {
  const expiresAt = Date.now() + 1000 * 60 * 60 * 24 * 14;
  const completeToken = createActionToken(profileId, taskId, "complete", expiresAt);
  const tomorrowToken = createActionToken(profileId, taskId, "tomorrow", expiresAt);
  const completeCode = createShortActionCode(profileId, taskId, "complete", expiresAt);
  const tomorrowCode = createShortActionCode(profileId, taskId, "tomorrow", expiresAt);
  return {
    done: `${baseUrl}/public-action/${completeCode}`,
    tomorrow: `${baseUrl}/public-action/${tomorrowCode}`,
    doneLong: `${baseUrl}/public-action?token=${encodeURIComponent(completeToken)}`,
    tomorrowLong: `${baseUrl}/public-action?token=${encodeURIComponent(tomorrowToken)}`,
  };
}

function buildHtmlMessage(profile, sectionTitle, tasks, options = {}) {
  const baseUrl = options.baseUrl || "";
  const actionLabel = options.actionLabel || completeActionLabel;
  const intro = escapeHtml(options.intro || "");
  const cards = tasks
    .map((task) => {
      const links = taskActionLinks(baseUrl, profile.id, task.id);
      const due = escapeHtml(task.dueDateKey < dayjs().tz(profile.timezone || "America/Chicago").format("YYYY-MM-DD") ? task.dueLabel : "Today");
      const timing = escapeHtml(task.allDay ? "All day" : task.timeLabel);
      const summary = escapeHtml(task.summary);
      const location = task.location ? `<div style="color:#5b6475;font-size:14px;margin-top:4px;">${escapeHtml(task.location)}</div>` : "";
      const keepButton = options.showTomorrow
        ? `<a href="${escapeHtml(links.tomorrow)}" style="display:inline-block;padding:10px 14px;border-radius:10px;border:1px solid #cfd5e3;color:#23314d;text-decoration:none;font-weight:600;">Keep for tomorrow</a>`
        : "";

      return `<div style="border:1px solid #d9dfeb;border-radius:14px;padding:16px;margin:0 0 12px;">
        <div style="font-size:13px;color:#5b6475;font-weight:600;margin-bottom:6px;">${due}</div>
        <div style="font-size:18px;font-weight:700;color:#182338;">${task.replyNumber}. ${summary}</div>
        <div style="font-size:14px;color:#5b6475;margin-top:6px;">${timing}</div>
        ${location}
        <div style="margin-top:14px;">
          <a href="${escapeHtml(links.done)}" style="display:inline-block;padding:10px 14px;border-radius:10px;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:700;margin-right:8px;">${escapeHtml(actionLabel)}</a>
          ${keepButton}
        </div>
      </div>`;
    })
    .join("");

  return `<div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;padding:20px;color:#182338;">
    <h1 style="font-size:28px;margin:0 0 10px;">${escapeHtml(sectionTitle)}</h1>
    <p style="font-size:17px;line-height:1.5;margin:0 0 20px;">${intro}</p>
    ${cards}
  </div>`;
}

function buildTaskSummaryMessage(profile, tasks, options = {}) {
  const { numberedTasks, todayTasks, carriedTasks } = buildTaskSections(profile, tasks);
  const text = buildTaskSummary(profile, tasks, options);

  const sections = [];
  if (todayTasks.length) {
    sections.push(buildHtmlMessage(profile, "Today", todayTasks, {
      baseUrl: options.baseUrl,
      intro: "Click when a task is completed.",
      actionLabel: completeActionLabel,
      showTomorrow: false,
    }));
  }
  if (carriedTasks.length) {
    sections.push(buildHtmlMessage(profile, "Still Open", carriedTasks, {
      baseUrl: options.baseUrl,
      intro: "These are unfinished tasks from earlier that are still carrying over.",
      actionLabel: completeActionLabel,
      showTomorrow: false,
    }));
  }
  if (!sections.length) {
    sections.push(`<div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;padding:20px;color:#182338;"><h1 style="font-size:28px;margin:0 0 10px;">Today</h1><p style="font-size:17px;">No tasks for today.</p></div>`);
  }

  return {
    text,
    html: sections.join(""),
    taskCount: numberedTasks.length,
  };
}

function buildCheckInMessage(profile, tasks, options = {}) {
  const numberedTasks = withReplyNumbers(tasks.filter((task) => !task.completed));
  const baseUrl = String(options.baseUrl || "").replace(/\/$/, "");
  const taskLines = numberedTasks.map((task) => {
    const lines = [`- ${task.replyNumber}. ${task.summary}`];
    if (baseUrl) {
      lines.push(`  ${completeActionLabel}: ${taskActionLinks(baseUrl, profile.id, task.id).done}`);
    }
    return lines.join("\n");
  });
  const text = `Good evening, ${profile.name}.

These tasks are still open:
${taskLines.join("\n")}

If you do nothing, these tasks will stay on tomorrow's list.`;

  return {
    text,
    html: buildHtmlMessage(profile, "Evening check-in", numberedTasks, {
      baseUrl: options.baseUrl,
      intro: "These tasks are still open. Click when a task is completed. If not, it will stay on tomorrow's list.",
      actionLabel: completeActionLabel,
      showTomorrow: true,
    }),
    taskCount: numberedTasks.length,
  };
}

module.exports = {
  getTasksForProfile,
  markTaskComplete,
  markTaskIncomplete,
  getCompletionHistory,
  processReply,
  buildTaskSummary,
  buildTaskSummaryMessage,
  buildCheckInMessage,
  verifyActionToken,
  verifyActionCode,
};
