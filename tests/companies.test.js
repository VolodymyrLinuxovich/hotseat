import assert from "node:assert/strict";
import { test } from "node:test";

import { checkVerdict } from "../engine/checks.js";
import { companyBlock, getCompany, listCompanies } from "../engine/companies.js";

test("lists the five researched companies with general last", () => {
  const list = listCompanies();
  const ids = list.map((c) => c.id);

  assert.equal(ids[ids.length - 1], "general");
  assert.equal(list.length, 6);
  for (const c of list) {
    assert.ok(c.name);
    assert.ok(c.tagline);
    assert.ok(c.values.length >= 3, `${c.id} needs at least 3 values for the chips`);
  }
});

test("unknown company falls back to general", () => {
  assert.equal(getCompany("nope").id, "general");
  assert.equal(getCompany(undefined).id, "general");
});

test("general adds nothing to the panel prompt but still rates values", () => {
  const general = getCompany("general");

  assert.equal(companyBlock(general, "panel"), "");
  assert.equal(companyBlock(general, "problem"), "");
  assert.match(companyBlock(general, "verdict"), /Ownership/);
});

test("every company file has what the prompts read", () => {
  for (const { id } of listCompanies()) {
    if (id === "general") {
      continue;
    }
    const c = getCompany(id);

    assert.ok(c.coding_style, `${id} coding_style`);
    assert.ok(c.loop.length > 0, `${id} loop`);
    assert.ok(c.rubric.length > 0, `${id} rubric`);
    assert.ok(c.question_themes.length >= 6, `${id} question_themes`);
    assert.ok(c.panel_flavor.manager && c.panel_flavor.tech && c.panel_flavor.skeptic, `${id} panel_flavor`);
    assert.ok(c.sources.length > 0, `${id} sources`);
    assert.match(companyBlock(c, "panel"), new RegExp(c.name));
  }
});

test("the panel block stays compact to keep the token cost down", () => {
  for (const { id } of listCompanies()) {
    const words = companyBlock(getCompany(id), "panel").split(/\s+/).length;
    assert.ok(words < 700, `${id} panel block is ${words} words`);
  }
});

test("value ratings in the verdict quote only what the candidate said", () => {
  const answered = [{ answer: "I owned the migration and cut deploy time from 40 to 12 minutes." }];
  const verdict = {
    votes: [],
    verdict: "lean_hire",
    overall: 3.5,
    strengths: [],
    growth: [],
    values: [
      { value: "Ownership (Amazon LP)", signal: "strong", evidence_quote: "I owned the migration" },
      { value: "Frugality (Amazon LP)", signal: "weak", evidence_quote: "I saved the team a million dollars" },
      { value: "Earn Trust (Amazon LP)", signal: "not_seen", evidence_quote: "something" },
    ],
    summary: "",
    spoken_verdict: "Thanks.",
  };

  const { verdict: out } = checkVerdict(verdict, answered);

  assert.equal(out.values[0].evidence_quote, "I owned the migration");
  assert.notEqual(out.values[1].evidence_quote, "I saved the team a million dollars");
  assert.equal(out.values[2].evidence_quote, "");
});
