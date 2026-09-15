# Isolated environment for actual browser-use and product CLI E2E cases.
FROM mcr.microsoft.com/playwright:v1.62.0-noble
RUN apt-get update && apt-get install -y --no-install-recommends python3-venv \
    && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/browser-env \
    && /opt/browser-env/bin/pip install --no-cache-dir 'browser-use==0.13.10' 'browser-harness==0.1.13'
WORKDIR /app
RUN npm install --no-audit --no-fund --ignore-scripts ws@8.21.3
COPY tests/e2e/browser-control /app/tests/e2e/browser-control
COPY packages/service/src/browser-control /app/packages/service/src/browser-control
ENTRYPOINT ["node", "/app/tests/e2e/browser-control/docker-acceptance.mjs"]
CMD ["/evidence"]
