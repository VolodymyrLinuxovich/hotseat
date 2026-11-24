// "+ Add company" under the company picker. It asks the server to research a company with the
// Apify Actor and Claude, which takes a minute or so, then hands the new profile to the picker.

function el(tag, attrs, text) {
  const node = document.createElement(tag);
  Object.assign(node, attrs);
  if (text) {
    node.textContent = text;
  }
  return node;
}

export function mountAddCompany(pickerHost, onAdded) {
  if (!pickerHost || document.getElementById("companyAdd")) {
    return;
  }

  // Its own element after the picker, because the picker redraws its whole host on every click.
  const box = el("div", { id: "companyAdd", className: "cadd" });
  const open = el("button", { type: "button", className: "caddopen" }, "+ Add company");
  const form = el("form", { className: "caddform", hidden: true });
  const name = el("input", { type: "text", placeholder: "Company name", required: true, maxLength: 60 });
  const url = el("input", { type: "url", placeholder: "Careers URL (optional)" });
  const go = el("button", { type: "submit" }, "Research");
  const status = el("div", { className: "caddstatus", role: "status" });

  form.append(name, url, go);
  box.append(open, form, status);
  pickerHost.after(box);

  open.addEventListener("click", () => {
    form.hidden = false;
    open.hidden = true;
    name.focus();
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const company = name.value.trim();
    if (!company) {
      return;
    }

    go.disabled = true;
    status.textContent = `Researching ${company}… (Apify Actor)`;
    try {
      const r = await fetch("/api/companies/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: company, url: url.value.trim() || undefined }),
      });
      const j = await r.json();
      if (!r.ok) {
        throw new Error(j.error || `HTTP ${r.status}`);
      }

      onAdded(j.company);
      const pages = j.pages ? ` from ${j.pages} pages` : "";
      status.textContent = `Added ${j.company.name}${pages}.`;
      name.value = "";
      url.value = "";
    } catch (err) {
      status.textContent = `Couldn't research ${company}: ${err.message}`;
    } finally {
      go.disabled = false;
    }
  });
}
