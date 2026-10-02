// Tour Core secure setup, on the Tour Core computer only. Provider
// credentials typed here go straight to Tour Core's secret store. They're
// never shown again, never sent to Grok, and this page can't read them back.
// The session comes from the link's #fragment (never sent to the server as
// part of the URL) and is kept only for this tab.

const root = document.getElementById("install");
const params = new URLSearchParams(location.hash.slice(1));
if (params.get("s")) sessionStorage.setItem("tourcore-setup-session", params.get("s"));
if (params.get("c")) sessionStorage.setItem("tourcore-setup-csrf", params.get("c"));
const focus = params.get("step");
if (location.hash) history.replaceState(null, "", location.pathname);
const session = sessionStorage.getItem("tourcore-setup-session") || "";
const csrf = sessionStorage.getItem("tourcore-setup-csrf") || "";

function h(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== false) node.setAttribute(k, v === true ? "" : v);
  }
  node.append(...kids.filter(Boolean));
  return node;
}

async function api(method, path, body) {
  const res = await fetch(`/api/install/${path}`, {
    method,
    cache: "no-store",
    headers: { "X-TourCore-Setup-Session": session, ...(csrf ? { "X-TourCore-Csrf": csrf } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

const STATE_MARK = { READY: ["ok", "\u2713"], ERROR: ["bad", "\u2717"], DEGRADED: ["bad", "!"] };

function statusCard(data) {
  const list = h("ul", { class: "checks" });
  for (const c of data.components) {
    const [cls, mark] = STATE_MARK[c.state] ?? ["info", "\u2022"];
    list.append(h("li", {}, h("div", { class: "check-line" }, h("span", { class: `mark ${cls}`, text: mark }), h("div", {}, h("strong", { text: c.label }), h("span", { class: "hint", text: c.summary })))));
  }
  return h("section", { class: "card" }, h("h2", { text: "Installation" }), h("p", { class: "muted", text: data.summary }), list);
}

function resultBox(out) {
  if (!out) return null;
  const box = h("div", { class: out.ok ? "success" : "issues" }, h("p", { text: out.message || (out.ok ? "Saved." : "That didn't work.") }));
  for (const c of out.checks ?? []) box.append(h("p", { class: "hint", text: `${c.ok ? "\u2713" : "\u2717"} ${c.message}` }));
  if (out.incomingMessages) box.append(h("p", { class: "hint", text: out.incomingMessages }));
  return box;
}

function secretInput(id, label, hint, isSet) {
  return [
    h("label", { for: id }, label, h("span", { class: "hint", text: isSet ? `${hint} Already saved; leave blank to keep it.` : hint })),
    h("input", { id, name: id, type: "password", autocomplete: "off", spellcheck: "false", required: !isSet }),
  ];
}

function messagingCard(settings, last) {
  const s = settings.visitorMessaging;
  const fields = s.fields ?? [];
  const form = h(
    "form",
    {
      onsubmit: async (e) => {
        e.preventDefault();
        const f = new FormData(form);
        const values = {};
        for (const field of fields) {
          const raw = f.get(field.name);
          if (raw) values[field.name] = raw;
        }
        const line = f.get("line");
        busy(form, true);
        const out = await api("POST", "visitor-messaging", { values, ...(line ? { line } : {}) });
        form.reset();
        render({ messaging: out.data.error ? { ok: false, message: out.data.error.message } : out.data });
      },
    },
    ...fields.flatMap((field) =>
      field.secret
        ? secretInput(field.name, field.label, field.hint, field.set)
        : [
            h("label", { for: field.name }, field.label, h("span", { class: "hint", text: field.hint })),
            h("input", { id: field.name, name: field.name, type: "text", inputmode: field.name.includes("NUMBER") ? "tel" : "text", autocomplete: "off", placeholder: field.value || "+1", required: field.required && !field.set }),
          ],
    ),
    ...(s.lines?.length > 1
      ? [
          h("label", { for: "line" }, "Messaging line", h("span", { class: "hint", text: "Choose one of the lines this Photon project already has." })),
          h("select", { id: "line", name: "line", required: true }, ...s.lines.map((line) => h("option", { value: line.address, text: `${line.address}${line.status ? ` (${line.status})` : ""}` }))),
        ]
      : []),
    fields.length ? h("div", { class: "actions" }, h("button", { type: "submit", class: "primary" }, "Save and connect")) : null,
  );
  return h(
    "section",
    { class: `card${focus === "visitor-messaging" ? " highlight" : ""}`, id: "visitor-messaging" },
    h("h2", { text: s.title || "Visitor texting" }),
    h("p", { class: "muted", text: s.intro || "Tour Core checks the account and protects incoming messages. Nothing is texted." }),
    resultBox(last),
    fields.length ? form : h("p", { text: "Choose how prospects will text Tour Core in chat first. This page then asks only for that provider's details." }),
    fields.some((field) => field.set) ? h("button", { type: "button", class: "link", onclick: async () => render({ messaging: (await api("POST", "visitor-messaging/test")).data }) }, "Check again") : null,
  );
}

function alertsCard(settings, last) {
  const s = settings.operatorAlerts;
  const done = (out) => render({ alerts: out.data.error ? { ok: false, message: out.data.error.message } : out.data });
  const form = h(
    "form",
    {
      onsubmit: async (e) => {
        e.preventDefault();
        const f = new FormData(form);
        busy(form, true);
        const out = await api("POST", "operator-alerts", { webhookUrl: f.get("webhookUrl"), key: f.get("key") });
        form.reset();
        done(out);
      },
    },
    h("label", { for: "webhookUrl" }, "Routine webhook address", h("span", { class: "hint", text: s.webhookUrl ? "Already saved. Enter both values again to replace them." : "From the Tour Core Operator Updates routine's webhook trigger in Grok." })),
    h("input", { id: "webhookUrl", name: "webhookUrl", type: "password", autocomplete: "off", spellcheck: "false", required: true }),
    ...secretInput("key", "Routine key", "The routine's sender (bearer) key. Use a newly rotated one.", false),
    h("div", { class: "actions" }, h("button", { type: "submit", class: "primary" }, "Save and send a test update")),
  );
  // One paste instead of two: the routine panel's whole webhook example. Masked like the fields above.
  const paste = h(
    "form",
    {
      onsubmit: async (e) => {
        e.preventDefault();
        const f = new FormData(paste);
        busy(paste, true);
        const out = await api("POST", "operator-alerts", { snippet: f.get("snippet") });
        paste.reset();
        done(out);
      },
    },
    h("label", { for: "snippet" }, "Or paste the routine's whole webhook example", h("span", { class: "hint", text: "Copy the example the routine shows for its webhook (it has the address and the key) and paste it here. Tour Core picks out the two values." })),
    h("textarea", { id: "snippet", name: "snippet", rows: "3", autocomplete: "off", spellcheck: "false", required: true, style: "-webkit-text-security: disc; font-family: monospace" }),
    h("div", { class: "actions" }, h("button", { type: "submit" }, "Save from paste and send a test update")),
  );
  return h(
    "section",
    { class: `card${focus === "operator-alerts" ? " highlight" : ""}`, id: "operator-alerts" },
    h("h2", { text: "Tour updates (Grok Routine)" }),
    h("p", { class: "muted", text: "When a tour is booked, starts or finishes, or a visitor needs a person, Tour Core wakes the routine with only a reference. Grok then reads the details from Tour Core and tells you." }),
    resultBox(last),
    form,
    paste,
    s.webhookUrl && s.key ? h("button", { type: "button", class: "link", onclick: async () => render({ alerts: (await api("POST", "operator-alerts/test")).data }) }, "Send another test update") : null,
  );
}

function busy(form, on) {
  for (const el of form.querySelectorAll("button, input")) el.disabled = on;
}

async function render(last = {}) {
  if (!session) {
    root.replaceChildren(h("h1", { text: "Secure setup" }), h("p", { text: "This page needs a secure setup link. Ask Grok for one (it opens here), or run npm run install:link on this computer." }));
    return;
  }
  const { status, data } = await api("GET", "status");
  if (status !== 200) {
    root.replaceChildren(h("h1", { text: "Secure setup" }), h("p", { class: "form-error", text: data.error?.message ?? "This link can't be used." }));
    return;
  }
  const expires = new Date(data.session.expiresAt).toLocaleTimeString([], { timeStyle: "short" });
  root.replaceChildren(
    h("h1", { text: "Secure setup" }),
    h("p", { class: "lead", text: "Enter provider details here, not in chat. They go straight to Tour Core and are never shown again, not even to Grok." }),
    h("p", { class: "hint", text: `This link works only in this computer's browser and expires at ${expires}.` }),
    focus !== "operator-alerts" ? messagingCard(data.settings, last.messaging) : null,
    focus !== "visitor-messaging" && (data.sections?.operatorAlerts || focus === "operator-alerts") ? alertsCard(data.settings, last.alerts) : null,
    focus ? h("button", { type: "button", class: "link", onclick: () => ((location.hash = ""), location.reload()) }, "Show all settings") : null,
    statusCard(data),
    h("p", { class: "muted", text: "When you're done, go back to Grok and say \"done\". Grok will check the installation again." }),
  );
  document.getElementById(focus ?? "")?.scrollIntoView({ block: "start" });
}

render().catch(() => root.replaceChildren(h("p", { text: "Couldn't load. Is Tour Core still running?" })));
