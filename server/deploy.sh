#!/usr/bin/env bash
# Deploy the petpack relays (owner: L1). Same code on both; clients fail over in shared/protocol.js RELAYS order.
#   bash server/deploy.sh             primary, then secondary
#   bash server/deploy.sh primary     App Service zip deploy  -> https://petpack-relay.azurewebsites.net
#   bash server/deploy.sh secondary   image to ACR + Container Apps revision -> https://$APP2.$ENV_DOMAIN
#
# Provisioned once on 2026-11-01 (subscription sundries, RG rg-petpack-hackathon):
# - primary: app petpack-relay (Linux, NODE|24-lts, WebSockets on, Always On, https-only, startup
#   "node server/relay.js", SCM_DO_BUILD_DURING_DEPLOYMENT=false, PETPACK_SALT secret) on the existing Linux B1 plan
#   asp-skw-whiteboard (centralus): sundries has 0 B1/P0v3 quota in eastus2 and 1/1 B1 used in centralus.
#   Snapshots go to /home/data/petpack (persistent App Service storage).
# - secondary: Container Apps env cae-petpack-eus2 (eastus2, consumption), app petpack-relay-2 (1 replica, external
#   ingress :8787), image from ACR acrpetpack9bb492, Azure Files share relaydata (stpetpack9bb492) mounted at /data.
# Never prints secrets.
set -euo pipefail

SUB=${SUB:-sundries}
RG=${RG:-rg-petpack-hackathon}
APP=${APP:-petpack-relay}
APP2=${APP2:-petpack-relay-2}
ACR=${ACR:-acrpetpack9bb492}
TARGET=${1:-all}
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

# wait until https://$1/healthz answers from a process younger than $2 (epoch seconds)
wait_fresh () {
  local host=$1 start=$2 body up
  for i in $(seq 1 60); do
    body=$(curl -fsS --max-time 10 "https://$host/healthz" || true)
    up=$(printf '%s' "$body" | sed -n 's/.*"uptimeS":\([0-9]*\).*/\1/p')
    if [ -n "$up" ] && [ "$up" -le $(( $(date +%s) - start + 5 )) ]; then
      echo "$body"; echo "deployed: wss://$host/ws"; return 0
    fi
    sleep 4
  done
  echo "healthz did not come up fresh on https://$host (last: ${body:-none})" >&2
  return 1
}

deploy_primary () {
  (cd "$STAGE" && zip -qr "$STAGE/petpack-relay.zip" server shared node_modules package.json)
  local host start
  host=$(az webapp show -g "$RG" -n "$APP" --subscription "$SUB" --query defaultHostName -o tsv)
  start=$(date +%s)
  # --track-status false: the CLI's runtime tracking can hang after a successful OneDeploy; poll /healthz instead
  timeout 300 az webapp deploy -g "$RG" -n "$APP" --subscription "$SUB" --src-path "$STAGE/petpack-relay.zip" \
    --type zip --restart true --track-status false -o none
  wait_fresh "$host" "$start"
}

deploy_secondary () {
  local tag image host start
  tag=$(date -u +%Y%m%d%H%M%S)-$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo local)
  image="$ACR.azurecr.io/petpack-relay:$tag"
  cp "$ROOT/server/Dockerfile" "$STAGE/Dockerfile"
  docker build -q -t "$image" "$STAGE" >/dev/null
  az acr login -n "$ACR" --subscription "$SUB" >/dev/null 2>&1
  docker push -q "$image" >/dev/null
  host=$(az containerapp show -g "$RG" -n "$APP2" --subscription "$SUB" --query properties.configuration.ingress.fqdn -o tsv)
  start=$(date +%s)
  az containerapp update -g "$RG" -n "$APP2" --subscription "$SUB" --image "$image" -o none
  wait_fresh "$host" "$start"
}

case "$TARGET" in
  primary) deploy_primary ;;
  secondary) deploy_secondary ;;
  all) deploy_primary; deploy_secondary ;;
  *) echo "usage: $0 [primary|secondary|all]" >&2; exit 2 ;;
esac
