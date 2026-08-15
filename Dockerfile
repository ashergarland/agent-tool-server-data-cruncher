# syntax=docker/dockerfile:1
FROM node:22-alpine3.22 AS build
WORKDIR /workspace

COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build \
  && npm ci --omit=dev --ignore-scripts \
  && npm cache clean --force

FROM node:22-alpine3.22 AS runtime

# Alpine removes superseded package revisions, so exact apk pins fail reproducibly rather than
# reliably. The base image is pinned to one Alpine release and the build fails if either tool is
# older than the version this server is tested against (jq 1.7, ripgrep 14).
RUN apk add --no-cache jq ripgrep \
  && jq --version \
  && rg --version | head -n1 \
  && jq --version | grep -Eq '^jq-(1\.[7-9]|1\.[1-9][0-9]|[2-9])' \
  && rg --version | head -n1 | grep -Eq '^ripgrep (1[4-9]|[2-9][0-9])\.' \
  && printf '%s\n%s\n' "$(jq --version)" "$(rg --version | head -n1)" > /etc/data-cruncher-tooling

ARG GIT_SHA=unknown
ARG SERVICE_VERSION=0.0.0-dev
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    GIT_SHA=${GIT_SHA} \
    SERVICE_VERSION=${SERVICE_VERSION} \
    DATA_ROOT=/data \
    LOCAL_PATHS_ENABLED=true \
    TEMP_DIR=/tmp/data-cruncher

WORKDIR /app
RUN mkdir -p /data /tmp/data-cruncher \
  && chown node:node /data /tmp/data-cruncher \
  && chmod 700 /tmp/data-cruncher

COPY --from=build --chown=node:node /workspace/node_modules ./node_modules
COPY --from=build --chown=node:node /workspace/dist ./dist
COPY --chown=node:node package.json ./

USER node
EXPOSE 8080

# The image runs with a read-only root filesystem as long as /tmp is a writable tmpfs:
#   docker run --read-only --tmpfs /tmp:rw,mode=1777,size=256m ...

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "--enable-source-maps", "dist/index.js"]
