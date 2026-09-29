// One-time hosted owner claim. The code arrives in the URL fragment, which
// the browser does not send to the server. It is posted once, then removed
// from the address bar.

const root = document.getElementById("claim");
const requestId = new URLSearchParams(location.search).get("request") || "";
const code = new URLSearchParams(location.hash.slice(1)).get("c") || "";
if (location.hash) history.replaceState(null, "", location.pathname + location.search);

function h(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "text") node.textContent = v;
    else node.setAttribute(k, v);
  }
  node.append(...kids.filter(Boolean));
  return node;
}

function show(text) {
  root.replaceChildren(h("div", { class: "phone-body" }, h("h1", { text: "Tour Core" }), h("p", { text })));
}

async function claim(value) {
  show("Confirming ownership…");
  const res = await fetch("/api/claim", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: value, ...(requestId ? { requestId } : {}) }),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) {
    show(data.error?.message || "That claim isn't valid.");
    return;
  }
  if (typeof data.next === "string" && data.next.startsWith("/connect?request=")) {
    location.replace(data.next);
    return;
  }
  show("This browser is now the Tour Core owner. When a connection asks for approval, use Continue to approval and then Allow.");
}

if (!code) show("This claim link is missing its code. Use the one-time link from the Tour Core service.");
else claim(code);
