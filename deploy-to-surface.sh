#!/usr/bin/env bash
set -euo pipefail

SURFACE_HOST="100.111.218.113"
SURFACE_USER="brian"
APP_NAME="reminder-app-v1"
ARCHIVE="/tmp/${APP_NAME}.tar.gz"
CONTROL_SOCKET="/tmp/${APP_NAME}-surface-ssh"

cd "$(dirname "$0")"

rm -f "$ARCHIVE" "$CONTROL_SOCKET"
tar \
  --exclude="./node_modules" \
  --exclude="./.DS_Store" \
  -czf "$ARCHIVE" .

echo "Opening one SSH connection to the Surface. Enter the Surface password if asked."
ssh -M -S "$CONTROL_SOCKET" -fN "${SURFACE_USER}@${SURFACE_HOST}"

cleanup() {
  ssh -S "$CONTROL_SOCKET" -O exit "${SURFACE_USER}@${SURFACE_HOST}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "Copying app to Surface..."
scp -o ControlPath="$CONTROL_SOCKET" "$ARCHIVE" "${SURFACE_USER}@${SURFACE_HOST}:${APP_NAME}.tar.gz"

echo "Installing and starting app on Surface..."
ssh -o ControlPath="$CONTROL_SOCKET" "${SURFACE_USER}@${SURFACE_HOST}" 'powershell -NoProfile -ExecutionPolicy Bypass -Command -' <<'PS'
$ErrorActionPreference = "Stop"
$AppName = "reminder-app-v1"
$App = Join-Path $HOME $AppName
$Archive = Join-Path $HOME "$AppName.tar.gz"

if (Test-Path $App) {
  Remove-Item -Recurse -Force $App
}

New-Item -ItemType Directory -Force $App | Out-Null
tar -xzf $Archive -C $App
cd $App

if (!(Get-Command npm -ErrorAction SilentlyContinue)) {
  throw "Node/npm is not installed on the Surface. Install Node.js LTS, then run this deploy again."
}

npm install

$Existing = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty OwningProcess -Unique

foreach ($Pid in $Existing) {
  Stop-Process -Id $Pid -Force -ErrorAction SilentlyContinue
}

$OutLog = Join-Path $App "surface-app.out.log"
$ErrLog = Join-Path $App "surface-app.err.log"

Remove-Item $OutLog, $ErrLog -Force -ErrorAction SilentlyContinue
Start-Process `
  -FilePath "node" `
  -ArgumentList "src/index.js" `
  -WorkingDirectory $App `
  -RedirectStandardOutput $OutLog `
  -RedirectStandardError $ErrLog `
  -WindowStyle Hidden
Start-Sleep -Seconds 3

try {
  $Response = Invoke-WebRequest -UseBasicParsing "http://localhost:3000/api/settings" -TimeoutSec 10
  if ($Response.StatusCode -ne 200) {
    throw "Unexpected status code $($Response.StatusCode)"
  }
  Write-Host "Reminder app is running on the Surface."
  Write-Host "Open: http://100.111.218.113:3000"
} catch {
  Write-Host "--- app stdout ---"
  if (Test-Path $OutLog) { Get-Content $OutLog -Tail 40 }
  Write-Host "--- app stderr ---"
  if (Test-Path $ErrLog) { Get-Content $ErrLog -Tail 40 }
  throw "The app started command was sent, but the website did not answer yet: $($_.Exception.Message)"
}
PS

echo "Checking Surface website from this Mac..."
curl -fsS --connect-timeout 10 "http://${SURFACE_HOST}:3000/api/settings" >/dev/null
echo "Done. Open http://${SURFACE_HOST}:3000"
