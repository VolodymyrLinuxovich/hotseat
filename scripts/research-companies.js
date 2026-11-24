// npm run research:companies
//
// Runs the company research Actor for the five built-in companies and checks the hand-researched
// files in data/companies/ against what the official pages say. It never rewrites a profile from
// the scrape. It only:
//   - adds official pages that confirmed something to sources, and
//   - fixes a value's spelling when the official page writes the same value slightly differently
//     (curly quotes, case).
// Everything else (values the pages don't mention, candidates the profile lacks) goes into
// train/data/company_refresh.json for a person to read.

import fs from "node:fs";
import path from "node:path";

import { ROOT } from "../engine/config.js";
import { runActor } from "../engine/research.js";

const COMPANIES = ["google", "amazon", "meta", "stripe", "ramp"];
const DIR = path.join(ROOT, "data", "companies");
const REPORT = path.join(ROOT, "train", "data", "company_refresh.json");

function norm(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// A value counts as confirmed when a scraped candidate is the value or starts with it, since
// candidates are often "Move fast" followed by the explanation.
function findOnPages(value, candidates) {
  const want = norm(value.name);
  return candidates.find((c) => {
    const got = norm(c.text);
    return got === want || got.startsWith(`${want} `);
  });
}

function officialSpelling(value, match) {
  const text = match.text.trim();
  if (norm(text) !== norm(value.name)) {
    return null;
  }
  if (text === value.name) {
    return null;
  }
  return text;
}

async function main() {
  const profiles = COMPANIES.map((id) => {
    return JSON.parse(fs.readFileSync(path.join(DIR, `${id}.json`), "utf8"));
  });

  const input = { companies: profiles.map((p) => ({ name: p.name })), maxPagesPerCompany: 6 };
  console.log(`running the Actor for ${profiles.map((p) => p.name).join(", ")}…`);
  const { items, via } = await runActor(input);
  console.log(`${items.length} pages via ${via}`);

  const report = { ran_at: new Date().toISOString(), via, companies: [] };

  for (const profile of profiles) {
    const pages = items.filter((item) => item.company === profile.name);
    const candidates = pages.flatMap((page) => {
      return page.values_candidates.map((text) => ({ text, url: page.url }));
    });

    const confirmed = [];
    const missing = [];
    const renamed = [];
    const confirmingUrls = new Set();

    for (const value of profile.values) {
      const match = findOnPages(value, candidates);
      if (!match) {
        missing.push(value.name);
        continue;
      }

      confirmed.push({ value: value.name, url: match.url });
      confirmingUrls.add(match.url);

      const spelling = officialSpelling(value, match);
      if (spelling) {
        renamed.push({ from: value.name, to: spelling });
        value.name = spelling;
      }
    }

    // Short candidates the profile doesn't have, for a person to consider. Long ones are prose.
    const known = new Set(profile.values.map((v) => norm(v.name)));
    const notInProfile = [
      ...new Set(candidates.map((c) => c.text).filter((t) => t.length <= 60 && !known.has(norm(t)))),
    ];

    // Interview pages confirm the loop even though there is no field to match them against.
    for (const page of pages) {
      if (page.interview_text.length >= 500) {
        confirmingUrls.add(page.url);
      }
    }

    const addedSources = [];
    for (const page of pages) {
      if (!confirmingUrls.has(page.url) || profile.sources.some((s) => s.url === page.url)) {
        continue;
      }
      const source = { title: page.title || page.url, url: page.url };
      profile.sources.push(source);
      addedSources.push(source);
    }

    const changed = addedSources.length > 0 || renamed.length > 0;
    if (changed) {
      profile.actor_checked_at = report.ran_at.slice(0, 10);
      fs.writeFileSync(path.join(DIR, `${profile.id}.json`), `${JSON.stringify(profile, null, 2)}\n`);
    }

    report.companies.push({
      id: profile.id,
      pages: pages.map((p) => p.url),
      values_confirmed: confirmed,
      values_not_on_pages: missing,
      values_renamed: renamed,
      candidates_not_in_profile: notInProfile,
      sources_added: addedSources,
      file_changed: changed,
    });

    console.log(
      `${profile.name}: ${pages.length} pages, ${confirmed.length}/${profile.values.length} values confirmed, ${addedSources.length} sources added`,
    );
  }

  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  fs.writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`report: ${path.relative(ROOT, REPORT)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
