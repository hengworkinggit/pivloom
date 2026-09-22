FROM node:24.13.0-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium ca-certificates fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g agent-browser@0.38.1

ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV AGENT_BROWSER_ARGS="--no-sandbox,--disable-dev-shm-usage"

WORKDIR /workspace
# This dependency graph was exported from the image used in the real G0 run.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

CMD ["tail", "-f", "/dev/null"]
