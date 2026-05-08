# Reminder App V1 + Dad Codes Bot

This app runs the family reminder dashboard and a simple private helper called Dad Codes Bot.

Dad Codes Bot is for non-sensitive family information only, such as gate codes, addresses, phone numbers, guest WiFi names, and simple notes. Do not store real passwords, banking information, Apple ID details, email passwords, medical portal details, or anything sensitive.

## Install

```bash
npm install
```

## Configure `.env`

Copy the example file if you do not already have `.env`:

```bash
cp .env.example .env
```

Keep the existing reminder settings, then fill in the Dad Codes Bot settings:

```env
DAD_PHONE=+15555555555
MOM_PHONE=+15555555555
MY_PHONE=+15555555555
SENDBLUE_API_KEY=your_sendblue_api_key
SENDBLUE_API_SECRET=your_sendblue_api_secret
SENDBLUE_FROM_NUMBER=+15555555555
```

If the Sendblue API endpoint changes, update this optional value:

```env
SENDBLUE_SEND_MESSAGE_URL=https://api.sendblue.co/api/send-message
```

If Sendblue credentials are missing, Dad Codes Bot logs the reply in the server console instead of crashing.

## Run Locally

Development:

```bash
npm run dev
```

Production-style start:

```bash
npm start
```

By default the app runs at:

```txt
http://127.0.0.1:3000
```

If you want `http://localhost:3000`, set this in `.env`:

```env
HOST=localhost
PORT=3000
```

## Open Admin Page

Dad Codes Bot admin page:

```txt
http://localhost:3000/admin
```

The admin page lets you visually add, edit, delete, search, and activate/deactivate entries.

The SQLite database is stored locally at:

```txt
data/dad-codes.sqlite
```

## Starter Entries

The app seeds these entries the first time the Dad Codes database is created:

- `gate` - Neighborhood Gate
- `home` - Home Address
- `mom` - Mom Phone
- `brian` - Brian Phone
- `wifi` - Guest WiFi

Suggested phrase mapping is built in:

- `front gate` maps to `gate`
- `address` maps to `home`
- `call mom` maps to `mom`
- `call brian` maps to `brian`

## Text Bot Behavior

Incoming Sendblue webhook route:

```txt
POST /webhook/sendblue
```

Approved phone numbers come from `.env`:

- `DAD_PHONE`
- `MOM_PHONE`
- `MY_PHONE`

Dad can text normal keywords and `help`.

Mom and Brian can text normal keywords, `help`, and `list`.

Editing entries by text is intentionally not supported. Use `/admin` for changes.

## Test Webhook With Curl

With Sendblue credentials missing, the reply will print to the server console:

```bash
curl -X POST http://localhost:3000/webhook/sendblue \
  -H 'Content-Type: application/json' \
  -d '{"from_number":"+15555555555","content":"gate"}'
```

Test help:

```bash
curl -X POST http://localhost:3000/webhook/sendblue \
  -H 'Content-Type: application/json' \
  -d '{"from_number":"+15555555555","content":"help"}'
```

Test admin list from `MOM_PHONE` or `MY_PHONE`:

```bash
curl -X POST http://localhost:3000/webhook/sendblue \
  -H 'Content-Type: application/json' \
  -d '{"from_number":"+15555555555","content":"list"}'
```

## API Routes

List entries:

```bash
curl http://localhost:3000/api/dad-codes
```

Create entry:

```bash
curl -X POST http://localhost:3000/api/dad-codes \
  -H 'Content-Type: application/json' \
  -d '{"keyword":"pool","title":"Pool Gate","responseText":"Pool gate code is 1234.","category":"Gate Codes","active":true}'
```

Update entry:

```bash
curl -X PUT http://localhost:3000/api/dad-codes/1 \
  -H 'Content-Type: application/json' \
  -d '{"keyword":"gate","title":"Neighborhood Gate","responseText":"The neighborhood gate code is 1234.","category":"Gate Codes","active":true}'
```

Delete entry:

```bash
curl -X DELETE http://localhost:3000/api/dad-codes/1
```

## Later Webhook Exposure Options

For real Sendblue messages, Sendblue needs a public HTTPS URL pointed at:

```txt
https://your-public-host/webhook/sendblue
```

Reasonable options:

- Tailscale Funnel for a private-device-based public HTTPS endpoint.
- ngrok for quick testing.
- Cloudflare Tunnel for a stable tunnel without opening inbound ports.
- Render for hosting the app directly.

## Existing Reminder App

The reminder dashboard still runs at `/` and the existing reminder Sendblue webhook remains at:

```txt
/api/sendblue/webhook
```
