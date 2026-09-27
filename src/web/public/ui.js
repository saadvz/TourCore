// Shared browser helpers for the operator app and the visitor phone.
// No product rules live here: they come from the Tour Core API.

export const state = { meta: null, dirty: false, pending: [] };
export const enc = encodeURIComponent;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class UiError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

export async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  if (!res.ok) throw new UiError(data.error?.message ?? "Something went wrong.", data.error?.dev?.code);
  return data;
}

export async function loadMeta() {
  if (!state.meta) state.meta = await api("GET", "/api/meta");
  return state.meta;
}

// ------------------------------------------------------------------ saving

/** The small "Saving... / All changes saved" line shown on setup screens. */
export function showSaveState(label, kind) {
  const node = document.querySelector(".save-state");
  if (!node) return;
  node.textContent = label;
  node.dataset.state = kind;
}

/** Sends one setup edit. Valid edits are saved immediately by the server; the indicator shows which happened. */
export async function command(id, name, input) {
  showSaveState("Saving...", "saving");
  try {
    const res = await api("POST", `/api/properties/${enc(id)}/commands/${name}`, { input });
    if (res.summary?.save) showSaveState(res.summary.save.label, res.summary.save.state);
    return res;
  } catch (e) {
    showSaveState("Not saved. See the message below.", "error");
    throw e;
  }
}

/** Marks the current screen as having typed-but-unsent changes. */
export function markDirty() {
  if (state.dirty) return;
  state.dirty = true;
  showSaveState("Changes not saved yet. Press Continue or Save.", "dirty");
}

/**
 * Register a save that must run before leaving this screen (e.g. a suggested
 * route the operator can see but hasn't saved). It should throw to stop.
 */
export function onLeave(save) {
  state.pending.push(save);
}

export async function runPendingSaves() {
  for (const save of state.pending) await save();
  state.pending = [];
  state.dirty = false;
}

window.addEventListener("beforeunload", (e) => {
  if (state.dirty) e.preventDefault();
});

// ------------------------------------------------------------------ DOM

export function el(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (k === "value" || k === "checked" || k === "selected" || k === "hidden") node[k] = v;
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  add(node, ...children);
  return node;
}

const present = (list) =>
  list.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false).map((c) => (c instanceof Node ? c : document.createTextNode(String(c))));
/** replaceChildren/append, but skipping empty slots so optional parts never render as "null". */
export const set = (node, ...children) => node.replaceChildren(...present(children));
export const add = (node, ...children) => node.append(...present(children));

export const btn = (label, onclick, cls = "") => el("button", { type: "button", class: cls, onclick }, label);
export const input = (props = {}) => el("input", { type: "text", ...props });
export const textarea = (value = "", placeholder = "") => el("textarea", { value, placeholder });
export const field = (text, control, hint) => el("label", {}, text, hint ? el("span", { class: "hint" }, hint) : null, control);
export const lines = (text) => text.split("\n").map((l) => l.trim()).filter(Boolean);
export const mark = (ok) =>
  el("span", { class: `mark ${ok === true ? "ok" : ok === false ? "bad" : "info"}`, "aria-hidden": "true" }, ok === true ? "\u2713" : ok === false ? "\u2715" : "\u2022");
export const devChip = (text) => (state.meta?.dev && text ? el("span", { class: "dev-chip" }, text) : null);
export const devBlock = (obj) =>
  state.meta?.dev && obj ? el("details", {}, el("summary", {}, "Developer details"), el("pre", { class: "dev" }, JSON.stringify(obj, null, 2))) : null;
export const downloadLink = (label, href) => el("a", { class: "button", href, download: "" }, label);

export function errorBox() {
  const node = el("p", { class: "form-error", role: "alert", hidden: true });
  return {
    node,
    show: (msg) => {
      node.textContent = msg;
      node.hidden = false;
    },
    clear: () => {
      node.hidden = true;
    },
  };
}

export function banner(message) {
  const app = document.getElementById("app");
  app.querySelector(".banner")?.remove();
  app.prepend(el("div", { class: "issues banner", role: "alert" }, message));
  window.scrollTo(0, 0);
}

/** Wraps a click handler: disables the button while working and shows errors in plain words. */
export function action(fn, errors) {
  return async (ev) => {
    const b = ev?.currentTarget instanceof HTMLButtonElement ? ev.currentTarget : null;
    if (b) b.disabled = true;
    errors?.clear();
    try {
      await fn(ev);
    } catch (e) {
      const msg = e.message + (state.meta?.dev && e.code ? ` [${e.code}]` : "");
      errors ? errors.show(msg) : banner(msg);
    } finally {
      if (b?.isConnected) b.disabled = false;
    }
  };
}

// ------------------------------------------------------------------ routing

export const go = (hash) => {
  if (location.hash === hash) window.dispatchEvent(new Event("tourcore:rerender"));
  else location.hash = hash;
};
export const rerender = () => window.dispatchEvent(new Event("tourcore:rerender"));
export const base = (id) => `#/p/${enc(id)}`;
export const stepHref = (id, step, unitId) => `${base(id)}/setup/${step}${unitId ? `?unit=${enc(unitId)}` : ""}`;
