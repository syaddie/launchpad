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
# Server › Downloads' videos: ffmpeg joins a video's picture and sound and makes MP3s. Alpine's own
# package, so it's the one for the image's Alpine release and gets its security fixes (an exact
# version can't be pinned: Alpine drops old builds). First, as it changes least.
RUN apk add --no-cache ffmpeg && ffmpeg -hide_banner -version | head -n 1
# Server › Downloads' Instagram posts: instaloader in a Python environment of its own. Before
# the app's files, so this layer stays cached until the pinned version changes.
COPY server/requirements-instagram.txt /tmp/requirements-instagram.txt
RUN apk add --no-cache python3 \
 && python3 -m venv /opt/instaloader \
 && /opt/instaloader/bin/pip install --no-cache-dir --disable-pip-version-check -r /tmp/requirements-instagram.txt \
 && /opt/instaloader/bin/python -c "import instaloader" \
 && rm /tmp/requirements-instagram.txt
ENV INSTALOADER_PYTHON=/opt/instaloader/bin/python
# yt-dlp, pinned in server/requirements-ytdlp.txt (which says how to bump it when a site breaks it),
# in an environment of its own after instaloader's: it's the one bumped most often. It works out
# YouTube's player with the Node.js the image already has.
COPY server/requirements-ytdlp.txt /tmp/requirements-ytdlp.txt
RUN python3 -m venv /opt/yt-dlp \
 && /opt/yt-dlp/bin/pip install --no-cache-dir --disable-pip-version-check -r /tmp/requirements-ytdlp.txt \
 && /opt/yt-dlp/bin/python -c "import yt_dlp, yt_dlp_ejs; print('yt-dlp', yt_dlp.version.__version__)" \
 && rm /tmp/requirements-ytdlp.txt
ENV YTDLP_PYTHON=/opt/yt-dlp/bin/python
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
