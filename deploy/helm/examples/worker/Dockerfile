# Pass a digest of the toolkit release containing external job support.
ARG TOOLKIT_IMAGE
FROM ${TOOLKIT_IMAGE}
ARG TOOLKIT_IMAGE
USER root
RUN printf '%s\n' "$TOOLKIT_IMAGE" | grep -Eq '^[^[:space:]]+@sha256:[a-f0-9]{64}$' \
    && apt-get update && apt-get install -y --no-install-recommends python3 \
    && rm -rf /var/lib/apt/lists/*
COPY task.py /work/task.py
USER agent
WORKDIR /work
# Keep /app/bin/sageox-agent and its dependencies; the dispatcher selects the host entrypoint.
