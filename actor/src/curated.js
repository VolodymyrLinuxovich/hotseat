// Official pages for the companies Hotseat ships with. Only first-party pages go here: careers
// "how we hire" pages, interview prep guides and values or leadership principles pages.
// Third-party interview guides are left out on purpose, since the Actor's job is to confirm what
// the company itself says.

export const CURATED = {
  google: {
    domain: "google.com",
    urls: [
      "https://www.google.com/about/careers/applications/how-we-hire/",
      "https://www.google.com/about/careers/applications/interview-tips/",
      "https://www.google.com/about/careers/applications/students/",
      "https://about.google/philosophy/",
    ],
  },

  amazon: {
    domain: "amazon.jobs",
    urls: [
      "https://atoz.amazon/en-us/discover/leadership-principles",
      "https://atoz.amazon/en-us/jobs/hiring-process",
      "https://atoz.amazon/en-us/jobs/hiring-process/interview-prep/software-development-engineer-ii",
      "https://atoz.amazon/en-us/jobs/hiring-process/online-assessment/university/software-development-engineer",
      "https://www.amazon.jobs/content/en/how-we-hire/interview-loop",
    ],
  },

  meta: {
    domain: "metacareers.com",
    urls: [
      "https://www.metacareers.com/swe-prep-onsite",
      "https://www.metacareers.com/blog/preparing-for-your-software-engineering-interview-at-meta/",
      "https://www.metacareers.com/blog/acing-your-software-engineering-internship-interview-at-meta/",
      "https://www.metacareers.com/facebook-life/",
    ],
  },

  stripe: {
    domain: "stripe.com",
    urls: [
      "https://stripe.com/jobs/culture",
      "https://stripe.com/careers",
      "https://stripe.com/careers/emerging-talent",
    ],
  },

  ramp: {
    domain: "ramp.com",
    urls: ["https://ramp.com/careers", "https://builders.ramp.com/"],
  },
};

export function slugOf(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
