const crypto = require("crypto");

const SENDBLUE_API_BASE = "https://api.sendblue.co";

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) {
    return "";
  }
  if (digits.length === 11 && digits.startsWith("1")) {
    return `+${digits}`;
  }
  if (digits.length === 10) {
    return `+1${digits}`;
  }
  if (String(value || "").trim().startsWith("+")) {
    return String(value || "").trim();
  }
  return `+${digits}`;
}

function getSendblueConfig() {
  return {
    apiKey: String(process.env.SENDBLUE_API_KEY || "").trim(),
    apiSecret: String(process.env.SENDBLUE_API_SECRET || "").trim(),
    fromNumber: normalizePhone(process.env.SENDBLUE_FROM_NUMBER || ""),
    webhookSecret: String(process.env.SENDBLUE_WEBHOOK_SECRET || "").trim(),
  };
}

function hasSendblueConfig() {
  const config = getSendblueConfig();
  return Boolean(config.apiKey && config.apiSecret && config.fromNumber);
}

function sendblueHeaders() {
  const config = getSendblueConfig();
  if (!config.apiKey || !config.apiSecret) {
    throw new Error("Sendblue credentials are missing.");
  }

  return {
    "Content-Type": "application/json",
    "sb-api-key-id": config.apiKey,
    "sb-api-secret-key": config.apiSecret,
  };
}

async function sendSendblueMessage({ to, content }) {
  const config = getSendblueConfig();
  const number = normalizePhone(to);

  if (!config.fromNumber) {
    throw new Error("Sendblue sending number is missing.");
  }
  if (!number) {
    throw new Error("Recipient phone number is missing.");
  }
  if (!String(content || "").trim()) {
    throw new Error("Message content is missing.");
  }

  const endpoint =
    String(process.env.SENDBLUE_SEND_MESSAGE_URL || "").trim() ||
    `${SENDBLUE_API_BASE}/api/send-message`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: sendblueHeaders(),
    body: JSON.stringify({
      from_number: config.fromNumber,
      number,
      content: String(content).trim(),
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reason = payload.error_message || payload.message || response.statusText;
    throw new Error(`Sendblue send failed: ${reason}`);
  }

  return payload;
}

async function sendText(to, message) {
  const number = normalizePhone(to);
  const content = String(message || "").trim();

  if (!hasSendblueConfig()) {
    console.log(`[Dad Codes Bot] Reply to ${number || "unknown"}: ${content}`);
    return { ok: true, logged: true };
  }

  return sendSendblueMessage({ to: number, content });
}

async function listSendblueWebhooks() {
  const response = await fetch(`${SENDBLUE_API_BASE}/api/account/webhooks`, {
    headers: sendblueHeaders(),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reason = payload.error_message || payload.message || response.statusText;
    throw new Error(`Unable to read Sendblue webhooks: ${reason}`);
  }
  return payload.webhooks || {};
}

async function addSendblueReceiveWebhook(webhookUrl) {
  const config = getSendblueConfig();
  const response = await fetch(`${SENDBLUE_API_BASE}/api/account/webhooks`, {
    method: "POST",
    headers: sendblueHeaders(),
    body: JSON.stringify({
      type: "receive",
      webhooks: [
        config.webhookSecret
          ? { url: webhookUrl, secret: config.webhookSecret }
          : webhookUrl,
      ],
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reason = payload.error_message || payload.message || response.statusText;
    throw new Error(`Unable to add Sendblue webhook: ${reason}`);
  }

  return payload;
}

function webhookMatches(existingValue, webhookUrl, webhookSecret) {
  if (!existingValue) {
    return false;
  }
  if (typeof existingValue === "string") {
    return existingValue === webhookUrl && !webhookSecret;
  }
  return (
    existingValue.url === webhookUrl &&
    String(existingValue.secret || "") === String(webhookSecret || "")
  );
}

async function ensureSendblueReceiveWebhook(webhookUrl) {
  if (!hasSendblueConfig()) {
    return { skipped: true, reason: "missing-config" };
  }

  const config = getSendblueConfig();
  const webhooks = await listSendblueWebhooks();
  const receiveWebhooks = Array.isArray(webhooks.receive) ? webhooks.receive : [];
  const alreadyPresent = receiveWebhooks.some((item) =>
    webhookMatches(item, webhookUrl, config.webhookSecret)
  );

  if (alreadyPresent) {
    return { skipped: true, reason: "already-configured" };
  }

  return addSendblueReceiveWebhook(webhookUrl);
}

function isValidSendblueWebhook(req) {
  const secret = String(process.env.SENDBLUE_WEBHOOK_SECRET || "").trim();
  if (!secret) {
    return true;
  }

  return req.get("sb-signing-secret") === secret;
}

function buildSendblueWebhookSecret() {
  return crypto.randomBytes(24).toString("hex");
}

module.exports = {
  normalizePhone,
  getSendblueConfig,
  hasSendblueConfig,
  sendText,
  sendSendblueMessage,
  ensureSendblueReceiveWebhook,
  isValidSendblueWebhook,
  buildSendblueWebhookSecret,
};
