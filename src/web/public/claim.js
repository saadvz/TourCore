// Hosted owner claim. The bootstrap secret is typed into the form and posted
// in the body. It is never put in the URL. A fragment code is only the
// optional developer fallback, and it is removed from the address bar before
// the request.

const root = document.getElementById("claim");
const requestId = new URLSearchParams(location.search).get("request") || "";
const fragmentCode = new URLSearchParams(location.hash.slice(1)).get("c") || "";
if (location.hash) history.replaceState(null, "", location.pathname + location.search);

const CLAIMED = "This Tour Core installation has been claimed.";

function h(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "text") node.textContent = v;
    else node.setAttribute(k, v);
  }
  node.append(...kids.filter(Boolean));
  return node;
}

function show(text, extra) {
  const body = h("div", { class: "phone-body" }, h("h1", { text: "Tour Core" }), h("p", { text }));
  if (extra) body.append(h("p", { class: "hint", text: extra }));
  root.replaceChildren(body);
}

function showClaimed() {
  show(CLAIMED, "You can remove the bootstrap secret from the host settings. It will not be accepted again.");
}

async function post(code) {
  const res = await fetch("/api/claim", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, ...(requestId ? { requestId } : {}) }),
  });
  return res.json().catch(() => ({}));
}

function afterClaim(data) {
  if (!data.ok) {
    show(data.error?.message || "That claim isn't valid.");
    return;
  }
  if (typeof data.next === "string" && data.next.startsWith("/connect?request=")) {
    location.replace(data.next);
    return;
  }
  showClaimed();
}

function showForm() {
  const input = h("input", { type: "password", name: "secret", autocomplete: "off", autocapitalize: "off", spellcheck: "false" });
  const button = h("button", { type: "submit", class: "primary", text: "Claim installation" });
  const form = h("form", {}, h("h1", { text: "Tour Core" }), h("p", { text: "Enter the one-time bootstrap secret for this hosted installation." }), h("label", { text: "Bootstrap secret" }), input, h("div", { class: "actions" }, button));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const value = input.value;
    input.value = "";
    button.disabled = true;
    afterClaim(await post(value));
  });
  root.replaceChildren(h("div", { class: "phone-body" }, form));
}

async function start() {
  if (fragmentCode) {
    afterClaim(await post(fragmentCode));
    return;
  }
  const status = await fetch("/api/claim", { cache: "no-store", credentials: "same-origin" }).then((res) => res.json()).catch(() => ({}));
  if (status.claimed) {
    showClaimed();
    return;
  }
  showForm();
}

start();
