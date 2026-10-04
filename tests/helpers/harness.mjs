import vm from "node:vm";
import { sidebarScripts, overlayScripts } from "./extract.mjs";

// ── Minimal DOM ────────────────────────────────────────────────────────
// The web views touch the DOM at load time (the overlay toggle IIFE, the API
// key IIFE, the details/section wiring), so a real element has to come back
// from every getElementById even though the parser tests never look at it.
// Every id resolves to the same stub for the life of the context, which is
// what lets a test assert on what a handler wrote.
function makeElement(id) {
  const el = {
    id,
    textContent: "",
    innerHTML: "",
    value: "",
    checked: false,
    disabled: false,
    placeholder: "",
    display: "",
    offsetWidth: 0,
    scrollHeight: 0,
    clientHeight: 0,
    style: {},
    dataset: {},
    attributes: {},
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      contains(c) { return this._set.has(c); },
      toggle(c) { this._set.has(c) ? this._set.delete(c) : this._set.add(c); }
    },
    addEventListener() {},
    removeEventListener() {},
    setAttribute(k, v) { this.attributes[k] = v; },
    getAttribute(k) { return this.attributes[k]; },
    removeAttribute(k) { delete this.attributes[k]; },
    hasAttribute(k) { return k in this.attributes; },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    appendChild(c) { return c; },
    focus() {}
  };
  return el;
}

function makeDocument() {
  const els = new Map();
  return {
    documentElement: makeElement("html"),
    getElementById(id) {
      if (!els.has(id)) els.set(id, makeElement(id));
      return els.get(id);
    },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    createElement(tag) { return makeElement(tag); },
    addEventListener() {},
    _els: els
  };
}

function makeLocalStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem(k) { return map.has(String(k)) ? map.get(String(k)) : null; },
    setItem(k, v) { map.set(String(k), String(v)); },
    removeItem(k) { map.delete(String(k)); },
    clear() { map.clear(); },
    _map: map
  };
}

function makeIina() {
  const handlers = new Map();
  const posted = [];
  return {
    onMessage(name, fn) { handlers.set(name, fn); },
    postMessage(name, payload) { posted.push({ name, payload }); },
    console: { log() {}, warn() {}, error() {} },
    _handlers: handlers,
    _posted: posted,
    // Test helper: deliver a message as if main.js had sent it.
    _emit(name, payload) {
      const fn = handlers.get(name);
      if (!fn) throw new Error(`no handler registered for "${name}"`);
      return fn(payload);
    }
  };
}

// Timers are recorded rather than scheduled. autoIdentify arms a 25s give-up
// timer that would otherwise keep the event loop alive for the length of every
// test, and a test that has to wait 25s to prove a failure path is worthless.
function makeTimers() {
  let seq = 0;
  const timers = new Map();
  return {
    setTimeout(fn, ms) {
      const id = ++seq;
      timers.set(id, { fn, ms, cancelled: false });
      return id;
    },
    clearTimeout(id) {
      const t = timers.get(id);
      if (t) t.cancelled = true;
    },
    _timers: timers,
    _pending() {
      return [...timers.values()].filter((t) => !t.cancelled);
    },
    _fireAll() {
      for (const t of timers.values()) if (!t.cancelled) t.fn();
    }
  };
}

// fetch stub. `routes` is either a function (url) => body|undefined or a map
// of substring -> body. Returning undefined produces TMDB's 404 shape so a
// test can prove the code walks on to the next candidate rather than dying.
function makeFetch(routes, calls) {
  return function fetchStub(url) {
    calls.push(String(url));
    let body;
    if (typeof routes === "function") {
      body = routes(String(url));
    } else {
      for (const [needle, value] of Object.entries(routes || {})) {
        if (String(url).includes(needle)) { body = value; break; }
      }
    }
    if (body === undefined) {
      return Promise.resolve({
        ok: false,
        status: 404,
        json: () => Promise.resolve({
          status_code: 34,
          status_message: "The resource you requested could not be found."
        })
      });
    }
    const payload = typeof body === "function" ? body(String(url)) : body;
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(payload)
    });
  };
}

function buildContext(opts = {}) {
  const calls = [];
  const timers = makeTimers();
  const ctx = {
    document: makeDocument(),
    localStorage: makeLocalStorage(opts.storage),
    iina: makeIina(),
    console: { log() {}, warn() {}, error() {} },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    fetch: makeFetch(opts.routes || {}, calls)
  };
  ctx.globalThis = ctx;
  ctx.window = ctx;
  return { ctx, calls, timers };
}

// Run every inline <script> body of a web view in one shared context, so
// state and functions declared in one block are visible to the next and to the
// test. `var` and `function` declarations at script top level land on the
// context's global object, which is how the tests reach parseFilename.
function runScripts(sources, opts = {}) {
  const { ctx, calls, timers } = buildContext(opts);
  const context = vm.createContext(ctx);
  for (const src of sources) {
    new vm.Script(src, { filename: opts.filename || "inline.js" }).runInContext(context);
  }
  return {
    ctx: context,
    global: context,
    document: context.document,
    localStorage: context.localStorage,
    iina: context.iina,
    fetchCalls: calls,
    timers
  };
}

export function loadSidebar(opts = {}) {
  return runScripts(sidebarScripts(), { ...opts, filename: "sidebar.html" });
}

export function loadOverlay(opts = {}) {
  return runScripts(overlayScripts(), { ...opts, filename: "overlay.html" });
}

// ── Assertions on captured output ───────────────────────────────────────

// Every fetch the run made, with the query parameter decoded so a test can
// assert on what was actually searched for.
export function searchedQueries(urls) {
  return urls.map((u) => {
    const m = /[?&]query=([^&]+)/.exec(u);
    return m ? decodeURIComponent(m[1]) : null;
  });
}

export function requestedPaths(urls) {
  return urls.map((u) => {
    const m = /^https:\/\/api\.themoviedb\.org(\/[^?]+)/.exec(u);
    return m ? m[1] : u;
  });
}

// Let queued promise callbacks run. The plugin chains several .then() hops per
// request, so one macrotask is not enough to settle a chain.
export async function settle(rounds = 12) {
  for (let i = 0; i < rounds; i++) {
    await new Promise((r) => setImmediate(r));
  }
}