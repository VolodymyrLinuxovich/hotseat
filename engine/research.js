// "Add a company": scrape what a company says about how it hires with the
// hotseat-company-research Apify Actor (../actor), then turn those pages into a company profile
// with one Claude call. The profile has the same shape as the hand-researched files in
// data/companies/, so the panel uses it the same way.
//
// The Actor runs on the Apify platform when APIFY_TOKEN and APIFY_ACTOR are set. Otherwise the
// same crawl code runs in this process with in-memory storage, which needs actor/node_modules.

import fs from "node:fs";
import path from "node:path";

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

import { getCompany, registerCompany } from "./companies.js";
import { HOSTED, MODEL, ROOT } from "./config.js";

const COMPANY_DIR = path.join(ROOT, "data", "companies");

// The page text sent to the model. Enough for a profile, and it keeps the call cheap.
const MAX_PAGE_CHARS = 2500;
const MAX_PROMPT_CHARS = 30000;

const ProfileSchema = z.object({
  tagline: z.string(),
  values: z.array(z.object({ name: z.string(), meaning: z.string() })),
  value_label: z.string(),
  loop: z.array(z.object({ round: z.string(), focus: z.string() })),
  behavioral_themes: z.array(z.string()),
  coding_style: z.string(),
  rubric: z.array(z.string()),
  question_themes: z.array(z.string()),
  panel_flavor: z.object({ manager: z.string(), tech: z.string(), skeptic: z.string() }),
  uncertain: z.array(z.string()),
});

export function companyId(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

// ---------- running the Actor ----------

async function runOnApify(input) {
  const actor = process.env.APIFY_ACTOR.replace("/", "~");
  const url = `https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?timeout=240`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.APIFY_TOKEN}` },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(270_000),
  });
  if (!res.ok) {
    throw new Error(`Apify run failed with HTTP ${res.status}`);
  }
  return res.json();
}

async function runLocally(input) {
  // Imported only when needed: the hosted demo has no actor/node_modules.
  const { Configuration, crawlCompanies } = await import("../actor/src/crawl.js");

  // A fresh in-memory storage per run, so runs don't share a request queue or write to disk.
  const config = new Configuration({ persistStorage: false, purgeOnStart: true });
  const items = [];
  await crawlCompanies(input, {
    config,
    browser: !HOSTED,
    onItem: (item) => {
      items.push(item);
    },
  });
  return items;
}

// Returns { items, via }. Platform first when configured; if it fails the local crawl still
// gives an answer, which matters more than where it ran.
export async function runActor(input) {
  if (process.env.APIFY_TOKEN && process.env.APIFY_ACTOR) {
    try {
      return { items: await runOnApify(input), via: "apify" };
    } catch (err) {
      console.error(`apify run failed, crawling locally: ${err.message}`);
    }
  }
  return { items: await runLocally(input), via: "local" };
}

// ---------- building the profile ----------

const SYSTEM = `You build an interview profile of a company for Hotseat, a mock interview panel with three interviewers:
Maya (manager: behavioral, ownership, impact), Theo (tech: runs the coding round), Sol (skeptic: pushes for proof).

You get pages scraped from the company's own careers site. Base the profile on them.
Where the pages say nothing (often the coding round or the rubric), you may use what is widely known about the company, but end that line with "(uncertain)" and add a short note to uncertain.
Never invent a value name the pages don't support; if the pages list no values, give 3 to 5 plain ones the pages clearly imply and say so in uncertain.

Fields:
- tagline: one line on what their interview feels like, under 90 characters.
- values: 3 to 8, name as the company writes it, meaning in one short sentence.
- value_label: what the company calls its values, like "LP" or "value"; "value" if unsure.
- loop: the interview rounds in order, focus in one short sentence each.
- behavioral_themes: 5 to 8 story prompts this company likes.
- coding_style: two sentences on how the coding round runs and what is graded.
- rubric: 4 to 6 short terms the interviewers grade on.
- question_themes: 6 to 10 short themes for coding or design questions.
- panel_flavor: one sentence per interviewer on how they adapt to this company, using their names.
- uncertain: what the pages did not confirm.
Write plainly, no marketing words, no dashes.`;

function pagesText(items) {
  let total = 0;
  const blocks = [];
  for (const item of items) {
    const parts = [`URL: ${item.url}`, `Title: ${item.title}`];
    if (item.values_candidates.length > 0) {
      parts.push(`Listed under values or principles: ${item.values_candidates.join("; ")}`);
    }
    if (item.interview_text) {
      parts.push(`Text:\n${item.interview_text.slice(0, MAX_PAGE_CHARS)}`);
    }

    const block = parts.join("\n");
    if (total + block.length > MAX_PROMPT_CHARS) {
      break;
    }
    total += block.length;
    blocks.push(block);
  }
  return blocks.join("\n\n---\n\n");
}

// Made on first use, so the refresh script can run the Actor without an Anthropic key.
let client = null;

export async function buildProfile(name, items) {
  if (!client) {
    client = new Anthropic();
  }

  const res = await client.messages.parse({
    model: MODEL,
    max_tokens: 4000,
    system: SYSTEM,
    messages: [{ role: "user", content: `Company: ${name}\n\nPages:\n\n${pagesText(items)}` }],
    output_config: { effort: "low", format: zodOutputFormat(ProfileSchema) },
  });
  if (!res.parsed_output) {
    throw new Error(`model returned no usable profile (${res.stop_reason})`);
  }

  // Sources are the pages the Actor actually fetched, never ones the model names.
  const sources = [];
  for (const item of items) {
    if (!sources.some((s) => s.url === item.url)) {
      sources.push({ title: item.title || item.url, url: item.url });
    }
  }

  return {
    id: companyId(name),
    name,
    ...res.parsed_output,
    sources,
    researched_at: new Date().toISOString().slice(0, 10),
    researched_by: "hotseat-company-research Apify Actor + Claude",
  };
}

function save(profile) {
  try {
    fs.mkdirSync(COMPANY_DIR, { recursive: true });
    fs.writeFileSync(path.join(COMPANY_DIR, `${profile.id}.json`), `${JSON.stringify(profile, null, 2)}\n`);
    return true;
  } catch (err) {
    // The hosted demo's disk is read-only. The profile still works for this server instance.
    console.error(`could not save ${profile.id}: ${err.message}`);
    return false;
  }
}

// The route's whole job. Throws an Error with .status for problems the user can fix.
export async function researchCompany({ name, url } = {}) {
  const clean = String(name || "")
    .trim()
    .slice(0, 60);
  const id = companyId(clean);
  if (!id) {
    throw Object.assign(new Error("a company name is required"), { status: 400 });
  }

  // A company that already has a profile is returned as is: the curated files are better than a
  // fresh scrape, and it saves a Claude call.
  const existing = getCompany(id);
  if (existing.id === id) {
    return { company: existing, via: "existing", pages: 0, saved: true };
  }

  const company = { name: clean };
  if (url) {
    try {
      company.urls = [new URL(String(url)).href];
    } catch {
      throw Object.assign(new Error("that careers URL doesn't look like a URL"), { status: 400 });
    }
  }

  const { items, via } = await runActor({ companies: [company], maxPagesPerCompany: 6 });
  const pages = items.filter((item) => item.company === clean);
  if (pages.length === 0) {
    throw Object.assign(new Error(`couldn't find hiring or values pages for ${clean}; try adding its careers URL`), {
      status: 422,
    });
  }

  const profile = await buildProfile(clean, pages);
  const saved = save(profile);
  registerCompany(profile);
  return { company: profile, via, pages: pages.length, saved };
}
