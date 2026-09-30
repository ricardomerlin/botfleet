// Injected into the active tab on demand. Builds a compact snapshot of the page
// for the bots. Form field VALUES are never read; only labels and types.
(() => {
  const MAX_TEXT = 120000;
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
  const meta = (n) => document.querySelector(`meta[name="${n}"], meta[property="${n}"]`)?.content || "";

  const root = document.querySelector("article, main, [role='main']") || document.body;
  let text = root?.innerText || "";
  if (text.length < 600 && root !== document.body) text = document.body?.innerText || text;
  text = text.replace(/[ \t]+/g, " ").replace(/\n\s*\n\s*\n+/g, "\n\n").trim().slice(0, MAX_TEXT);

  const headings = [...document.querySelectorAll("h1, h2, h3")]
    .map((h) => `${h.tagName.toLowerCase()}: ${clean(h.innerText).slice(0, 200)}`)
    .filter((h) => h.length > 4)
    .slice(0, 50);

  const labelFor = (el) => {
    const byLabel = el.labels?.[0]?.innerText;
    const byAria = el.getAttribute("aria-label") || (el.getAttribute("aria-labelledby") && document.getElementById(el.getAttribute("aria-labelledby"))?.innerText);
    return clean(byLabel || byAria || el.getAttribute("placeholder") || el.getAttribute("title") || "").slice(0, 120);
  };
  const SKIP = new Set(["hidden", "submit", "button", "image", "reset"]);
  const forms = [...document.forms]
    .map((f) => ({
      name: clean(f.getAttribute("aria-label") || f.getAttribute("name") || f.querySelector("legend, h1, h2, h3")?.innerText || "").slice(0, 120),
      fields: [...f.querySelectorAll("input, select, textarea")]
        .filter((el) => !SKIP.has((el.type || "").toLowerCase()) && el.offsetParent !== null)
        .slice(0, 60)
        .map((el) => ({
          label: labelFor(el),
          name: (el.getAttribute("name") || "").slice(0, 80),
          type: el.tagName === "SELECT" ? "select" : el.tagName === "TEXTAREA" ? "textarea" : (el.type || "text").toLowerCase(),
          required: el.required || el.getAttribute("aria-required") === "true",
        })),
    }))
    .filter((f) => f.fields.length)
    .slice(0, 8);

  const prices = [...new Set(text.match(/(?:[$€£¥₹]\s?\d[\d,]*(?:\.\d{2})?|\d[\d,]*(?:\.\d{2})?\s?(?:USD|EUR|GBP))/g) || [])].slice(0, 20);

  const seen = new Set();
  const links = [];
  for (const a of document.querySelectorAll("a[href]")) {
    if (links.length >= 80) break;
    const href = a.href;
    const t = clean(a.innerText || a.getAttribute("aria-label")).slice(0, 80);
    if (!t || t.length < 3 || !/^https?:/.test(href) || seen.has(href)) continue;
    seen.add(href);
    links.push({ text: t, href: href.slice(0, 1500) });
  }

  const signals = [];
  const ogType = meta("og:type");
  if (ogType) signals.push(`og:type=${ogType}`);
  const ld = [...document.querySelectorAll('script[type="application/ld+json"]')].map((s) => s.textContent).join(" ");
  for (const t of ["Product", "Offer", "Recipe", "Article", "NewsArticle", "JobPosting", "Event", "FAQPage", "SoftwareSourceCode"]) {
    if (new RegExp(`"@type"\\s*:\\s*"${t}"`).test(ld)) signals.push(`schema:${t}`);
  }
  if (document.querySelectorAll("pre code, pre").length) signals.push(`code-blocks=${document.querySelectorAll("pre").length}`);
  if (forms.length) signals.push(`forms=${forms.length}`);
  if (/add to cart|checkout|buy now|add to bag/i.test(text.slice(0, 20000))) signals.push("shopping-cta");
  const active = document.activeElement;
  if (active && (active.isContentEditable || active.tagName === "TEXTAREA")) signals.push("user-is-composing");

  return {
    url: location.href,
    title: document.title.slice(0, 400),
    description: (meta("description") || meta("og:description")).slice(0, 1000),
    lang: document.documentElement.lang || undefined,
    siteName: meta("og:site_name") || undefined,
    pageType: signals.join(", ") || undefined,
    selection: clean(String(window.getSelection() || "")).slice(0, 8000) || undefined,
    headings,
    forms,
    prices,
    links,
    text,
  };
})();
