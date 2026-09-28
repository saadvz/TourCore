// Operator views of tours: past practice tours and visitor demos, and the live view of a visitor demo.
// Everything shown comes from Tour Core's presenters; nothing here decides anything.

import { action, api, banner, base, btn, devBlock, devChip, downloadLink, el, enc, errorBox, go, mark, set, state } from "/ui.js";

const getProperty = (id) => api("GET", `/api/properties/${enc(id)}`);

/** Starts a visitor demo, opens the phone view in a new tab, and switches this tab to the live view. */
export async function startVisitorDemo(id) {
  const phone = window.open("about:blank", "_blank");
  try {
    const res = await api("POST", `/api/properties/${enc(id)}/visitor-demos`, {});
    if (res.readiness) {
      phone?.close();
      banner("A few things need fixing before a visitor demo. Run the readiness check to see them.");
      return;
    }
    if (phone) phone.location.href = res.visitorUrl;
    go(`${base(id)}/live/${enc(res.sessionId)}`);
  } catch (e) {
    phone?.close();
    throw e;
  }
}

export async function historyRedirect(id) {
  go(`${base(id)}/tours`);
  return el("p", { class: "muted" }, "Loading...");
}

// ------------------------------------------------------------------ list

export async function toursScreen(id) {
  const [{ tours }, { summary }] = await Promise.all([api("GET", `/api/properties/${enc(id)}/tours`), getProperty(id)]);
  return el(
    "div",
    {},
    el("p", { class: "muted" }, summary.name),
    el("h1", {}, "Practice tours"),
    tours.length
      ? el(
          "div",
          { class: "card" },
          el(
            "ul",
            { class: "checks tour-list" },
            tours.map((t) =>
              el(
                "li",
                {},
                el(
                  "a",
                  { href: `${base(id)}/tours/${enc(t.id)}`, class: "tour-link" },
                  mark(t.ok),
                  el("span", {}, el("strong", {}, t.label), ` \u2014 ${t.outcomeLabel}`, el("span", { class: "muted" }, ` \u00b7 ${t.kindLabel}${t.visitorName ? `, ${t.visitorName}` : ""}`)),
                ),
              ),
            ),
          ),
        )
      : el("p", {}, "No tours yet. Run a practice tour or start a visitor demo to see what happens on a tour."),
    el(
      "div",
      { class: "actions" },
      btn("Run a practice tour", () => go(`${base(id)}/practice`), tours.length ? "" : "primary"),
      btn("Back", () => go(summary.published ? `${base(id)}/published` : "#/")),
    ),
  );
}

// ------------------------------------------------------------------ detail

function historyList(entries) {
  return el(
    "ul",
    { class: "checks history" },
    entries.map((e) =>
      el(
        "li",
        {},
        el("span", { class: "time" }, e.time),
        mark(e.tone === "good" ? true : e.tone === "blocked" ? false : null),
        el("span", {}, e.text, devChip(e.dev ? [e.dev.type, e.dev.code].filter(Boolean).join(" ") : "")),
      ),
    ),
  );
}

export function conversationView(items) {
  return el(
    "div",
    { class: "thread small-thread" },
    items.map((m) => el("div", { class: `bubble from-${m.from}` }, el("span", { class: "bubble-text" }, m.text), el("span", { class: "bubble-time" }, m.time))),
  );
}

export async function tourDetailScreen(id, tourId) {
  const [{ tour: t }, { summary }] = await Promise.all([api("GET", `/api/properties/${enc(id)}/tours/${enc(tourId)}`), getProperty(id)]);
  const exportBase = `/api/properties/${enc(id)}/tours/${enc(tourId)}/export`;
  return el(
    "div",
    {},
    el("p", { class: "muted" }, summary.name),
    el("h1", {}, `${t.title}, ${t.ranAtLabel}`),
    el(
      "div",
      { class: t.ok ? "success" : "notice" },
      el("strong", {}, t.outcomeLabel),
      el("p", {}, [t.visitorName, t.unitName, t.tourTime].filter(Boolean).join(" \u00b7 ")),
      t.failure ? el("p", {}, t.failure) : null,
    ),
    t.safetyChecks
      ? t.safetyChecks.map((g) =>
          el(
            "div",
            { class: g.id === "safety" ? "card safety" : "card" },
            el("h2", {}, g.title),
            el(
              "ul",
              { class: "checks" },
              g.items.map((i) => el("li", {}, el("div", { class: "check-line" }, mark(i.ok), el("div", {}, el("strong", {}, i.label), i.outcome ? el("span", { class: "outcome" }, i.outcome) : null)))),
            ),
          ),
        )
      : null,
    el("div", { class: "card" }, el("h2", {}, "Visitor conversation"), t.conversation.length ? conversationView(t.conversation) : el("p", { class: "muted" }, "No messages.")),
    el("div", { class: "card" }, el("h2", {}, "Access decisions"), t.accessDecisions.length ? historyList(t.accessDecisions) : el("p", { class: "muted" }, "No doors were requested.")),
    t.safetyEvents.length ? el("div", { class: "card" }, el("h2", {}, "Safety events and questions"), historyList(t.safetyEvents)) : null,
    el("details", { class: "card" }, el("summary", {}, "Full tour timeline"), historyList(t.timeline)),
    devBlock(t.dev),
    el(
      "div",
      { class: "actions" },
      downloadLink("Export records", `${exportBase}/records.json`),
      downloadLink("Download as spreadsheet", `${exportBase}/history.csv`),
      btn("All practice tours", () => go(`${base(id)}/tours`)),
    ),
  );
}

// ------------------------------------------------------------------ live

export async function liveScreen(id, sessionId) {
  const hash = location.hash;
  const root = el("div", {});
  const picker = el("div", {});
  const visitorUrl = `/visitor?s=${enc(sessionId)}`;
  let pickerOpen = false;
  const post = async (what, body = {}) => {
    draw((await api("POST", `/api/visitor-demos/${enc(sessionId)}/${what}`, body)).live);
    pickerOpen = false;
    set(picker);
  };
  // "Change tour time": the operator picks one of the property's open tour times; the visitor is told automatically.
  const openTimes = async () => {
    pickerOpen = true;
    root.append(picker);
    const { times, anyTime } = await api("GET", `/api/visitor-demos/${enc(sessionId)}/times`);
    const errors = errorBox();
    // Developer mode only: any date and time at the property, outside tour hours included.
    const exact = anyTime ? el("input", { type: "datetime-local", value: anyTime.now, "aria-label": "Any time (developer)" }) : null;
    const anyTimeRow = anyTime
      ? el(
          "div",
          { class: "actions" },
          el("span", { class: "muted" }, "Dev: any time"),
          exact,
          btn("Move to this time", action(() => post("reschedule", { localTime: exact.value }), errors), "small"),
        )
      : null;
    set(
      picker,
      el(
        "div",
        { class: "card" },
        el("h3", {}, "Change tour time"),
        times.length ? el("p", { class: "muted" }, "The visitor keeps their booking, consent and identity check, and gets a message with the new time.") : el("p", {}, "There are no other open tour times in the next two weeks."),
        el("div", { class: "actions" }, times.map((t) => btn(t.label, action(() => post("reschedule", { startsAt: t.startsAt }), errors), "small"))),
        anyTimeRow,
        errors.node,
        btn("Cancel", () => ((pickerOpen = false), set(picker)), "small"),
      ),
    );
  };
  const draw = (live) => {
    const realPhone = live.source === "Real phone";
    set(
      root,
      el("p", { class: "muted" }, realPhone ? "Text message tour" : "Visitor demo"),
      el("h1", {}, live.active ? "Active tour" : "Tour finished"),
      el(
        "div",
        { class: "card live" },
        el(
          "div",
          { class: "card-head" },
          el(
            "div",
            {},
            el("h3", {}, live.visitorName, live.channel ? el("span", { class: "channel-chip" }, live.channel) : null),
            live.visitorPhone ? el("p", { class: "muted" }, live.visitorPhone) : null,
            el("p", {}, [live.unitName, live.tourTime].filter(Boolean).join(" \u00b7 ") || "Hasn't picked a unit yet"),
          ),
          el("span", { class: `badge ${live.active ? "" : "good"}` }, live.status),
        ),
        el("p", {}, el("strong", {}, "Current step: "), live.currentStep),
        realPhone ? null : el("p", { class: "muted" }, `Demo clock: ${live.demoClock}`),
        live.followUp ? el("p", {}, el("strong", {}, "Follow-up: "), live.followUp) : null,
        live.optedOut ? el("p", { class: "form-error" }, "This visitor asked to stop messages.") : null,
        live.messageProblems ? el("p", { class: "form-error" }, live.messageProblems) : null,
      ),
      live.questions.length ? el("div", { class: "notice" }, el("strong", {}, "Needs your attention"), historyList(live.questions)) : null,
      live.recentMessages.length ? el("div", { class: "card" }, el("h2", {}, "Recent messages"), conversationView(live.recentMessages)) : null,
      el("div", { class: "card" }, el("h2", {}, "Recent activity"), live.recent.length ? historyList(live.recent) : el("p", { class: "muted" }, realPhone ? "Nothing yet." : "Nothing yet. Open the visitor's phone to begin.")),
      devBlock(live.dev),
      el(
        "div",
        { class: "actions" },
        live.canReschedule ? btn("Change tour time", () => openTimes(), "") : null,
        live.canReschedule && state.meta?.dev ? btn("Move tour to now", action(() => post("move-to-now")), "") : null,
        realPhone ? null : el("a", { class: "button primary", href: visitorUrl, target: "_blank", rel: "noopener" }, "Open the visitor's phone"),
        btn("View this tour's records", () => go(`${base(id)}/tours/${enc(live.tourId)}`)),
        btn("Back to property", () => go("#/")),
      ),
      pickerOpen ? picker : null,
    );
  };
  const first = await api("GET", `/api/visitor-demos/${enc(sessionId)}/live`);
  draw(first.live);
  // Polling is plenty for a local demo. It stops when you leave this screen.
  const poll = async () => {
    if (location.hash !== hash || !root.isConnected) return;
    try {
      draw((await api("GET", `/api/visitor-demos/${enc(sessionId)}/live`)).live);
    } catch {
      /* the next poll will try again */
    }
    setTimeout(poll, 1500);
  };
  setTimeout(poll, 1500);
  return root;
}
