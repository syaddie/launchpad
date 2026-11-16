# ---- build: typecheck, bundle the web app and the server ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm test

# ---- runtime: just Node and the bundles, no node_modules ----
FROM node:22-alpine
RUN mkdir -p /data && chown node:node /data
# Server › Downloads' Instagram posts: instaloader in a Python environment of its own. Before
# the app's files, so this layer stays cached until the pinned version changes.
COPY server/requirements-instagram.txt /tmp/requirements-instagram.txt
RUN apk add --no-cache python3 \
 && python3 -m venv /opt/instaloader \
 && /opt/instaloader/bin/pip install --no-cache-dir --disable-pip-version-check -r /tmp/requirements-instagram.txt \
 && /opt/instaloader/bin/python -c "import instaloader" \
 && rm /tmp/requirements-instagram.txt
ENV INSTALOADER_PYTHON=/opt/instaloader/bin/python
ENV NODE_ENV=production \
    TZ=Asia/Singapore \
    PORT=8080 \
    DATA_DIR=/data \
    WEB_DIR=/app/web
WORKDIR /app
COPY --from=build /app/dist/server ./server
COPY --from=build /app/dist/web ./web
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
