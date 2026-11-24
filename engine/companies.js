// Company mode. Each file in data/companies/ describes how one company interviews, researched from
// public sources. The panel reads a compact slice of it so the questions, the coding round and the
// verdict follow that company's loop and values instead of a generic one.

import fs from "node:fs";
import path from "node:path";

import { ROOT } from "./config.js";

// The files ship with the code, so this is ROOT and not DATA (DATA is /tmp on the hosted demo).
const DIR = path.join(ROOT, "data", "companies");

// The panel as it was before company mode. Used when no company is picked or the id is unknown.
const GENERAL = {
  id: "general",
  name: "General",
  tagline: "A balanced panel with no company playbook.",
  values: [
    { name: "Ownership", meaning: "Owns outcomes and says what they personally did." },
    { name: "Technical depth", meaning: "Explains how things work and the tradeoffs behind choices." },
    { name: "Evidence", meaning: "Backs claims with numbers and checkable detail." },
  ],
  loop: [],
  behavioral_themes: [],
  coding_style: "",
  rubric: [],
  question_themes: [],
  panel_flavor: {},
  sources: [],
};

// The order the picker shows them in. Files not listed here still load and go last.
const ORDER = ["google", "amazon", "meta", "stripe", "ramp"];

let cache = null;

function loadAll() {
  if (cache) {
    return cache;
  }

  const byId = new Map([[GENERAL.id, GENERAL]]);
  let files = [];
  try {
    files = fs.readdirSync(DIR).filter((f) => f.endsWith(".json"));
  } catch {
    // No data folder means general only, which is still a working interview.
  }

  for (const file of files) {
    try {
      const company = JSON.parse(fs.readFileSync(path.join(DIR, file), "utf8"));
      if (company && company.id && company.name) {
        byId.set(company.id, company);
      }
    } catch (err) {
      console.error(`skipping data/companies/${file}: ${err.message}`);
    }
  }

  const rank = (id) => {
    const i = ORDER.indexOf(id);
    if (i === -1) {
      return ORDER.length;
    }
    return i;
  };
  const rest = [...byId.values()].filter((c) => c.id !== GENERAL.id);
  rest.sort((a, b) => rank(a.id) - rank(b.id));

  cache = { byId, list: [...rest, GENERAL] };
  return cache;
}

// A company the research route just built. It goes straight into the cache so the next
// interview can use it, even on the hosted demo where the file can't be written.
export function registerCompany(company) {
  // Reload first, so a file written by another process shows up too.
  cache = null;
  const { byId } = loadAll();
  byId.set(company.id, company);

  const rest = cache.list.filter((c) => c.id !== company.id && c.id !== GENERAL.id);
  cache.list = [...rest, company, GENERAL];
}

export function getCompany(id) {
  const { byId } = loadAll();
  return byId.get(String(id || "").toLowerCase()) || GENERAL;
}

// What the start screen needs to draw the picker.
export function listCompanies() {
  return loadAll().list.map((c) => {
    return {
      id: c.id,
      name: c.name,
      tagline: c.tagline,
      values: (c.values || []).map((v) => v.name),
    };
  });
}

function isGeneral(company) {
  return !company || company.id === GENERAL.id;
}

function valueLines(company, max) {
  return (company.values || [])
    .slice(0, max)
    .map((v) => `${v.name}: ${v.meaning}`)
    .join("\n");
}

// Each prompt gets only the slice it uses, to keep the token cost down.
// part is one of "panel", "problem", "verdict" or "chat".
export function companyBlock(company, part) {
  // The verdict always rates values, so a general interview rates the general ones.
  if (part === "verdict") {
    return verdictBlock(company || GENERAL);
  }
  if (isGeneral(company)) {
    return "";
  }

  const flavor = company.panel_flavor || {};
  const rubric = (company.rubric || []).join("; ");

  if (part === "panel") {
    const loop = (company.loop || []).map((r) => `${r.round} (${r.focus})`).join("; ");
    const flavorLines = ["manager", "tech", "skeptic"]
      .filter((id) => flavor[id])
      .map((id) => `${id}: ${flavor[id]}`)
      .join("\n");
    return `COMPANY MODE: interview the way ${company.name} does.
Values to probe (name them in whispers when an answer shows or misses one):
${valueLines(company, 8)}
Their loop: ${loop}
Behavioral themes: ${(company.behavioral_themes || []).join("; ")}
Question themes to draw from (paraphrase, never read verbatim): ${(company.question_themes || []).join("; ")}
Rubric terms: ${rubric}
How each interviewer adapts:
${flavorLines}`;
  }

  if (part === "problem") {
    return `Write it the way ${company.name} runs coding interviews: ${company.coding_style}`;
  }

  if (part === "chat") {
    const tech = flavor.tech ? ` ${flavor.tech}` : "";
    return `This is a ${company.name} style coding round: ${company.coding_style}${tech}`;
  }

  return "";
}

// Amazon calls its values Leadership Principles, so a label can be "Ownership (Amazon LP)".
function verdictBlock(company) {
  const names = (company.values || []).map((v) => v.name).join(", ");
  const label = company.value_label || company.name;
  const rubric = (company.rubric || []).join("; ");
  const skeptic = company.panel_flavor && company.panel_flavor.skeptic ? `\n${company.panel_flavor.skeptic}` : "";

  let intro = "This was a general interview with no company playbook.";
  if (!isGeneral(company)) {
    intro = `This interview was for ${company.name}. Judge against their values and rubric: ${rubric}.`;
  }

  const first = (company.values || [])[0];
  const example = `${first ? first.name : "Ownership"} (${label})`;

  return `${intro}
In values, rate each of these: ${names}. Label each like "${example}", give a signal and an exact candidate quote as evidence; use signal not_seen with an empty quote when no answer showed it.${skeptic}`;
}
