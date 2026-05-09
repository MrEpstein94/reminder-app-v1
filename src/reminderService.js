const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezonePlugin = require("dayjs/plugin/timezone");
const ical = require("node-ical");
const { hasSendblueConfig, sendSendblueMessage } = require("./sendblueService");

dayjs.extend(utc);
dayjs.extend(timezonePlugin);

const settingsPath = path.join(__dirname, "..", "data", "settings.json");
const notificationStatePath = path.join(__dirname, "..", "data", "notification-state.json");
const calendarStatePath = path.join(__dirname, "..", "data", "calendar-state.json");
const defaultPublicBaseUrl = "https://desktop-rr2351g-1.tail8569a9.ts.net";

function getPublicBaseUrl() {
  return (
    process.env.APP_PUBLIC_ACTION_BASE_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    defaultPublicBaseUrl
  );
}

function splitCalendarUrls(rawValue) {
  return String(rawValue || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function normalizeLeadMinutes(value, fallback = 60) {
  const minutes = Number(value ?? fallback);
  if (!Number.isFinite(minutes)) {
    return String(fallback);
  }
  return String(Math.min(1440, Math.max(5, Math.round(minutes))));
}

function defaultCompletionLinksEnabled(profile = {}, fallback = {}) {
  const id = String(profile.id || fallback.id || "").trim().toLowerCase();
  return id === "josh";
}

function normalizeProfile(profile = {}, fallback = {}) {
  return {
    id: String(profile.id || fallback.id || `profile-${Date.now()}`),
    name: String(profile.name || fallback.name || "Profile"),
    enabled: Boolean(profile.enabled),
    eveningCheckInEnabled:
      profile.eveningCheckInEnabled === undefined
        ? Boolean(fallback.eveningCheckInEnabled ?? true)
        : Boolean(profile.eveningCheckInEnabled),
    smsEnabled:
      profile.smsEnabled === undefined
        ? Boolean(fallback.smsEnabled ?? false)
        : Boolean(profile.smsEnabled),
    completionLinksEnabled:
      profile.completionLinksEnabled === undefined
        ? Boolean(fallback.completionLinksEnabled ?? defaultCompletionLinksEnabled(profile, fallback))
        : Boolean(profile.completionLinksEnabled),
    eventNotificationsEnabled:
      profile.eventNotificationsEnabled === undefined
        ? Boolean(fallback.eventNotificationsEnabled ?? false)
        : Boolean(profile.eventNotificationsEnabled),
    eventNotificationLeadMinutes: normalizeLeadMinutes(
      profile.eventNotificationLeadMinutes,
      fallback.eventNotificationLeadMinutes || 60
    ),
    recipientPhone: String(profile.recipientPhone || fallback.recipientPhone || "").trim(),
    timezone: String(profile.timezone || fallback.timezone || "America/Chicago").trim(),
    dailySummaryHour: String(profile.dailySummaryHour || fallback.dailySummaryHour || "5"),
    dailySummaryMinute: String(profile.dailySummaryMinute || fallback.dailySummaryMinute || "30"),
    eveningCheckInHour: String(profile.eveningCheckInHour || fallback.eveningCheckInHour || "20"),
    eveningCheckInMinute: String(profile.eveningCheckInMinute || fallback.eveningCheckInMinute || "0"),
    rolloverDays: String(profile.rolloverDays || fallback.rolloverDays || "150"),
    titleIncludes: Array.from(profile.titleIncludes || fallback.titleIncludes || [])
      .map((value) => String(value).trim())
      .filter(Boolean),
    titleExcludes: Array.from(profile.titleExcludes || fallback.titleExcludes || [])
      .map((value) => String(value).trim())
      .filter(Boolean),
    calendarUrls: Array.from(profile.calendarUrls || fallback.calendarUrls || [])
      .map((value) => String(value).trim())
      .filter(Boolean),
  };
}

function defaultSettings() {
  return {
    profiles: [
      {
        id: "brian",
        name: "Brian",
        enabled: true,
        eveningCheckInEnabled: true,
        smsEnabled: false,
        completionLinksEnabled: false,
        eventNotificationsEnabled: false,
        eventNotificationLeadMinutes: "60",
        recipientPhone: process.env.TO_PHONE || "",
        timezone: process.env.TIMEZONE || "America/Chicago",
        dailySummaryHour: process.env.DAILY_SUMMARY_HOUR || "5",
        dailySummaryMinute: process.env.DAILY_SUMMARY_MINUTE || "30",
        eveningCheckInHour: process.env.EVENING_CHECK_IN_HOUR || "20",
        eveningCheckInMinute: process.env.EVENING_CHECK_IN_MINUTE || "0",
        rolloverDays: process.env.ROLLOVER_DAYS || "150",
        titleIncludes: [],
        titleExcludes: [],
        calendarUrls: splitCalendarUrls(
          process.env.GOOGLE_CALENDAR_ICAL_URLS || process.env.GOOGLE_CALENDAR_ICAL_URL || ""
        ),
      },
      {
        id: "dad",
        name: "Dad",
        enabled: false,
        eveningCheckInEnabled: true,
        smsEnabled: false,
        completionLinksEnabled: false,
        eventNotificationsEnabled: false,
        eventNotificationLeadMinutes: "60",
        recipientPhone: "",
        timezone: "America/Chicago",
        dailySummaryHour: "5",
        dailySummaryMinute: "30",
        eveningCheckInHour: "20",
        eveningCheckInMinute: "0",
        rolloverDays: "150",
        titleIncludes: [],
        titleExcludes: [],
        calendarUrls: [],
      },
    ],
  };
}

function ensureSettingsFile() {
  if (fs.existsSync(settingsPath)) {
    return;
  }

  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(defaultSettings(), null, 2));
}

function getSettings(options = {}) {
  ensureSettingsFile();
  return JSON.parse(fs.readFileSync(settingsPath, "utf8"));
}

function saveSettings(nextSettings = {}) {
  const current = getSettings({ includeSecrets: true });
  const currentProfiles = new Map(current.profiles.map((profile) => [profile.id, profile]));
  const settings = {
    profiles: (nextSettings.profiles || current.profiles).map((profile) =>
      normalizeProfile(profile, currentProfiles.get(profile.id))
    ),
  };

  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  return settings;
}

function getProfile(settings, profileId) {
  const profile = settings.profiles.find((item) => item.id === profileId);
  if (!profile) {
    throw new Error("Profile not found.");
  }
  return profile;
}

function formatUtcDateKey(date) {
  return dayjs.utc(date).format("YYYY-MM-DD");
}

function dateKeyToLabel(dateKey, timezone) {
  return dayjs.utc(`${dateKey}T12:00:00Z`).tz(timezone).format("ddd, MMM D");
}

function stableId(parts) {
  return crypto.createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 16);
}

function formatTimedRange(start, end, timezone) {
  const startLabel = dayjs(start).tz(timezone).format("h:mm A");
  const endLabel = dayjs(end).tz(timezone).format("h:mm A");
  return `${startLabel}-${endLabel}`;
}

async function loadCalendarEvents(calendarUrls) {
  const parsedCalendars = await Promise.all(
    calendarUrls.map(async (url) => Object.values(await ical.async.fromURL(url)))
  );

  return parsedCalendars.flat().filter((event) => event.type === "VEVENT" && event.start);
}

function calendarSignature(events) {
  const payload = events
    .map((event) => [
      event.uid || "",
      event.summary || "",
      event.description || "",
      event.start ? new Date(event.start).toISOString() : "",
      event.end ? new Date(event.end).toISOString() : "",
    ])
    .sort((left, right) => left.join("|").localeCompare(right.join("|")));

  return crypto.createHash("sha1").update(JSON.stringify(payload)).digest("hex");
}

function mapCalendarEvent(event, timezone) {
  const isAllDay = event.datetype === "date";

  if (isAllDay) {
    const startDateKey = formatUtcDateKey(event.start);
    const endDateKey = formatUtcDateKey(event.end || dayjs.utc(event.start).add(1, "day").toDate());

    return {
      id: event.uid || stableId([event.summary || "untitled", startDateKey]),
      summary: event.summary || "Untitled event",
      description: event.description || "",
      location: event.location || "",
      start: event.start,
      end: event.end || event.start,
      allDay: true,
      startDateKey,
      endDateKey,
      dueDateKey: startDateKey,
      timeLabel: "All day",
      dayLabel: dateKeyToLabel(startDateKey, timezone),
      sortValue: `${startDateKey}T00:00:00Z`,
    };
  }

  const dueDateKey = dayjs(event.start).tz(timezone).format("YYYY-MM-DD");

  return {
    id: event.uid || stableId([event.summary || "untitled", new Date(event.start).toISOString()]),
    summary: event.summary || "Untitled event",
    description: event.description || "",
    location: event.location || "",
    start: event.start,
    end: event.end || event.start,
    allDay: false,
    dueDateKey,
    timeLabel: formatTimedRange(event.start, event.end || event.start, timezone),
    dayLabel: dateKeyToLabel(dueDateKey, timezone),
    sortValue: new Date(event.start).toISOString(),
  };
}

function buildDateRange(timezone, days) {
  const start = dayjs().tz(timezone).startOf("day");
  const end = start.add(days, "day");
  const dateKeys = [];

  for (let cursor = start; cursor.isBefore(end); cursor = cursor.add(1, "day")) {
    dateKeys.push(cursor.format("YYYY-MM-DD"));
  }

  return { start, end, dateKeys };
}

function eventMatchesWindow(event, window, timezone) {
  if (event.allDay) {
    return window.dateKeys.some(
      (dateKey) => dateKey >= event.startDateKey && dateKey < event.endDateKey
    );
  }

  const eventStart = dayjs(event.start).tz(timezone);
  const eventEnd = dayjs(event.end || event.start).tz(timezone);
  return eventStart.isBefore(window.end) && eventEnd.isAfter(window.start);
}

function eventMatchesProfileFilters(event, profile) {
  const summary = String(event.summary || "").toLowerCase();
  const description = String(event.description || "").toLowerCase();
  const searchableText = `${summary}\n${description}`;
  const includes = Array.from(profile.titleIncludes || [])
    .map((value) => String(value).trim().toLowerCase())
    .filter(Boolean);
  const excludes = Array.from(profile.titleExcludes || [])
    .map((value) => String(value).trim().toLowerCase())
    .filter(Boolean);

  if (includes.length && !includes.some((value) => searchableText.includes(value))) {
    return false;
  }

  if (excludes.some((value) => searchableText.includes(value))) {
    return false;
  }

  return true;
}

async function getEventsForProfile(profileId, options = {}) {
  const settings = getSettings({ includeSecrets: true });
  const profile = getProfile(settings, profileId);
  const timezone = profile.timezone || "America/Chicago";
  const days = Math.max(1, Number(options.days || 1));
  const window = buildDateRange(timezone, days);

  if (!profile.calendarUrls.length) {
    return [];
  }

  const rawEvents = await loadCalendarEvents(profile.calendarUrls);

  return rawEvents
    .map((event) => mapCalendarEvent(event, timezone))
    .filter((event) => eventMatchesWindow(event, window, timezone))
    .filter((event) => eventMatchesProfileFilters(event, profile))
    .sort((left, right) => left.sortValue.localeCompare(right.sortValue))
    .map(({ sortValue, startDateKey, endDateKey, ...event }) => event);
}

async function getCalendarEventsForProfile(profileId, options = {}) {
  const settings = getSettings({ includeSecrets: true });
  const profile = getProfile(settings, profileId);
  const timezone = profile.timezone || "America/Chicago";
  const rawEvents = await loadCalendarEvents(profile.calendarUrls || []);

  const days = Math.max(1, Number(options.days || 1));
  const startOffsetDays = Number(options.startOffsetDays || 0);
  const start = dayjs().tz(timezone).startOf("day").add(startOffsetDays, "day");
  const end = start.add(days, "day");
  const dateKeys = [];

  for (let cursor = start; cursor.isBefore(end); cursor = cursor.add(1, "day")) {
    dateKeys.push(cursor.format("YYYY-MM-DD"));
  }

  return rawEvents
    .map((event) => mapCalendarEvent(event, timezone))
    .filter((event) => {
      if (event.allDay) {
        return dateKeys.some((dateKey) => dateKey >= event.startDateKey && dateKey < event.endDateKey);
      }

      const eventStart = dayjs(event.start).tz(timezone);
      const eventEnd = dayjs(event.end || event.start).tz(timezone);
      return eventStart.isBefore(end) && eventEnd.isAfter(start);
    })
    .filter((event) => eventMatchesProfileFilters(event, profile))
    .sort((left, right) => left.sortValue.localeCompare(right.sortValue))
    .map(({ sortValue, startDateKey, endDateKey, ...event }) => event);
}

function buildDailySummary(profile, events) {
  const lines =
    events.length === 0
      ? ["(No events found for today)"]
      : events.map((event) => {
          const location = event.location ? ` at ${event.location}` : "";
          return `- ${event.timeLabel}: ${event.summary}${location}`;
        });

  return `Good morning, ${profile.name}.

Today:
${lines.join("\n")}

${profile.eventNotificationsEnabled ? `I will text you ${profile.eventNotificationLeadMinutes || 60} minutes before each timed event.` : ""}`.trim();
}

function eventStartForMessage(event, timezone) {
  if (event.allDay) {
    return event.dayLabel || event.dueDateKey;
  }
  return `${event.dayLabel}, ${dayjs(event.start).tz(timezone).format("h:mm A")}`;
}

function buildEventNotification(profile, event, leadMinutes = 60) {
  const timezone = profile.timezone || "America/Chicago";
  const location = event.location ? `\nLocation: ${event.location}` : "";
  return `${profile.name}, reminder:

${event.summary}
Starts at ${eventStartForMessage(event, timezone)}.
This is your ${leadMinutes}-minute reminder.${location}`;
}

async function sendTextMessage(profile, message) {
  if (!profile.smsEnabled) {
    return { skipped: true, reason: "sms-disabled" };
  }
  if (!profile.recipientPhone) {
    return { skipped: true, reason: "missing-recipient-phone" };
  }
  if (!hasSendblueConfig()) {
    return { skipped: true, reason: "missing-sendblue-config" };
  }

  const content =
    typeof message === "string" ? message : message.text || "";
  if (!String(content).trim()) {
    return { skipped: true, reason: "missing-message-content" };
  }

  await sendSendblueMessage({
    to: profile.recipientPhone,
    content,
  });

  return { skipped: false };
}

async function sendProfileMessage(profile, _subject, message) {
  const deliveries = [];

  const smsResult = await sendTextMessage(profile, message);
  if (!smsResult.skipped) {
    deliveries.push("sms");
  }

  if (!deliveries.length) {
    throw new Error("No text delivery channel is configured for this profile.");
  }

  return deliveries;
}

async function sendProfileEventText(profile, event, leadMinutes) {
  const smsResult = await sendTextMessage(
    profile,
    buildEventNotification(profile, event, leadMinutes)
  );
  if (smsResult.skipped) {
    return { skipped: true, reason: smsResult.reason };
  }
  return { skipped: false };
}

async function sendProfileSummary(profileId, subject = "Daily reminder summary", options = {}) {
  const settings = getSettings({ includeSecrets: true });
  const profile = getProfile(settings, profileId);
  if (options.waitForRefresh) {
    await waitForCalendarRefresh(profile, options);
  }
  if (profile.completionLinksEnabled === false) {
    const events = await getEventsForProfile(profileId, { days: 1 });
    return sendProfileMessage(profile, subject, buildDailySummary(profile, events));
  }

  const { getTasksForProfile, buildTaskSummaryMessage } = require("./taskService");
  const tasks = await getTasksForProfile(profileId, { days: 1 });
  const baseUrl = getPublicBaseUrl();
  return sendProfileMessage(
    profile,
    subject,
    buildTaskSummaryMessage(profile, tasks, { baseUrl })
  );
}

function ensureNotificationStateFile() {
  if (fs.existsSync(notificationStatePath)) {
    return;
  }

  fs.mkdirSync(path.dirname(notificationStatePath), { recursive: true });
  fs.writeFileSync(notificationStatePath, JSON.stringify({ sent: {} }, null, 2));
}

function getNotificationState() {
  ensureNotificationStateFile();
  return JSON.parse(fs.readFileSync(notificationStatePath, "utf8"));
}

function saveNotificationState(state) {
  fs.mkdirSync(path.dirname(notificationStatePath), { recursive: true });
  fs.writeFileSync(notificationStatePath, JSON.stringify(state, null, 2));
}

function ensureCalendarStateFile() {
  if (fs.existsSync(calendarStatePath)) {
    return;
  }

  fs.mkdirSync(path.dirname(calendarStatePath), { recursive: true });
  fs.writeFileSync(calendarStatePath, JSON.stringify({ profiles: {} }, null, 2));
}

function getCalendarState() {
  ensureCalendarStateFile();
  return JSON.parse(fs.readFileSync(calendarStatePath, "utf8"));
}

function saveCalendarState(state) {
  fs.mkdirSync(path.dirname(calendarStatePath), { recursive: true });
  fs.writeFileSync(calendarStatePath, JSON.stringify(state, null, 2));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCalendarRefresh(profile, options = {}) {
  const maxWaitMs = Number(options.maxWaitMs ?? 10 * 60 * 1000);
  const pollMs = Number(options.pollMs ?? 60 * 1000);
  if (!profile.calendarUrls.length || maxWaitMs <= 0 || pollMs <= 0) {
    return { changed: false, waitedMs: 0 };
  }

  const state = getCalendarState();
  const previousSignature = state.profiles?.[profile.id]?.signature || "";
  const startedAt = Date.now();
  let rawEvents = await loadCalendarEvents(profile.calendarUrls);
  let signature = calendarSignature(rawEvents);

  if (!previousSignature) {
    state.profiles = state.profiles || {};
    state.profiles[profile.id] = {
      signature,
      checkedAt: new Date().toISOString(),
    };
    saveCalendarState(state);
    return { changed: false, waitedMs: 0, rawEvents };
  }

  while (signature === previousSignature && Date.now() - startedAt < maxWaitMs) {
    await delay(pollMs);
    rawEvents = await loadCalendarEvents(profile.calendarUrls);
    signature = calendarSignature(rawEvents);
  }

  state.profiles = state.profiles || {};
  state.profiles[profile.id] = {
    signature,
    checkedAt: new Date().toISOString(),
  };
  saveCalendarState(state);

  return {
    changed: signature !== previousSignature,
    waitedMs: Date.now() - startedAt,
    rawEvents,
  };
}

function notificationKey(profileId, event, kind) {
  const start = event.start ? new Date(event.start).toISOString() : event.dueDateKey;
  return [profileId, event.id, start, kind].join("|");
}

async function sendDueEventNotifications(profileId, now = new Date()) {
  const settings = getSettings({ includeSecrets: true });
  const profile = getProfile(settings, profileId);
  if (!profile.eventNotificationsEnabled) {
    return { skipped: true, reason: "event-notifications-disabled" };
  }

  const timezone = profile.timezone || "America/Chicago";
  const leadMinutes = Number(normalizeLeadMinutes(profile.eventNotificationLeadMinutes, 60));
  const cursor = dayjs(now).tz(timezone);
  const lowerBound = cursor.add(Math.max(0, leadMinutes - 5), "minute");
  const upperBound = cursor.add(leadMinutes + 5, "minute");
  const events = await getEventsForProfile(profileId, { days: 2 });
  const state = getNotificationState();
  const dueEvents = events.filter((event) => {
    if (event.allDay || !event.start) {
      return false;
    }

    const start = dayjs(event.start).tz(timezone);
    const key = notificationKey(profileId, event, `${leadMinutes}-minute`);
    return !state.sent[key] && start.isAfter(lowerBound) && start.isBefore(upperBound);
  });

  const sent = [];
  for (const event of dueEvents) {
    const result = await sendProfileEventText(profile, event, leadMinutes);
    if (result.skipped) {
      continue;
    }
    const key = notificationKey(profileId, event, `${leadMinutes}-minute`);
    state.sent[key] = new Date().toISOString();
    sent.push(event.id);
  }

  if (sent.length) {
    saveNotificationState(state);
  }

  return { skipped: false, sentCount: sent.length };
}

async function sendProfileCheckIn(profileId, subject = "Task check-in") {
  const settings = getSettings({ includeSecrets: true });
  const profile = getProfile(settings, profileId);
  const { getTasksForProfile, buildCheckInMessage } = require("./taskService");
  const tasks = await getTasksForProfile(profileId, { days: 1 });
  const openTasks = tasks.filter((task) => !task.completed);

  if (openTasks.length === 0) {
    return { skipped: true };
  }

  const baseUrl = getPublicBaseUrl();
  const deliveries = await sendProfileMessage(
    profile,
    subject,
    buildCheckInMessage(profile, openTasks, { baseUrl })
  );

  return { skipped: false, taskCount: openTasks.length, deliveries };
}

module.exports = {
  getSettings,
  saveSettings,
  getEventsForProfile,
  getCalendarEventsForProfile,
  sendProfileSummary,
  sendProfileCheckIn,
  sendDueEventNotifications,
};
