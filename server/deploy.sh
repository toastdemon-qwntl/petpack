#!/usr/bin/env bash
# Zip-deploy the petpack relay to Azure App Service (owner: L1).
#   bash server/deploy.sh            stage, zip, deploy, then GET /healthz
# Provisioning (done once, 2026-11-01): app petpack-relay in rg-petpack-hackathon on the existing Linux B1 plan
# asp-skw-whiteboard (sundries, centralus), because sundries has 0 B1/P0v3 quota in eastus2 and 1/1 B1 used in
# centralus. Settings: NODE|24-lts, WebSockets on, Always On, https-only, startup "node server/relay.js",
# SCM_DO_BUILD_DURING_DEPLOYMENT=false, PETPACK_SALT (secret; never printed here).
set -euo pipefail

SUB=${SUB:-sundries}
RG=${RG:-rg-petpack-hackathon}
APP=${APP:-petpack-relay}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

WS_DIR="$ROOT/node_modules/ws"
if [ ! -f "$WS_DIR/package.json" ]; then
  echo "node_modules/ws missing: run npm install (or npm pack ws@8 and extract it there)" >&2
  exit 1
fi

mkdir -p "$STAGE/server" "$STAGE/shared" "$STAGE/node_modules"
cp "$ROOT/server/relay.js" "$STAGE/server/"
cp "$ROOT/shared/protocol.js" "$STAGE/shared/"
cp -R "$WS_DIR" "$STAGE/node_modules/ws"
printf '%s\n' '{ "name": "petpack-relay", "private": true, "type": "module", "scripts": { "start": "node server/relay.js" } }' > "$STAGE/package.json"

(cd "$STAGE" && zip -qr "$STAGE/petpack-relay.zip" server shared node_modules package.json)

HOST=$(az webapp show -g "$RG" -n "$APP" --subscription "$SUB" --query defaultHostName -o tsv)
START=$(date +%s)
# --track-status false: the CLI's runtime tracking can hang after a successful OneDeploy; we poll /healthz instead
timeout 300 az webapp deploy -g "$RG" -n "$APP" --subscription "$SUB" --src-path "$STAGE/petpack-relay.zip" \
  --type zip --restart true --track-status false -o none

# wait for the restarted process: its uptime must be younger than this deploy
for i in $(seq 1 45); do
  BODY=$(curl -fsS --max-time 10 "https://$HOST/healthz" || true)
  UP=$(printf '%s' "$BODY" | sed -n 's/.*"uptimeS":\([0-9]*\).*/\1/p')
  if [ -n "$UP" ] && [ "$UP" -le $(( $(date +%s) - START + 5 )) ]; then
    echo "$BODY"; echo "deployed: wss://$HOST/ws"; exit 0
  fi
  sleep 4
done
echo "healthz did not come up fresh on https://$HOST (last: ${BODY:-none})" >&2
exit 1
