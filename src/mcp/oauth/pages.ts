/**
 * The two small pages the public address serves during OAuth. Server-rendered
 * with everything escaped; the only script is /oauth.js (no inline code), and
 * the pages can't be framed or leak their URL through a referrer.
 */

export const PAGE_HEADERS: Record<string, string> = {
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const shell = (title: string, body: string, script = "") => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="referrer" content="no-referrer" />
    <meta name="robots" content="noindex" />
    <title>${escape(title)}</title>
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body class="visitor-page">
    <main class="phone verify-page" aria-live="polite">
      <div class="phone-body">
${body}
      </div>
    </main>${script}
  </body>
</html>
`;

export function consentPage(p: { requestId: string; matchCode: string; clientName: string; redirectHost: string; hosted?: boolean; owner?: boolean }): string {
  const requestId = escape(p.requestId);
  const hostedNext = p.owner
    ? `<p><a class="button primary" href="/connect?request=${requestId}">Continue to approval</a></p>`
    : `<p>Tour Core needs you to confirm ownership of this hosted installation before you can approve connections.</p>
          <p><a class="button primary" href="/claim?request=${requestId}">Confirm ownership</a></p>`;
  const decision = p.hosted
    ? hostedNext
    : `<p><strong>Approve on the Tour Core computer.</strong> A Tour Core window opens there (or open <em>Connect Grok</em> in Tour Core). Check it shows this code, then choose Allow:</p>`;
  return shell(
    "Connect to Tour Core",
    `        <h1>Tour Core</h1>
        <p><strong>${escape(p.clientName)}</strong> is requesting permission to manage this Tour Core installation.</p>
        <p class="hint">After you decide, you'll be sent back to ${escape(p.redirectHost)}.</p>
        <p>It will be able to:</p>
        <ul>
          <li>configure properties</li>
          <li>run readiness checks</li>
          <li>run practice tours</li>
          <li>inspect active tours</li>
          <li>work exceptions</li>
          <li>export records</li>
        </ul>
        <p>It will <strong>not</strong> be able to:</p>
        <ul>
          <li>directly unlock doors</li>
          <li>bypass Tour Core access policy</li>
          <li>read provider secrets</li>
        </ul>
        <p class="hint">Publishing, pausing, resuming, revoking tours and changing approved facts still ask you first, every time.</p>
        <div class="card highlight">
          ${decision}
          <p class="match-code">${escape(p.matchCode)}</p>
          <p id="oauth-status" class="muted" data-request="${requestId}">Waiting for approval…</p>
        </div>
        <button type="button" id="oauth-deny">Deny</button>`,
    `\n    <script type="module" src="/oauth.js"></script>`,
  );
}

export function problemPage(title: string, message: string): string {
  return shell(title, `        <h1>${escape(title)}</h1>\n        <p>${escape(message)}</p>`);
}
