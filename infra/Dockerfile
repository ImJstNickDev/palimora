FROM debian:bookworm-slim AS typesetter
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl xz-utils && rm -rf /var/lib/apt/lists/*
COPY scripts/install-typesetter.sh /tmp/install-typesetter.sh
RUN bash /tmp/install-typesetter.sh /opt/typst

FROM node:22.21.1-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends g++ libzstd-dev libssl-dev && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/ui/package.json packages/ui/package.json
RUN npm ci
COPY apps apps
COPY packages packages
COPY scripts/build-codec.sh scripts/build-codec.sh
RUN npm run build

FROM node:22.21.1-bookworm-slim AS api
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 zstd chromium fonts-dejavu-core fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji && rm -rf /var/lib/apt/lists/*
COPY --from=typesetter /opt/typst/ /usr/local/bin/
COPY --from=build /app /app
RUN npm prune --omit=dev && chown -R node:node /app
USER node
CMD ["node","apps/api/dist/main.js"]

FROM nginx:1.28-alpine AS web
COPY infra/nginx/web.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
