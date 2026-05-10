require("dotenv").config();

const express = require("express");
const fs = require("fs");
const path = require("path");
const cron = require("node-cron");
const {
  getSettings,
  saveSettings,
  getEventsForProfile,
  sendProfileSummary,
  sendProfileCheckIn,
  sendDueEventNotifications,
} = require("./reminderService");
const {
  getTasksForProfile,
  markTaskComplete,
  markTaskIncomplete,
  getCompletionHistory,
  processReply,
  verifyActionCode,
  verifyActionToken,
} = require("./taskService");
const {
  normalizePhone,
  ensureSendblueReceiveWebhook,
  isValidSendblueWebhook,
  hasSendblueConfig,
  sendText,
} = require("./sendblueService");
const {
  normalizeKeyword,
  listDadCodes,
  getDadCodeByKeyword,
  createDadCode,
  updateDadCode,
  deleteDadCode,
} = require("./dadCodesDb");
const { store } = require("./store");

const app = express();
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "0.0.0.0";
const scheduledJobs = new Map();
const defaultPublicBaseUrl = "https://desktop-rr2351g-1.tail8569a9.ts.net";

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));
app.use(
  express.static(path.join(__dirname, "..", "public"), {
    etag: false,
    lastModified: false,
    setHeaders(res, filePath) {
      if (/\.(html|js|css)$/i.test(filePath)) {
        res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
        res.setHeader("Pragma", "no-cache");
        res.setHeader("Expires", "0");
        return;
      }

      res.setHeader("Cache-Control", "public, max-age=3600");
    },
  })
);

app.get("/healthz", (_req, res) => {
  res.status(200).json({ ok: true });
});

function cronForProfile(profile) {
  const hour = String(profile.dailySummaryHour || "5").padStart(2, "0");
  const minute = String(profile.dailySummaryMinute || "30").padStart(2, "0");
  return `${Number(minute)} ${Number(hour)} * * *`;
}

function eveningCronForProfile(profile) {
  const hour = String(profile.eveningCheckInHour || "20").padStart(2, "0");
  const minute = String(profile.eveningCheckInMinute || "0").padStart(2, "0");
  return `${Number(minute)} ${Number(hour)} * * *`;
}

function stopScheduledJobs() {
  for (const job of scheduledJobs.values()) {
    job.stop();
  }
  scheduledJobs.clear();
}

function refreshSchedules() {
  stopScheduledJobs();

  const settings = getSettings({ includeSecrets: true });
  for (const profile of settings.profiles.filter((item) => item.enabled)) {
    const summaryJob = cron.schedule(
      cronForProfile(profile),
      () => {
        sendProfileSummary(profile.id).catch((error) => {
          console.error(`Daily summary failed for ${profile.name}: ${error.message}`);
        });
      },
      { timezone: profile.timezone || "America/Chicago" }
    );

    scheduledJobs.set(`${profile.id}:summary`, summaryJob);

    if (profile.eveningCheckInEnabled !== false) {
      const checkInJob = cron.schedule(
        eveningCronForProfile(profile),
        () => {
          sendProfileCheckIn(profile.id).catch((error) => {
            console.error(`Evening check-in failed for ${profile.name}: ${error.message}`);
          });
        },
        { timezone: profile.timezone || "America/Chicago" }
      );

      scheduledJobs.set(`${profile.id}:checkin`, checkInJob);
    }

    if (profile.eventNotificationsEnabled) {
      const notificationJob = cron.schedule(
        "*/5 * * * *",
        () => {
          sendDueEventNotifications(profile.id).catch((error) => {
            console.error(`Event notification failed for ${profile.name}: ${error.message}`);
          });
        },
        { timezone: profile.timezone || "America/Chicago" }
      );

      scheduledJobs.set(`${profile.id}:event-notifications`, notificationJob);
    }
  }
}

function getProfilesForPhone(number) {
  const normalized = normalizePhone(number);
  if (!normalized) {
    return [];
  }

  const settings = getSettings({ includeSecrets: true });
  return settings.profiles.filter(
    (profile) =>
      profile.enabled &&
      profile.smsEnabled &&
      normalizePhone(profile.recipientPhone) === normalized
  );
}

function isOutboundWebhook(value) {
  if (typeof value === "boolean") {
    return value;
  }
  return /^(true|1|yes)$/i.test(String(value || "").trim());
}

function webhookStatus(value) {
  return String(value || "").trim().toUpperCase();
}

function getDadCodesAllowedPhones() {
  const fallbackPhone = process.env.TO_PHONE || "";
  return {
    dad: normalizePhone(process.env.DAD_PHONE || fallbackPhone),
    mom: normalizePhone(process.env.MOM_PHONE || fallbackPhone),
    me: normalizePhone(process.env.MY_PHONE || fallbackPhone),
  };
}

function getDadCodesRole(number) {
  const normalized = normalizePhone(number);
  const allowed = getDadCodesAllowedPhones();

  if (normalized && normalized === allowed.dad) {
    return "dad";
  }
  if (normalized && normalized === allowed.mom) {
    return "mom";
  }
  if (normalized && normalized === allowed.me) {
    return "me";
  }
  return "";
}

function isDadCodesAdmin(role) {
  return role === "mom" || role === "me";
}

function extractSendblueSender(body) {
  return (
    body.from_number ||
    body.fromNumber ||
    body.from ||
    body.number ||
    body.sender ||
    ""
  );
}

function extractSendblueMessage(body) {
  return body.content || body.Body || body.body || body.message || body.text || "";
}

function mappedDadCodeKeyword(message) {
  const normalized = normalizeKeyword(message);
  const phraseMap = {
    "front gate": "gate",
    address: "home",
    "call mom": "mom",
    "call brian": "brian",
  };
  return phraseMap[normalized] || normalized;
}

function dadCodesHelpMessage() {
  const entries = listDadCodes({ includeInactive: false });
  const keywords = entries.map((entry) => entry.keyword).join(", ");
  return `Available phrases: ${keywords || "none yet"}. You can also text help.`;
}

function dadCodesListMessage() {
  const entries = listDadCodes({ includeInactive: false });
  if (!entries.length) {
    return "No active Dad Codes entries are saved yet.";
  }
  return entries
    .map((entry) => `${entry.keyword}: ${entry.title}`)
    .join("\n");
}

async function handleDadCodesText({ from, message }) {
  const role = getDadCodesRole(from);
  if (!role) {
    return {
      ok: false,
      allowed: false,
      reply: "Sorry, this number is not allowed.",
      matched: false,
    };
  }

  const normalized = normalizeKeyword(message);
  if (!normalized || normalized === "help") {
    return { ok: true, allowed: true, reply: dadCodesHelpMessage() };
  }

  if (normalized === "list" && isDadCodesAdmin(role)) {
    return { ok: true, allowed: true, reply: dadCodesListMessage() };
  }

  const entry = getDadCodeByKeyword(mappedDadCodeKeyword(normalized));
  if (entry) {
    return { ok: true, allowed: true, reply: entry.responseText };
  }

  return { ok: true, allowed: true, reply: dadCodesHelpMessage(), matched: false };
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderDadCodesViewerPage() {
  const entries = listDadCodes({ includeInactive: false });
  const quickLinks = entries
    .map(
      (entry) =>
        `<a class="quickLink" href="#${escapeHtml(entry.keyword)}">${escapeHtml(entry.title)}</a>`
    )
    .join("");
  const cards = entries
    .map(
      (entry) => `<article id="${escapeHtml(entry.keyword)}" class="card">
        <p class="keyword">${escapeHtml(entry.title)}</p>
        <h2>${escapeHtml(entry.title)}</h2>
        <p class="response">${escapeHtml(entry.responseText)}</p>
        <p class="category">${escapeHtml(entry.category || "")}</p>
      </article>`
    )
    .join("");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Dad Codes</title>
    <meta name="theme-color" content="#122033" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-title" content="Dad Codes" />
    <link rel="apple-touch-icon" sizes="180x180" href="apple-touch-icon.png" />
    <link rel="icon" type="image/png" sizes="512x512" href="robot-icon-512.png" />
    <link
      rel="icon"
      href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 128 128'%3E%3Crect width='128' height='128' rx='28' fill='%23111f33'/%3E%3Crect x='28' y='34' width='72' height='54' rx='16' fill='%2385d7ff'/%3E%3Ccircle cx='50' cy='58' r='9' fill='%23111f33'/%3E%3Ccircle cx='78' cy='58' r='9' fill='%23111f33'/%3E%3Crect x='46' y='76' width='36' height='8' rx='4' fill='%23111f33'/%3E%3Crect x='61' y='16' width='6' height='18' rx='3' fill='%23ffd166'/%3E%3Ccircle cx='64' cy='12' r='8' fill='%23ff5d73'/%3E%3Crect x='18' y='52' width='12' height='10' rx='5' fill='%23ffd166'/%3E%3Crect x='98' y='52' width='12' height='10' rx='5' fill='%23ffd166'/%3E%3Crect x='40' y='90' width='10' height='20' rx='5' fill='%2385d7ff'/%3E%3Crect x='78' y='90' width='10' height='20' rx='5' fill='%2385d7ff'/%3E%3C/svg%3E"
    />
    <style>
      :root {
        color-scheme: light;
        --ink: #1b2a3a;
        --muted: #5f6b78;
        --line: #d9e2ec;
        --card: rgba(255, 255, 255, 0.94);
        --shadow: 0 18px 44px rgba(27, 42, 58, 0.10);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: Georgia, "Times New Roman", serif;
        color: var(--ink);
        background:
          radial-gradient(circle at top right, rgba(20, 184, 166, 0.16), transparent 28rem),
          radial-gradient(circle at left center, rgba(37, 99, 235, 0.14), transparent 24rem),
          linear-gradient(180deg, #fffef8 0%, #f4f8ff 100%);
      }
      .wrap {
        max-width: 1100px;
        margin: 0 auto;
        padding: 28px 18px 36px;
      }
      .eyebrow {
        margin: 0 0 10px;
        color: #1d4ed8;
        font: 900 12px/1 ui-sans-serif, system-ui, sans-serif;
        letter-spacing: 0.14em;
        text-transform: uppercase;
      }
      h1 {
        margin: 0 0 10px;
        font-size: clamp(42px, 9vw, 84px);
        line-height: 0.94;
        letter-spacing: -0.07em;
      }
      .subhead {
        margin: 0 0 24px;
        max-width: 760px;
        color: var(--muted);
        font: 600 20px/1.5 ui-sans-serif, system-ui, sans-serif;
      }
      .searchCard {
        padding: 16px;
        border: 1px solid var(--line);
        border-radius: 18px;
        background: var(--card);
        box-shadow: var(--shadow);
      }
      .quickLinks {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
      }
      .quickLink {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 48px;
        padding: 10px 16px;
        border: 1px solid rgba(29, 78, 216, 0.12);
        border-radius: 999px;
        color: #1d4ed8;
        background: #ffffff;
        text-decoration: none;
        font: 900 20px/1 ui-sans-serif, system-ui, sans-serif;
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
        gap: 18px;
        margin-top: 20px;
      }
      .card {
        padding: 20px;
        border: 1px solid rgba(37, 99, 235, 0.10);
        border-radius: 20px;
        background: var(--card);
        box-shadow: var(--shadow);
      }
      .keyword {
        margin: 0 0 10px;
        color: #1d4ed8;
        font: 900 12px/1 ui-sans-serif, system-ui, sans-serif;
        letter-spacing: 0.12em;
        text-transform: uppercase;
      }
      h2 {
        margin: 0 0 12px;
        font-size: 30px;
        line-height: 1.05;
      }
      .response {
        margin: 0 0 16px;
        font: 700 24px/1.45 ui-sans-serif, system-ui, sans-serif;
      }
      .category {
        margin: 0;
        color: var(--muted);
        font: 800 15px/1.3 ui-sans-serif, system-ui, sans-serif;
      }
      .empty {
        margin: 18px 0 0;
        color: var(--muted);
        font: 800 18px/1.4 ui-sans-serif, system-ui, sans-serif;
      }
      .hint {
        margin: 0;
        color: var(--muted);
        font: 700 17px/1.45 ui-sans-serif, system-ui, sans-serif;
      }
      @media (max-width: 700px) {
        .subhead { font-size: 18px; }
        .quickLink { font-size: 18px; }
        .response { font-size: 20px; }
      }
    </style>
  </head>
  <body>
    <main class="wrap">
      <p class="eyebrow">Family Lookup</p>
      <h1>Dad Codes</h1>
      <p class="subhead">Open a code below. This page is read-only and phone-friendly.</p>

      <section class="searchCard">
        <p class="hint">Quick links</p>
        <div class="quickLinks">${quickLinks}</div>
      </section>

      <p class="empty"${entries.length ? " hidden" : ""}>No active codes are available.</p>
      <section class="grid">${cards}</section>
    </main>
  </body>
</html>`;
}

function publicDadCodesMirrorPath() {
  const configured = String(process.env.DAD_CODES_PUBLIC_DIR || "").trim();
  if (configured) {
    return path.join(configured, "dad-codes.html");
  }

  if (process.platform === "win32" && process.env.USERPROFILE) {
    return path.join(process.env.USERPROFILE, "reminder-public-site", "dad-codes.html");
  }

  return "";
}

function publicDadCodesMirrorDir() {
  const mirrorPath = publicDadCodesMirrorPath();
  return mirrorPath ? path.dirname(mirrorPath) : "";
}

function syncPublicDadCodesMirror() {
  const target = publicDadCodesMirrorPath();
  if (!target) {
    return { skipped: true, reason: "no-target" };
  }

  const targetDir = publicDadCodesMirrorDir();
  if (!fs.existsSync(targetDir)) {
    return { skipped: true, reason: "missing-directory" };
  }

  fs.writeFileSync(target, renderDadCodesViewerPage(), "utf8");
  for (const assetName of ["apple-touch-icon.png", "robot-icon-512.png", "robot-icon.svg"]) {
    const sourcePath = path.join(__dirname, "..", "public", assetName);
    const targetPath = path.join(targetDir, assetName);
    if (fs.existsSync(sourcePath)) {
      fs.copyFileSync(sourcePath, targetPath);
    }
  }
  return { ok: true, target };
}

app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "admin.html"));
});

app.get("/dad-codes", (req, res) => {
  res.type("html").send(renderDadCodesViewerPage());
});

app.get("/api/settings", (req, res) => {
  res.json(getSettings({ includeSecrets: false }));
});

app.post("/api/settings", async (req, res) => {
  try {
    const saved = await saveSettings(req.body);
    refreshSchedules();
    res.json(saved);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/api/dad-codes", (req, res) => {
  try {
    const viewerMode = req.query.viewer === "true";
    res.json({
      entries: listDadCodes({
        includeInactive: viewerMode ? false : req.query.activeOnly !== "true",
        search: req.query.search || "",
      }),
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/dad-codes", async (req, res) => {
  try {
    const created = await createDadCode(req.body);
    syncPublicDadCodesMirror();
    res.status(201).json(created);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.put("/api/dad-codes/:id", async (req, res) => {
  try {
    const updated = await updateDadCode(req.params.id, req.body);
    syncPublicDadCodesMirror();
    res.json(updated);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.delete("/api/dad-codes/:id", async (req, res) => {
  try {
    const deleted = await deleteDadCode(req.params.id);
    syncPublicDadCodesMirror();
    res.json(deleted);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/api/events/:profileId", async (req, res) => {
  try {
    const events = await getEventsForProfile(req.params.profileId, {
      days: Number(req.query.days || 1),
    });
    res.json({ events });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/api/tasks/:profileId", async (req, res) => {
  try {
    const tasks = await getTasksForProfile(req.params.profileId, {
      days: Number(req.query.days || 1),
    });
    res.json({ tasks });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/api/completions/:profileId", async (req, res) => {
  try {
    res.json({
      completions: await getCompletionHistory(req.params.profileId, {
        limit: Number(req.query.limit || 50),
      }),
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/tasks/:profileId/:taskId/complete", async (req, res) => {
  try {
    const result = await markTaskComplete(req.params.profileId, req.params.taskId, "dashboard");
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/tasks/:profileId/:taskId/incomplete", async (req, res) => {
  try {
    const result = await markTaskIncomplete(req.params.profileId, req.params.taskId);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/task/:profileId/:taskId/:action", async (req, res) => {
  try {
    const { profileId, taskId, action } = req.params;
    let title = "Task updated";
    let body = "You can close this page.";

    if (action === "complete") {
      await markTaskComplete(profileId, taskId, "email-link");
      title = "Task marked done";
      body = "The task has been marked complete.";
    } else if (action === "tomorrow") {
      title = "Task kept for tomorrow";
      body = "The task will stay on tomorrow's list.";
    } else {
      throw new Error("Unknown action.");
    }

    res.type("html").send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <style>
      body { font-family: Arial, sans-serif; background: #f4f7fb; color: #182338; margin: 0; padding: 32px; }
      .card { max-width: 520px; margin: 10vh auto 0; background: #fff; border: 1px solid #d9dfeb; border-radius: 16px; padding: 28px; box-shadow: 0 10px 30px rgba(24,35,56,.08); }
      h1 { margin: 0 0 12px; font-size: 28px; }
      p { margin: 0; font-size: 18px; line-height: 1.5; color: #5b6475; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>${title}</h1>
      <p>${body}</p>
    </div>
  </body>
</html>`);
  } catch (error) {
    res.status(400).type("html").send(`<!doctype html><html><body style="font-family:Arial,sans-serif;padding:24px;"><h1>Unable to update task</h1><p>${error.message}</p></body></html>`);
  }
});

app.get("/public-action", async (req, res) => {
  try {
    const token = String(req.query.token || "");
    const { profileId, taskId, action } = verifyActionToken(token);

    let title = "All set";
    let body = "This task was updated.";

    if (action === "complete") {
      await markTaskComplete(profileId, taskId, "email-link");
      title = "Completed";
      body = "The task has been marked complete.";
    } else if (action === "tomorrow") {
      title = "Saved for tomorrow";
      body = "The task will stay on tomorrow's list.";
    } else {
      throw new Error("Unknown action.");
    }

    res.type("html").send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <style>
      body { font-family: Arial, sans-serif; background: #ffffff; color: #182338; margin: 0; }
      .wrap { min-height: 100vh; display: grid; place-items: center; padding: 24px; }
      .card { max-width: 420px; width: 100%; text-align: center; }
      h1 { margin: 0 0 10px; font-size: 34px; }
      p { margin: 0; color: #5b6475; font-size: 18px; line-height: 1.45; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="card">
        <h1>${title}</h1>
        <p>${body}</p>
      </div>
    </div>
  </body>
</html>`);
  } catch (error) {
    res.status(400).type("html").send(`<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>Unable to update task</title></head>
  <body style="font-family:Arial,sans-serif;margin:0;padding:24px;text-align:center;">
    <h1 style="margin:0 0 10px;">Unable to update task</h1>
    <p style="margin:0;color:#5b6475;">${error.message}</p>
  </body>
</html>`);
  }
});

app.get("/public-action/:code", async (req, res) => {
  try {
    const { profileId, taskId, action } = verifyActionCode(req.params.code);

    let title = "All set";
    let body = "This task was updated.";

    if (action === "complete") {
      await markTaskComplete(profileId, taskId, "email-link");
      title = "Completed";
      body = "The task has been marked complete.";
    } else if (action === "tomorrow") {
      title = "Saved for tomorrow";
      body = "The task will stay on tomorrow's list.";
    } else {
      throw new Error("Unknown action.");
    }

    res.type("html").send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <style>
      body { font-family: Arial, sans-serif; background: #ffffff; color: #182338; margin: 0; }
      .wrap { min-height: 100vh; display: grid; place-items: center; padding: 24px; }
      .card { max-width: 420px; width: 100%; text-align: center; }
      h1 { margin: 0 0 10px; font-size: 34px; }
      p { margin: 0; color: #5b6475; font-size: 18px; line-height: 1.45; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="card">
        <h1>${title}</h1>
        <p>${body}</p>
      </div>
    </div>
  </body>
</html>`);
  } catch (error) {
    res.status(400).type("html").send(`<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>Unable to update task</title></head>
  <body style="font-family:Arial,sans-serif;margin:0;padding:24px;text-align:center;">
    <h1 style="margin:0 0 10px;">Unable to update task</h1>
    <p style="margin:0;color:#5b6475;">${error.message}</p>
  </body>
</html>`);
  }
});

app.post("/api/replies/:profileId", async (req, res) => {
  try {
    const result = await processReply(req.params.profileId, req.body.message, req.body.via || "reply");
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/sendblue/webhook", async (req, res) => {
  try {
    if (!isValidSendblueWebhook(req)) {
      return res.status(403).json({ ok: false, error: "Invalid webhook secret." });
    }

    if (isOutboundWebhook(req.body.is_outbound) || webhookStatus(req.body.status) !== "RECEIVED") {
      return res.json({ ok: true, ignored: true });
    }

    const candidates = getProfilesForPhone(req.body.from_number || req.body.number);
    if (candidates.length !== 1) {
      return res.status(400).json({
        ok: false,
        error:
          candidates.length === 0
            ? "No matching SMS profile was found."
            : "More than one SMS-enabled profile uses this phone number.",
      });
    }

    const result = await processReply(candidates[0].id, req.body.content || req.body.Body || req.body.message, "sms");
    return res.json(result);
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
});

app.post("/webhook/sendblue", async (req, res) => {
  try {
    if (!isValidSendblueWebhook(req)) {
      return res.status(403).json({ ok: false, error: "Invalid webhook secret." });
    }

    if (isOutboundWebhook(req.body.is_outbound)) {
      return res.json({ ok: true, ignored: true });
    }

    const from = extractSendblueSender(req.body);
    const message = extractSendblueMessage(req.body);
    const result = await handleDadCodesText({ from, message });

    if (result.reply) {
      await sendText(from, result.reply);
    }

    return res.json({
      ok: result.ok,
      allowed: result.allowed,
      replied: Boolean(result.reply),
      matched: result.matched !== false,
    });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
});

app.post("/api/send-test/:profileId", async (req, res) => {
  try {
    const result = await sendProfileSummary(req.params.profileId, "Reminder app test");
    res.json({ ok: true, queued: false, result });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/send-checkin-test/:profileId", async (req, res) => {
  try {
    const result = await sendProfileCheckIn(req.params.profileId, "Reminder app evening check-in");
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

async function start() {
  await store.init();
  refreshSchedules();
  syncPublicDadCodesMirror();

  if (hasSendblueConfig()) {
    const publicBaseUrl =
      process.env.APP_PUBLIC_ACTION_BASE_URL ||
      process.env.RENDER_EXTERNAL_URL ||
      defaultPublicBaseUrl;
    ensureSendblueReceiveWebhook(`${publicBaseUrl}/api/sendblue/webhook`).catch((error) => {
      console.error(`Sendblue webhook setup failed: ${error.message}`);
    });
  }

  app.listen(port, host, () => {
    console.log(`Reminder app running at http://${host}:${port}`);
  });
}

start().catch((error) => {
  console.error(`Reminder app failed to start: ${error.message}`);
  process.exit(1);
});
