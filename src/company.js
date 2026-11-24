// Company mode on the start screen: pick which company's interview the panel runs.
// Names are plain text only, no logos or brand colors, so the cards all look the same.

import "./company.css";
import { mountAddCompany } from "./company-add.js";

const STORAGE_KEY = "hotseat_company";

let companies = [];
let selected = readSaved();

// Storage can throw in private windows; the picker still works, it just forgets.
function readSaved() {
  try {
    return localStorage.getItem(STORAGE_KEY) || "general";
  } catch {
    return "general";
  }
}

function save(id) {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Nothing to do; the choice still holds for this visit.
  }
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

// The start card may come with a slot for the picker. Without one it goes right after the role field.
function pickerHost() {
  const slot = document.getElementById("companySlot");
  if (slot) {
    return slot;
  }

  let host = document.getElementById("companyPicker");
  if (host) {
    return host;
  }
  host = document.createElement("div");
  host.id = "companyPicker";
  const role = document.getElementById("role");
  const anchor = role ? role.closest("label") || role : null;
  if (anchor) {
    anchor.after(host);
  } else {
    document.getElementById("intro")?.append(host);
  }
  return host;
}

function render() {
  const host = pickerHost();
  const cards = companies
    .map((c) => {
      const on = c.id === selected;
      const chips = (c.values || [])
        .slice(0, 3)
        .map((v) => `<span class="cchip">${esc(v)}</span>`)
        .join("");
      return `<button type="button" class="ccard${on ? " on" : ""}" role="radio" aria-checked="${on}" data-id="${esc(c.id)}">
        <span class="cname">${esc(c.name)}</span>
        <span class="ctag">${esc(c.tagline)}</span>
        <span class="cchips">${chips}</span>
      </button>`;
    })
    .join("");

  host.innerHTML = `<div class="clabel">Interview the way this company does</div>
    <div class="cgrid" role="radiogroup" aria-label="Company">${cards}</div>`;

  for (const card of host.querySelectorAll(".ccard")) {
    card.addEventListener("click", () => {
      selected = card.dataset.id;
      save(selected);
      render();
    });
  }
}

export async function initCompanyPicker() {
  try {
    const r = await fetch("/api/companies");
    const j = await r.json();
    companies = j.companies || [];
  } catch {
    // An older server without company mode: leave the picker out and run the general panel.
    companies = [];
  }
  if (companies.length === 0) {
    return;
  }

  // A saved company that no longer exists falls back to general.
  if (!companies.some((c) => c.id === selected)) {
    selected = "general";
  }
  render();
  mountAddCompany(pickerHost(), addCompany);
}

// A company the research route just built: list it before General and pick it.
function addCompany(company) {
  const card = {
    id: company.id,
    name: company.name,
    tagline: company.tagline,
    values: (company.values || []).map((v) => v.name),
  };
  const general = companies.filter((c) => c.id === "general");
  const rest = companies.filter((c) => c.id !== "general" && c.id !== card.id);
  companies = [...rest, card, ...general];
  selected = card.id;
  save(selected);
  render();
}

export function selectedCompany() {
  return selected;
}

function companyName(id) {
  const found = companies.find((c) => c.id === id);
  if (found) {
    return found.name;
  }
  return "General";
}

// "Software Engineer Intern" is long for the HUD, so the common words get shortened.
function shortRole(role) {
  return String(role || "")
    .replace(/software engineering/i, "SWE")
    .replace(/software engineer/i, "SWE")
    .trim();
}

export function showCompanyInHud(role) {
  const hud = document.getElementById("hud");
  if (!hud) {
    return;
  }

  let label = document.getElementById("hudCompany");
  if (!label) {
    label = document.createElement("div");
    label.id = "hudCompany";
    const brand = hud.querySelector(".brand");
    if (brand) {
      brand.after(label);
    } else {
      hud.prepend(label);
    }
  }

  const name = companyName(selected);
  const where = selected === "general" ? "General interview" : `Interviewing for ${name}`;
  const what = shortRole(role);
  label.textContent = what ? `${where} · ${what}` : where;
}

const SIGNAL_LABEL = { strong: "Strong", mixed: "Mixed", weak: "Weak", not_seen: "Not seen" };

// The verdict's value ratings as list items, for the score card's "Values" section.
export function valuesHtml(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return "";
  }

  const items = values
    .map((v) => {
      const signal = SIGNAL_LABEL[v.signal] ? v.signal : "not_seen";
      const quote = v.evidence_quote ? `<q>${esc(v.evidence_quote)}</q>` : "";
      return `<li><b>${esc(v.value)}</b> <span class="vsignal ${signal}">${SIGNAL_LABEL[signal]}</span>${quote}</li>`;
    })
    .join("");
  return `<ul class="cvalues">${items}</ul>`;
}
