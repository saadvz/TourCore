// Tour Core secure setup, on the Tour Core computer only. Provider
// credentials typed here go straight to Tour Core's secret store. They're
// never shown again, never sent to Grok, and this page can't read them back.
// The session comes from the link's #fragment (never sent to the server as
// part of the URL) and is kept only for this tab.

const root = document.getElementById("install");
const params = new URLSearchParams(location.hash.slice(1));
if (params.get("s")) sessionStorage.setItem("tourcore-setup-session", params.get("s"));
const focus = params.get("step");
if (location.hash) history.replaceState(null, "", location.pathname);
const session = sessionStorage.getItem("tourcore-setup-session") || "";

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
    headers: { "X-TourCore-Setup-Session": session, ...(body ? { "Content-Type": "application/json" } : {}) },
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
  const form = h(
    "form",
    {
      onsubmit: async (e) => {
        e.preventDefault();
        const f = new FormData(form);
        busy(form, true);
        const out = await api("POST", "visitor-messaging", { apiKey: f.get("apiKey") || undefined, apiSecret: f.get("apiSecret") || undefined, fromNumber: f.get("fromNumber") || undefined });
        form.reset();
        render({ messaging: out.data.error ? { ok: false, message: out.data.error.message } : out.data });
      },
    },
    ...secretInput("apiKey", "Sendblue API key", "From the Sendblue dashboard, under API keys.", s.apiKey),
    ...secretInput("apiSecret", "Sendblue API secret", "Shown once when the key is created.", s.apiSecret),
    h("label", { for: "fromNumber" }, "Texting number", h("span", { class: "hint", text: "The Sendblue number visitors will text, like +15551234567." })),
    h("input", { id: "fromNumber", name: "fromNumber", type: "text", inputmode: "tel", autocomplete: "off", placeholder: s.fromNumber || "+1", required: !s.fromNumber }),
    h("div", { class: "actions" }, h("button", { type: "submit", class: "primary" }, "Save and connect")),
  );
  return h(
    "section",
    { class: `card${focus === "visitor-messaging" ? " highlight" : ""}`, id: "visitor-messaging" },
    h("h2", { text: "Visitor texting (Sendblue)" }),
    h("p", { class: "muted", text: "Tour Core checks the account and number, protects incoming messages with a secret, and tells Sendblue where to send visitor replies. Nothing is texted." }),
    resultBox(last),
    form,
    s.apiKey && s.apiSecret ? h("button", { type: "button", class: "link", onclick: async () => render({ messaging: (await api("POST", "visitor-messaging/test")).data }) }, "Check again") : null,
  );
}

function alertsCard(settings, last) {
  const s = settings.operatorAlerts;
  const form = h(
    "form",
    {
      onsubmit: async (e) => {
        e.preventDefault();
        const f = new FormData(form);
        busy(form, true);
        const out = await api("POST", "operator-alerts", { webhookUrl: f.get("webhookUrl"), key: f.get("key") });
        form.reset();
        render({ alerts: out.data.error ? { ok: false, message: out.data.error.message } : out.data });
      },
    },
    h("label", { for: "webhookUrl" }, "Routine webhook address", h("span", { class: "hint", text: s.webhookUrl ? "Already saved. Enter both values again to replace them." : "From the Tour Core Exception Alert routine's webhook trigger in Grok." })),
    h("input", { id: "webhookUrl", name: "webhookUrl", type: "password", autocomplete: "off", spellcheck: "false", required: true }),
    ...secretInput("key", "Routine key", "The routine's sender (bearer) key. Use a newly rotated one.", false),
    h("div", { class: "actions" }, h("button", { type: "submit", class: "primary" }, "Save and send a test alert")),
  );
  return h(
    "section",
    { class: `card${focus === "operator-alerts" ? " highlight" : ""}`, id: "operator-alerts" },
    h("h2", { text: "Operator alerts (Grok Routine)" }),
    h("p", { class: "muted", text: "When a visitor needs a person, Tour Core wakes the routine with only an issue reference. Grok then reads the details from Tour Core and tells you." }),
    resultBox(last),
    form,
    s.webhookUrl && s.key ? h("button", { type: "button", class: "link", onclick: async () => render({ alerts: (await api("POST", "operator-alerts/test")).data }) }, "Send another test alert") : null,
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
