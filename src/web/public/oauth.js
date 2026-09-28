// The consent page Grok opens through the public address. It can only say
// no: approval happens on the Tour Core computer. Once a decision is made it
// hands off to the server, which sends the browser back to Grok exactly once.

const status = document.getElementById("oauth-status");
const deny = document.getElementById("oauth-deny");
const base = `/oauth/requests/${encodeURIComponent(status.dataset.request)}`;
let finished = false;

function finish(message) {
  if (finished) return;
  finished = true;
  status.textContent = message;
  deny.disabled = true;
  location.replace(`${base}/continue`);
}

async function poll() {
  if (finished) return;
  try {
    const res = await fetch(base, { cache: "no-store" });
    const { status: state } = await res.json();
    if (state === "approved") return finish("Approved. Taking you back...");
    if (state === "denied") return finish("Not approved. Taking you back...");
    if (state === "expired") {
      status.textContent = "This request expired. Start connecting again from Grok.";
      deny.hidden = true;
      return;
    }
  } catch {
    // Keep waiting; the Tour Core computer may be busy.
  }
  setTimeout(poll, 1500);
}

deny.addEventListener("click", async () => {
  deny.disabled = true;
  await fetch(`${base}/deny`, { method: "POST" }).catch(() => {});
  finish("Not approved. Taking you back...");
});

poll();
