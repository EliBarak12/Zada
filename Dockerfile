# Repo-root Dockerfile so UI-based deploys (Fly.io dashboard "Launch an app",
# or any tool that only looks at the repo root) can build the shop, which
# lives in agent-shop/. CLI users can equally deploy from that directory.
FROM node:22-alpine
WORKDIR /app
COPY agent-shop/package.json agent-shop/package-lock.json ./
RUN npm ci --omit=dev
COPY agent-shop/server ./server
COPY agent-shop/web ./web
ENV PORT=8080
EXPOSE 8080
VOLUME /app/data
CMD ["node", "server/index.mjs"]
