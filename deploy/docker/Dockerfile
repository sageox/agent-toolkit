# One image, every component the agent needs to run:
#   - the gateway (this toolkit)
#   - the brain (`claude-agent-acp`, spawned as a child over stdio)
#   - `ox`, which the gateway shells to for the team brain
#
# The brain speaks ACP over the gateway's stdin/stdout, so it is a child process rather
# than a peer service — one container is the honest shape for it. What the container
# buys is a real boundary against the host: no ambient login, no inherited environment,
# and secrets that arrive as mounted files.

# ---- dependencies ------------------------------------------------------------
FROM node:22.23.2-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS deps
WORKDIR /app
ARG PNPM_VERSION=10.25.0
RUN corepack enable \
 && corepack prepare "pnpm@${PNPM_VERSION}" --activate

# Manifests only, so a source edit does not invalidate the install layer.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/core/package.json packages/core/
COPY packages/cli/package.json packages/cli/
COPY packages/adapter-buzz/package.json packages/adapter-buzz/
COPY packages/adapter-console/package.json packages/adapter-console/
COPY packages/adapter-slack/package.json packages/adapter-slack/

# Hoisted so the runtime stage needs one node_modules rather than a symlink farm.
#
# esbuild's postinstall is skipped and that is fine: the platform package
# (@esbuild/<os>-<arch>) installs as an optional dependency, which is where the binary
# actually comes from. The `tsx --version` below is the proof — if that ever stops being
# true, the build fails here rather than at the first turn in production.
RUN pnpm install --frozen-lockfile --config.node-linker=hoisted --config.strictDepBuilds=false \
 && ./node_modules/.bin/tsx --version

# ---- runtime -----------------------------------------------------------------
FROM node:22.23.2-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS runtime

RUN apt-get update \
 && apt-get install -y --no-install-recommends age ca-certificates curl git \
 && rm -rf /var/lib/apt/lists/*

# The gateway runs ox itself — the credential stays on this side of the brain boundary.
# Pin the release and verify it so rebuilding this image cannot silently install a newer
# binary. Debian's architecture names match the SageOx release names we support.
ARG OX_VERSION=0.14.3
RUN set -eu; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) checksum="57a3da98394bc34f0ac72855cf8a88b86d11fdb87b4e82fff881e8801f4b1f27" ;; \
      arm64) checksum="626a2ae15b32dc227558b472597e7092a3f324b6977967ad4cd40e06d7a96fdd" ;; \
      *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \
    esac; \
    archive="ox_${OX_VERSION}_linux_${arch}.tar.gz"; \
    curl -fsSL "https://github.com/sageox/ox/releases/download/v${OX_VERSION}/${archive}" -o "/tmp/${archive}"; \
    echo "${checksum}  /tmp/${archive}" | sha256sum -c -; \
    tar -xzf "/tmp/${archive}" -C /usr/local/bin ox; \
    rm "/tmp/${archive}"; \
    ox version

# The brain. Installed as a real binary so the gateway does not reach for npx at runtime,
# which would mean a network fetch on the first turn.
ARG CLAUDE_AGENT_ACP_VERSION=0.68.0
RUN npm install -g "@agentclientprotocol/claude-agent-acp@${CLAUDE_AGENT_ACP_VERSION}" \
 && command -v claude-agent-acp

WORKDIR /app

# Dependencies first, source second. pnpm links workspace packages into each package's
# own node_modules rather than the root, so `packages/` must come from the deps stage
# too — copying only the root node_modules leaves `@sageox/agent-toolkit-*` unresolvable.
# The source copy that follows adds files without removing those links.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages ./packages
COPY . .

# An unprivileged user that owns nothing but its own home.
#
# Its UID remains a build argument for deployment integrations that bind host-owned writable
# state. The generic published image uses 10001, matching the Helm chart.
#
# --non-unique because this image already ships a user at the most common host UID: node,
# at 1000.
ARG AGENT_UID=10001
ARG AGENT_GID=10001
RUN if [ "${AGENT_UID}" -eq 0 ] || [ "${AGENT_GID}" -eq 0 ]; then \
      echo "AGENT_UID/AGENT_GID must not be 0 — the unprivileged user is the boundary this" >&2; \
      echo "image exists to draw. Stage the credentials as the user that runs the deployment." >&2; \
      exit 1; \
    fi \
 && groupadd --non-unique --gid "${AGENT_GID}" agent \
 && useradd --non-unique --create-home --uid "${AGENT_UID}" --gid "${AGENT_GID}" agent \
 && mkdir -p /agents \
 && chown -R "${AGENT_UID}:${AGENT_GID}" /agents /home/agent

USER agent
ENV HOME=/home/agent \
    AGENT_TOOLKIT_HOME=/agents \
    NODE_ENV=production

# Secrets arrive as files under /mnt/secrets-store, which is where resolveSecret looks first.
# Nothing here carries a credential in ENV, because `docker inspect` can read that.

ENTRYPOINT ["/app/bin/sageox-agent"]
CMD ["doctor"]
