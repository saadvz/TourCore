// Connect Grok, on the Tour Core computer only. This is where the owner
// allows or denies a connection request and disconnects Grok. The public
// address can't reach this page or its API.

const root = document.getElementById("grok");

function h(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  node.append(...kids.filter(Boolean));
  return node;
}

const post = (path) => fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).then((r) => r.json().catch(() => ({})));
const when = (ms) => new Date(ms).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

async function render() {
  const data = await fetch("/api/grok", { cache: "no-store" }).then((r) => r.json());
  const body = h("div", { class: "phone-body" }, h("h1", { text: "Connect Grok" }));

  if (data.mode !== "oauth") {
    body.append(h("p", { text: data.mode === "static" ? "Tour Core is in development mode: Grok connects with a static token (TOURCORE_MCP_AUTH_MODE=static). Switch to OAuth for the normal Grok connection." : "The Grok connector is off." }));
    return root.replaceChildren(body);
  }

  if (data.legacyCompat) {
    body.append(
      h("p", {
        class: "form-error",
        text: "Grok legacy OAuth compatibility is enabled for this P0 demo. Tour Core is accepting Cursor's known legacy OAuth callback. Disable this mode when Grok no longer requires it.",
      }),
    );
  }
  body.append(
    h("p", { class: "muted", text: data.connectUrl ? `In Grok, add a custom connector with this address: ${data.connectUrl}` : "Set PUBLIC_BASE_URL to your https tunnel address, then restart Tour Core." }),
  );

  if (data.pending.length) {
    for (const r of data.pending) {
      body.append(
        h(
          "div",
          { class: "card highlight" },
          h("p", {}, h("strong", { text: r.clientName }), " is requesting permission to manage this Tour Core installation."),
          h("p", { class: "hint", text: "Only allow it if the page Grok opened shows this same code:" }),
          h("p", { class: "match-code", text: r.matchCode }),
          h("p", { class: "hint", text: `It will return to ${r.redirectHost}. It can set up properties, run readiness checks and practice tours, see active tours, work exceptions and export records. It can't open doors, bypass Tour Core's access policy or read provider secrets.` }),
          h(
            "div",
            { class: "connect-actions" },
            h("button", { type: "button", class: "primary", onclick: async () => (await post(`/api/grok/requests/${encodeURIComponent(r.id)}/approve`), render()) }, "Allow"),
            h("button", { type: "button", onclick: async () => (await post(`/api/grok/requests/${encodeURIComponent(r.id)}/deny`), render()) }, "Deny"),
          ),
        ),
      );
    }
  } else {
    body.append(h("p", { text: "No connection requests are waiting." }));
  }

  body.append(h("h2", { text: "Connected" }));
  if (data.connections.length) {
    for (const c of data.connections) {
      body.append(h("p", {}, h("strong", { text: c.clientName }), ` since ${when(c.connectedAt)}. Approval ends ${when(c.approvalEndsAt)}.`));
    }
    body.append(
      h(
        "button",
        {
          type: "button",
          onclick: async () => {
            if (!confirm("Disconnect Grok? Its access stops right away. Properties, tours and messaging aren't changed.")) return;
            await post("/api/grok/disconnect");
            render();
          },
        },
        "Disconnect Grok",
      ),
    );
  } else {
    body.append(h("p", { class: "muted", text: "Nothing is connected." }));
  }
  root.replaceChildren(body);
}

render().catch(() => root.replaceChildren(h("p", { text: "Couldn't load. Is Tour Core still running?" })));
setInterval(() => render().catch(() => {}), 3000);
