// Hosted approval. The link's fragment holds the session; it is not sent as a
// URL query. Allow is a button on this page. Reaching Tour Core is not enough
// to approve.

const root = document.getElementById("connect");
const params = new URLSearchParams(location.hash.slice(1));
if (params.get("s")) sessionStorage.setItem("tourcore-approval-session", params.get("s"));
if (params.get("c")) sessionStorage.setItem("tourcore-approval-csrf", params.get("c"));
if (location.hash) history.replaceState(null, "", location.pathname);
const session = sessionStorage.getItem("tourcore-approval-session") || "";
const csrf = sessionStorage.getItem("tourcore-approval-csrf") || "";

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

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    cache: "no-store",
    headers: {
      "X-TourCore-Approval-Session": session,
      "X-TourCore-Csrf": csrf,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function render() {
  const body = h("div", { class: "phone-body" }, h("h1", { text: "Connect to Tour Core" }));
  if (!session || !csrf) {
    body.append(h("p", { text: "This approval link is missing or was opened without its code. Go back to the chat and start again." }));
    root.replaceChildren(body);
    return;
  }
  const loaded = await api("GET", "/api/connect");
  if (loaded.status !== 200) {
    body.append(h("p", { text: loaded.data.error?.message || "This approval link isn't valid any more." }));
    root.replaceChildren(body);
    return;
  }
  const pending = loaded.data.pending || [];
  if (!pending.length) {
    body.append(h("p", { text: "Nothing is waiting for approval. If you just allowed it, you can return to the chat." }));
    root.replaceChildren(body);
    return;
  }
  body.append(h("p", { text: "Check that this code matches the one in the chat, then click Allow." }));
  for (const request of pending) {
    body.append(
      h(
        "div",
        { class: "card highlight" },
        h("p", { class: "match-code", text: request.matchCode }),
        h("p", { class: "hint", text: `${request.clientName} is asking to connect. It can set up your property and see tours. It cannot open doors or read saved credentials.` }),
        h(
          "button",
          {
            type: "button",
            class: "primary",
            onclick: async () => {
              const result = await api("POST", "/api/connect/approve", { requestId: request.id, matchCode: request.matchCode });
              body.replaceChildren(h("h1", { text: "Connect to Tour Core" }), h("p", { text: result.data.ok ? "Allowed. You can return to the chat." : result.data.error?.message || "That didn't go through." }));
            },
          },
          "Allow",
        ),
      ),
    );
  }
  root.replaceChildren(body);
}

render();
