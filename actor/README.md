# Hotseat company research

An Apify Actor that collects what a company says about how it hires. Hotseat turns the result
into a company profile for its interview panel (values, interview loop, coding style, rubric).

## Input

```json
{
  "companies": [{ "name": "Stripe" }, { "name": "Figma", "urls": ["https://www.figma.com/careers/"] }],
  "maxPagesPerCompany": 6
}
```

- Google, Amazon, Meta, Stripe and Ramp start from curated official pages (`src/curated.js`):
  how we hire, interview prep, leadership principles and values pages.
- Any other company starts from the `urls` you give, or from `<name>.com/careers`, `/jobs`,
  `/about`, `/about/values`, `/values` and `/culture` when there are none.
- From there it follows same-site links whose text or path mentions interviews, hiring,
  values, principles, culture or early careers, up to two clicks deep.

## Output

One dataset item per useful page:

```json
{
  "company": "Amazon",
  "url": "https://atoz.amazon/en-us/discover/leadership-principles",
  "title": "Leadership Principles",
  "headings": ["Leadership Principles", "Customer Obsession", "..."],
  "values_candidates": ["Customer Obsession", "Ownership", "..."],
  "interview_text": "Cleaned text of the interview-related sections, up to 4000 characters",
  "fetched_at": "2026-11-23T22:10:00.000Z"
}
```

Pages with neither values nor interview text are dropped.

## How it crawls

- CheerioCrawler first, at most 40 requests a minute, robots.txt respected.
- Google embeds its careers text as escaped HTML inside a script; that is decoded without a browser.
- Pages that still come back nearly empty are fetched once more with PlaywrightCrawler.
- Apify Proxy on the platform, direct connections locally.

## Run locally

```bash
npm install
mkdir -p storage/key_value_stores/default
echo '{"companies":[{"name":"Ramp"}]}' > storage/key_value_stores/default/INPUT.json
npm start
```

Results land in `storage/datasets/default/`.

## Limits

- `values_candidates` is a heuristic: list items and subheadings under a heading that names
  values or principles. It can include stray lines, so treat it as candidates, not a list.
- The domain guess for a new company is `<name>.com`. Pass a careers URL when that is wrong.
- Sites that block automated traffic or need a login give nothing.
