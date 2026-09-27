// The visitor's phone. Every message, choice and decision comes from Tour Core
// through /api/visitor-demos; this file only draws them and sends taps back.

import { api, devBlock, el, enc, errorBox, field, input, loadMeta, set } from "/ui.js";

const phone = document.getElementById("phone");
const sessionId = new URLSearchParams(location.search).get("s");
let busy = false;

async function load() {
  await loadMeta();
  if (!sessionId) return set(phone, el("p", {}, "This link is missing its visitor demo. Start one from the Tour Core property page."));
  try {
    render((await api("GET", `/api/visitor-demos/${enc(sessionId)}`)).visitor);
  } catch (e) {
    set(phone, el("div", { class: "phone-body" }, el("p", {}, e.message)));
  }
}

async function send(action, inputValue, errors) {
  if (busy) return;
  busy = true;
  phone.classList.add("busy");
  try {
    render((await api("POST", `/api/visitor-demos/${enc(sessionId)}/actions/${action}`, { input: inputValue ?? {} })).visitor);
  } catch (e) {
    errors ? errors.show(e.message) : alert(e.message);
  } finally {
    busy = false;
    phone.classList.remove("busy");
  }
}

function composer(v) {
  const errors = errorBox();
  if (v.input.kind === "intro") {
    const name = input({ value: v.input.prefill.name, autocomplete: "off" });
    const tel = input({ value: v.input.prefill.phone, type: "tel", autocomplete: "off" });
    return el(
      "div",
      { class: "composer form" },
      el("p", { class: "muted" }, "Pretend you're a visitor texting the property."),
      field("Your name", name),
      field("Your phone number", tel),
      errors.node,
      el("button", { type: "button", class: "primary", onclick: () => send("begin", { name: name.value, phone: tel.value }, errors) }, "Text the property"),
    );
  }
  if (v.input.kind === "identity") {
    const p = v.input.prefill;
    const f = { firstName: input({ value: p.firstName }), lastName: input({ value: p.lastName }), email: input({ value: p.email, type: "email" }), phone: input({ value: p.phone, type: "tel" }) };
    return el(
      "div",
      { class: "composer form identity" },
      el("strong", {}, "Basic identity form"),
      el("p", { class: "muted" }, "Your legal name, email and phone, so the property knows who's visiting."),
      el("div", { class: "row" }, field("First name", f.firstName), field("Last name", f.lastName)),
      field("Email", f.email),
      field("Phone", f.phone),
      errors.node,
      el(
        "button",
        { type: "button", class: "primary", onclick: () => send("submitIdentity", Object.fromEntries(Object.entries(f).map(([k, i]) => [k, i.value])), errors) },
        "Submit form",
      ),
    );
  }
  if (v.input.kind === "none") {
    return el("div", { class: "composer" }, el("p", { class: "muted center" }, v.finished ? "This tour is finished. Thanks for trying the visitor demo!" : ""));
  }

  const ask = input({ placeholder: "Ask a question about this place", autocomplete: "off" });
  const sendQuestion = (text) => text.trim() && send("ask", { question: text }, errors);
  ask.addEventListener("keydown", (e) => e.key === "Enter" && sendQuestion(ask.value));
  return el(
    "div",
    { class: "composer" },
    el(
      "div",
      { class: "choices" },
      v.choices.map((c) =>
        el("button", { type: "button", class: `choice-btn ${c.tone ?? ""}`, onclick: () => send(c.action, c.input, errors) }, c.label, c.hint ? el("span", { class: "choice-hint" }, c.hint) : null),
      ),
    ),
    v.canAsk
      ? [
          el("div", { class: "suggestions" }, v.exampleQuestions.map((q) => el("button", { type: "button", class: "chip", onclick: () => sendQuestion(q) }, q))),
          el("div", { class: "ask" }, ask, el("button", { type: "button", onclick: () => sendQuestion(ask.value) }, "Send")),
        ]
      : null,
    errors.node,
    v.demoControls.length
      ? el(
          "details",
          { class: "demo-controls" },
          el("summary", {}, "Demo controls"),
          v.demoControls.map((c) => el("div", { class: "demo-control" }, el("button", { type: "button", class: "small", onclick: () => send(c.action, c.input, errors) }, c.label), el("span", { class: "hint" }, c.hint))),
        )
      : null,
  );
}

function render(v) {
  const thread = el(
    "div",
    { class: "thread" },
    v.thread.map((m) => el("div", { class: `bubble from-${m.from}` }, el("span", { class: "bubble-text" }, m.text), el("span", { class: "bubble-time" }, m.time))),
  );
  set(
    phone,
    el("header", { class: "phone-head" }, el("strong", {}, v.property.name), el("span", { class: "muted" }, "Tour Core")),
    thread,
    composer(v),
    devBlock(v.dev),
  );
  thread.scrollTop = thread.scrollHeight;
}

load();
