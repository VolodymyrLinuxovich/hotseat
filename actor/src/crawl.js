// The crawl itself, kept apart from the Actor wrapper so Hotseat's server can run the same code
// in-process when no Apify token is set.
//
// Plain HTTP first through CheerioCrawler, which is fast and polite. Some careers sites (Google,
// Meta, Ramp's engineering blog) render their text in the browser, so a page that comes back
// nearly empty is fetched once more with PlaywrightCrawler.

import { CheerioCrawler, PlaywrightCrawler, log } from "crawlee";
import { load } from "cheerio";

import { CURATED, slugOf } from "./curated.js";

// Hotseat's server builds its in-memory Configuration from the same crawlee copy as the crawlers.
export { Configuration } from "crawlee";
import { baseDomain, embeddedHtml, extractPage, relevantLinks } from "./extract.js";

// Under this many words, with no values and no interview text found, the page probably needs JS.
const THIN_WORDS = 150;

// Paths most companies use for careers and values pages. Tried when a new company has no URLs.
const DISCOVERY_PATHS = ["/careers", "/jobs", "/about", "/about/values", "/values", "/culture"];

function plan(company) {
  const name = String(company.name || "").trim();
  const id = slugOf(name);
  const curated = CURATED[id];

  let urls = (company.urls || []).filter(Boolean);
  let discovery = false;
  if (urls.length === 0 && curated) {
    urls = curated.urls;
  }
  if (urls.length === 0) {
    // A guess, but a cheap one: wrong guesses just 404 and cost one request each.
    const domain = company.domain || `${id.replace(/-/g, "")}.com`;
    urls = DISCOVERY_PATHS.map((p) => `https://${domain}${p}`);
    discovery = true;
  }

  const domains = new Set(urls.map((u) => baseDomain(new URL(u).hostname)));
  if (curated) {
    domains.add(curated.domain);
  }

  return { name, urls, domains, discovery };
}

function thin(item) {
  return item.words < THIN_WORDS && item.values_candidates.length === 0 && item.interview_text.length < 300;
}

function toItem(company, page) {
  const { words, ...rest } = page;
  return { company, ...rest, fetched_at: new Date().toISOString() };
}

/**
 * Crawls each company's pages and calls onItem for every useful page.
 *
 * input: { companies: [{ name, urls?, domain? }], maxPagesPerCompany }
 * options.config: a Crawlee Configuration (in-process runs pass one with in-memory storage)
 * options.proxyConfiguration: Apify Proxy on the platform, nothing locally
 * options.browser: false skips the Playwright pass, for environments with no Chromium
 */
export async function crawlCompanies(input, { onItem, config, proxyConfiguration, browser = true } = {}) {
  const companies = (input.companies || []).filter((c) => c && c.name);
  const maxPages = Math.min(Math.max(Number(input.maxPagesPerCompany) || 6, 1), 25);

  const state = new Map();
  const seeds = [];
  for (const company of companies) {
    const p = plan(company);
    // Each company may queue more than it keeps, because some pages 404 or turn out empty.
    state.set(p.name, { ...p, queued: p.urls.length, kept: 0 });
    for (const url of p.urls) {
      seeds.push({ url, uniqueKey: `http:${url}`, userData: { company: p.name, depth: 0 } });
    }
  }

  const browserQueue = [];

  // Redirects and copies under two paths (Amazon has the principles on both) would count twice.
  const seenPages = new Set();

  async function keep(company, page) {
    const s = state.get(company);
    if (s.kept >= maxPages) {
      return;
    }
    // A page with nothing on hiring or values is noise for the profile.
    if (page.values_candidates.length === 0 && page.interview_text.length < 200) {
      return;
    }

    const fingerprint = `${company}|${page.values_candidates.join("|")}|${page.interview_text.slice(0, 500)}`;
    if (seenPages.has(page.url) || seenPages.has(fingerprint)) {
      return;
    }
    seenPages.add(page.url);
    seenPages.add(fingerprint);

    s.kept += 1;
    await onItem(toItem(company, page));
  }

  async function follow($, request, enqueue) {
    const { company, depth } = request.userData;
    const s = state.get(company);
    if (depth >= 2) {
      return;
    }

    const links = relevantLinks($, request.loadedUrl || request.url, s.domains);
    const room = maxPages * 2 - s.queued;
    const next = links.slice(0, Math.max(room, 0));
    if (next.length === 0) {
      return;
    }
    s.queued += next.length;
    await enqueue(next, company, depth + 1);
  }

  const http = new CheerioCrawler(
    {
      proxyConfiguration,
      respectRobotsTxtFile: true,
      maxConcurrency: 3,
      // A small rate: these are company sites, not an API.
      maxRequestsPerMinute: 40,
      maxRequestRetries: 1,
      navigationTimeoutSecs: 20,
      async requestHandler({ request, body, addRequests }) {
        const $ = load(body.toString());
        const { company } = request.userData;

        await follow($, request, (urls, c, depth) => {
          return addRequests(
            urls.map((url) => {
              return { url, uniqueKey: `http:${url}`, userData: { company: c, depth } };
            }),
          );
        });

        const url = request.loadedUrl || request.url;
        const embedded = embeddedHtml($);
        let page = extractPage($, url);
        if (thin(page) && embedded) {
          const decoded = extractPage(load(embedded), url);
          decoded.title = page.title;
          page = decoded;
        }

        if (browser && thin(page)) {
          browserQueue.push({
            url: request.url,
            uniqueKey: `browser:${request.url}`,
            userData: { company, depth: request.userData.depth, http: page },
          });
          return;
        }
        await keep(company, page);
      },
      failedRequestHandler({ request }, error) {
        log.info(`skipped ${request.url}: ${error.message.split("\n")[0]}`);
      },
    },
    config,
  );

  await http.run(seeds);

  if (browserQueue.length === 0) {
    return summary(state);
  }

  log.info(`${browserQueue.length} pages need a browser`);
  const chrome = new PlaywrightCrawler(
    {
      proxyConfiguration,
      respectRobotsTxtFile: true,
      maxConcurrency: 2,
      maxRequestsPerMinute: 20,
      maxRequestRetries: 1,
      navigationTimeoutSecs: 30,
      headless: true,
      launchContext: { launchOptions: { args: ["--mute-audio"] } },
      preNavigationHooks: [
        async ({ page }) => {
          // Text is all we read, so skip the heavy assets.
          await page.route("**/*", (route) => {
            const type = route.request().resourceType();
            if (type === "image" || type === "media" || type === "font") {
              return route.abort();
            }
            return route.continue();
          });
        },
      ],
      async requestHandler({ request, page }) {
        await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
        const $ = load(await page.content());
        const rendered = extractPage($, page.url());

        // Keep whichever version found more, in case the browser got a consent wall.
        const before = request.userData.http;
        const best = rendered.words >= before.words ? rendered : before;
        await keep(request.userData.company, best);
      },
      async failedRequestHandler({ request }, error) {
        log.info(`browser skipped ${request.url}: ${error.message.split("\n")[0]}`);
        await keep(request.userData.company, request.userData.http);
      },
    },
    config,
  );

  await chrome.run(browserQueue);
  return summary(state);
}

function summary(state) {
  return [...state.values()].map((s) => {
    return { company: s.name, kept: s.kept, discovery: s.discovery };
  });
}
