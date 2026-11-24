// hotseat-company-research: an Apify Actor that collects what a company says about how it hires.
//
// Input:  { "companies": [{ "name": "Stripe", "urls": ["https://stripe.com/jobs/culture"] }], "maxPagesPerCompany": 6 }
// Output: one dataset item per useful page:
//         { company, url, title, headings, values_candidates, interview_text, fetched_at }
//
// Known companies (Google, Amazon, Meta, Stripe, Ramp) start from curated official pages. A new
// company with no URLs starts from the usual careers paths on its domain, and the crawl follows
// same-site links about interviews, hiring, values and culture. robots.txt is respected.
import { Actor } from "apify";
import { log } from "crawlee";

import { crawlCompanies } from "./crawl.js";

await Actor.init();

const input = (await Actor.getInput()) ?? {};

if (!(input.companies ?? []).some((c) => c && c.name)) {
  log.warning("No companies given; nothing to research.");
  await Actor.exit();
}

// Apify Proxy on the platform; none when running locally without one.
let proxyConfiguration;
if (Actor.isAtHome()) {
  try {
    proxyConfiguration = await Actor.createProxyConfiguration();
  } catch (err) {
    log.warning(`No Apify Proxy, using direct connections: ${err.message}`);
  }
}

const summary = await crawlCompanies(input, {
  proxyConfiguration,
  onItem: (item) => Actor.pushData(item),
});

for (const s of summary) {
  log.info(`${s.company}: ${s.kept} pages kept${s.discovery ? " (discovered from the domain)" : ""}`);
}

await Actor.exit();
