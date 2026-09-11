# Funfair in one container: build the web app and the server, then ship a small
# runtime with just the bundles and `ws`.
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/games/package.json packages/games/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# The server bundle keeps only `ws` external, so this is all the runtime needs.
RUN npm install --omit=dev ws@^8.18.0 && npm cache clean --force
# The bundles are ES modules; say so, or node reparses them on every boot.
RUN node -e "const p=require('./package.json'); p.type='module'; require('fs').writeFileSync('package.json', JSON.stringify(p, null, 2))"
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
ENV PORT=3000 HOST=0.0.0.0 WEB_DIST=/app/apps/web/dist
EXPOSE 3000
USER node
CMD ["node", "apps/server/dist/index.js"]
