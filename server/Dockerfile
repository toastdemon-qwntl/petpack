# petpack relay image for the secondary relay (Azure Container Apps). Build context: the staging dir that
# server/deploy.sh assembles (server/, shared/, node_modules/ws, package.json).
FROM node:24-alpine
WORKDIR /app
COPY package.json ./
COPY node_modules ./node_modules
COPY shared ./shared
COPY server ./server
ENV NODE_ENV=production PORT=8787
EXPOSE 8787
CMD ["node", "server/relay.js"]
