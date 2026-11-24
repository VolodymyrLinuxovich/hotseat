// Turns one HTML page into the dataset item: headings, the list under any values or principles
// heading, and the text of the interview-related sections. Works on a cheerio document so the
// plain HTTP crawler and the browser crawler share it.

export const INTERVIEW_WORDS =
  /interview|hiring|how we hire|hire|recruit|assessment|onsite|on-site|loop|prepar|what to expect|coding|technical|behavioral|candidate/i;

// "Culture" alone is left out: culture sections are mostly perks and podcasts, not a values list.
export const VALUES_WORDS = /\bvalues\b|principles|what we look for|tenets|what we believe/i;

// Link text or paths worth following when discovering a company's own pages.
export const LINK_WORDS =
  /interview|hiring|how-we-hire|how we hire|values|principles|culture|leadership|life at|life-at|how we work|how-we-work|candidate|students|university|early career|emerging/i;

const MAX_INTERVIEW_CHARS = 4000;
const MAX_VALUES = 30;
const MAX_HEADINGS = 40;

// A values list is short. Past this many items the "section" is really the rest of the page.
const MAX_PER_SECTION = 16;

function clean(text) {
  return String(text || "")
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function headingLevel(tag) {
  return Number(tag.slice(1));
}

export function extractPage($, url) {
  // Page chrome repeats on every page and would drown the real content.
  $("script, style, noscript, svg, iframe, nav, footer, header, form, [role=navigation], [aria-hidden=true]").remove();

  // cheerio's text() glues sibling elements together ("CompatibilityWorking"), so give every
  // element a trailing space first.
  $("body *").append(" ");

  let root = $("main").first();
  if (root.length === 0) {
    root = $("[role=main]").first();
  }
  if (root.length === 0) {
    root = $("article").first();
  }
  if (root.length === 0) {
    root = $("body");
  }

  const title = clean($("title").first().text()) || clean(root.find("h1").first().text());

  const headings = [];
  const valuesCandidates = [];
  const interviewParts = [];
  const allParts = [];

  // Which section we are in: the level of the heading that opened a values or interview section,
  // so a sibling heading at the same level or higher closes it again.
  let valuesLevel = 0;
  let interviewLevel = 0;
  let inSection = 0;

  function addValue(text) {
    if (inSection >= MAX_PER_SECTION) {
      valuesLevel = 0;
      return;
    }
    inSection += 1;
    valuesCandidates.push(text);
  }

  root.find("h1, h2, h3, h4, p, li").each((_, el) => {
    const tag = el.tagName.toLowerCase();
    const text = clean($(el).text());
    if (!text) {
      return;
    }

    if (tag.startsWith("h")) {
      const level = headingLevel(tag);

      if (valuesLevel && level <= valuesLevel) {
        valuesLevel = 0;
      }
      if (interviewLevel && level <= interviewLevel) {
        interviewLevel = 0;
      }

      if (headings.length < MAX_HEADINGS && text.length <= 160 && !headings.includes(text)) {
        headings.push(text);
      }

      // Amazon lists each principle as its own subheading, so subheadings count as candidates too.
      if (valuesLevel && level > valuesLevel) {
        addValue(text);
      } else if (VALUES_WORDS.test(text)) {
        valuesLevel = level;
        inSection = 0;
      }

      if (!interviewLevel && INTERVIEW_WORDS.test(text)) {
        interviewLevel = level;
      }
      if (interviewLevel) {
        interviewParts.push(text);
      }
      return;
    }

    // A paragraph inside a list item is already counted with the item.
    if (tag === "p" && $(el).parents("li").length > 0) {
      return;
    }

    allParts.push(text);
    if (interviewLevel) {
      interviewParts.push(text);
    }

    // Some sites (Meta's) style their headings as short paragraphs. A short line that names
    // values opens a section that any real heading closes, and the short lines after it,
    // like "Move fast", are the values themselves.
    const short = text.length <= 80 && !/[.?!:]$/.test(text);
    if (tag === "p" && short && VALUES_WORDS.test(text)) {
      valuesLevel = 5;
      inSection = 0;
      return;
    }

    if (valuesLevel === 5 && tag === "p" && short) {
      addValue(text);
    } else if (valuesLevel && valuesLevel < 5 && tag === "li" && text.length <= 160) {
      addValue(text);
    }
  });

  // A page about interviewing often has no interview heading at all; then the whole page counts.
  let interviewSource = interviewParts;
  if (interviewSource.length === 0 && (INTERVIEW_WORDS.test(title) || INTERVIEW_WORDS.test(url))) {
    interviewSource = allParts;
  }

  const seen = new Set();
  const interviewText = interviewSource
    .filter((t) => {
      if (seen.has(t)) {
        return false;
      }
      seen.add(t);
      return true;
    })
    .join("\n")
    .slice(0, MAX_INTERVIEW_CHARS);

  const values = [...new Set(valuesCandidates.map((v) => v.slice(0, 200)))].slice(0, MAX_VALUES);

  return {
    url,
    title,
    headings,
    values_candidates: values,
    interview_text: interviewText,
    words: allParts.join(" ").split(/\s+/).filter(Boolean).length,
  };
}

// Same-site links whose text or path suggests hiring, interviews or values.
export function relevantLinks($, pageUrl, allowedDomains) {
  const out = [];
  $("a[href]").each((_, a) => {
    const href = $(a).attr("href");
    let url;
    try {
      url = new URL(href, pageUrl);
    } catch {
      return;
    }
    if (!/^https?:$/.test(url.protocol)) {
      return;
    }
    if (!allowedDomains.has(baseDomain(url.hostname))) {
      return;
    }
    // Single job postings and files are not about how the company hires.
    if (/\/(job|jobs|position|positions)\/[^/]*\d{4,}|\.(pdf|zip|png|jpe?g)$/i.test(url.pathname)) {
      return;
    }

    const text = clean($(a).text());
    if (LINK_WORDS.test(text) || LINK_WORDS.test(url.pathname.replace(/[-_/]/g, " "))) {
      url.hash = "";
      out.push(url.href);
    }
  });
  return [...new Set(out)];
}

// "careers.stripe.com" and "stripe.com" are the same site. This ignores two-part suffixes like
// co.uk, which is fine for the company sites this runs on.
export function baseDomain(hostname) {
  return hostname.toLowerCase().split(".").slice(-2).join(".");
}

// Google's careers pages ship their text as an escaped HTML string inside a script and draw it
// later, so neither the plain HTML nor a quick headless render shows it. Decoding the strings
// that contain markup gets the same text without a browser. Call this before extractPage,
// which removes the scripts.
export function embeddedHtml($) {
  const parts = [];
  $("script").each((_, s) => {
    const code = $(s).text();
    if (!code.includes("\\u003c")) {
      return;
    }
    for (const m of code.matchAll(/"((?:[^"\\]|\\.)*?\\u003c(?:[^"\\]|\\.)*?)"/g)) {
      try {
        parts.push(JSON.parse(`"${m[1]}"`));
      } catch {
        // Not a plain JSON string; skip it.
      }
    }
  });

  // Short fragments are button labels and template bits, not page content.
  const big = parts.filter((p) => p.length > 2000);
  if (big.length === 0) {
    return "";
  }
  return `<html><head><title></title></head><body><main>${big.join("\n")}</main></body></html>`;
}
