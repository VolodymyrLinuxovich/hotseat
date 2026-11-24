# The Playwright image ships Chromium and a matching playwright package, which the browser pass
# needs for careers pages that render in JS.
FROM apify/actor-node-playwright-chrome:20

# Only package.json: the lock file could pin a playwright that doesn't match the image's browser.
COPY --chown=myuser package.json ./
RUN npm --quiet set progress=false && npm install --omit=dev --omit=optional

COPY --chown=myuser . ./
CMD npm start --silent
