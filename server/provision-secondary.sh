#!/usr/bin/env bash
# One-time: create the secondary relay (Azure Container Apps, eastus2). Redeploys use server/deploy.sh secondary.
# Needs: env cae-petpack-eus2, ACR acrpetpack9bb492 (admin on), storage stpetpack9bb492 with share relaydata.
# Never prints secrets: they go into a 600 temp file that is removed on exit.
set -euo pipefail

SUB=${SUB:-sundries}
RG=${RG:-rg-petpack-hackathon}
LOC=${LOC:-eastus2}
ENV_NAME=${ENV_NAME:-cae-petpack-eus2}
APP2=${APP2:-petpack-relay-2}
ACR=${ACR:-acrpetpack9bb492}
ST=${ST:-stpetpack9bb492}
SHARE=${SHARE:-relaydata}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d)
chmod 700 "$WORK"
trap 'rm -rf "$WORK"' EXIT

# Azure Files share as environment storage (idempotent)
ST_KEY=$(az storage account keys list -g "$RG" -n "$ST" --subscription "$SUB" --query '[0].value' -o tsv)
az containerapp env storage set -g "$RG" -n "$ENV_NAME" --subscription "$SUB" --storage-name "$SHARE" \
  --azure-file-account-name "$ST" --azure-file-account-key "$ST_KEY" --azure-file-share-name "$SHARE" \
  --access-mode ReadWrite -o none
unset ST_KEY

# first image
WS_DIR="$ROOT/node_modules/ws"
mkdir -p "$WORK/ctx/server" "$WORK/ctx/shared" "$WORK/ctx/node_modules"
cp "$ROOT/server/relay.js" "$WORK/ctx/server/"
cp "$ROOT/shared/protocol.js" "$WORK/ctx/shared/"
cp -R "$WS_DIR" "$WORK/ctx/node_modules/ws"
cp "$ROOT/server/Dockerfile" "$WORK/ctx/Dockerfile"
printf '%s\n' '{ "name": "petpack-relay", "private": true, "type": "module", "scripts": { "start": "node server/relay.js" } }' > "$WORK/ctx/package.json"
IMAGE="$ACR.azurecr.io/petpack-relay:$(date -u +%Y%m%d%H%M%S)-$(git -C "$ROOT" rev-parse --short HEAD)"
docker build -q -t "$IMAGE" "$WORK/ctx" >/dev/null
az acr login -n "$ACR" --subscription "$SUB" >/dev/null 2>&1
docker push -q "$IMAGE" >/dev/null

ENV_ID=$(az containerapp env show -g "$RG" -n "$ENV_NAME" --subscription "$SUB" --query id -o tsv)
export ACR_PW SALT ENV_ID IMAGE ACR LOC APP2 SHARE
ACR_PW=$(az acr credential show -n "$ACR" --subscription "$SUB" --query 'passwords[0].value' -o tsv)
SALT=$(openssl rand -hex 16)
node -e '
const e = process.env
const app = {
  location: e.LOC, name: e.APP2, type: "Microsoft.App/containerApps",
  properties: {
    managedEnvironmentId: e.ENV_ID,
    configuration: {
      activeRevisionsMode: "Single",
      ingress: { external: true, targetPort: 8787, transport: "auto", allowInsecure: false },
      registries: [{ server: `${e.ACR}.azurecr.io`, username: e.ACR, passwordSecretRef: "acr-pw" }],
      secrets: [{ name: "acr-pw", value: e.ACR_PW }, { name: "salt", value: e.SALT }]
    },
    template: {
      containers: [{
        name: "relay", image: e.IMAGE, resources: { cpu: 0.5, memory: "1Gi" },
        env: [
          { name: "PETPACK_SALT", secretRef: "salt" }, { name: "PETPACK_DATA", value: "/data" },
          { name: "PETPACK_RELAY_NAME", value: e.APP2 }, { name: "PETPACK_REGION", value: e.LOC }
        ],
        volumeMounts: [{ volumeName: "data", mountPath: "/data" }],
        probes: [{ type: "Liveness", httpGet: { path: "/healthz", port: 8787 }, periodSeconds: 15, failureThreshold: 4 }]
      }],
      scale: { minReplicas: 1, maxReplicas: 1 },
      volumes: [{ name: "data", storageType: "AzureFile", storageName: e.SHARE }]
    }
  }
}
require("fs").writeFileSync(process.argv[1], JSON.stringify(app), { mode: 0o600 })
' "$WORK/app.yaml"
unset ACR_PW SALT
az containerapp create -g "$RG" -n "$APP2" --subscription "$SUB" --yaml "$WORK/app.yaml" -o none
FQDN=$(az containerapp show -g "$RG" -n "$APP2" --subscription "$SUB" --query properties.configuration.ingress.fqdn -o tsv)
echo "secondary: wss://$FQDN/ws"
for i in $(seq 1 45); do
  if curl -fsS --max-time 10 "https://$FQDN/healthz"; then echo; exit 0; fi
  sleep 4
done
echo "healthz not up on https://$FQDN" >&2
exit 1
