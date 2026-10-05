import vm from "node:vm";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// main.js is evaluated by IINA, not by a WebView, so it needs a different set of
// stubs from the sidebar: there is no DOM here, but there is the iina host,
// which offers menus, an mpv bridge, two WebView proxies and an event bus.
//
// The point of loading it at all is that its pure helpers are the only
// meaningful logic in the file and nothing was testing them: eight deliberate
// breaks to mergeSegments, validSegment and the confidence filters all passed
// the suite.

// Shaped like what IINA's http module actually returns, which main.js reads
// as `statusCode` and `data`. `text` is a string there, not a function: IINA
// hands back the parsed body in `data` and the raw body in `text`.
function emptyResponse() {
  return {
    ok: true,
    status: 200,
    statusCode: 200,
    data: {},
    text: "{}",
    json: () => Promise.resolve({})
  };
}

// main.js reads `statusCode` and `data` from what IINA's http module returns,
// so the stub offers both alongside the fetch-shaped fields.
function makeResponse(body) {
  const statusCode = (body && typeof body === "object" && typeof body.statusCode === "number")
    ? body.statusCode : 200;
  const payload = (body && typeof body === "object" && "data" in body) ? body.data : body;
  const raw = typeof payload === "string" ? payload : JSON.stringify(payload);
  return Object.assign(emptyResponse(), {
    statusCode,
    data: payload,
    text: raw,
    json: () => Promise.resolve(typeof payload === "string" ? JSON.parse(payload) : payload)
  });
}

function makeWebViewProxy(name, sink, gate) {
  // Only loadFile throws when the player window is not up. postMessage does
  // not: IINA's sidebar and overlay postMessage have no such guard, so the
  // message is silently lost. Modelling both as throwing made every
  // postMessage call site look protected, and left the harness unable to
  // express "this message never arrived", which is the failure mode most of
  // main.js's postMessage calls are actually exposed to.
  const guard = (what) => {
    if (gate && gate() === false) {
      throw new Error("player window not loaded (" + what + ")");
    }
  };
  return {
    _name: name,
    loadFile(f) { guard("loadFile"); sink.calls.push([name, "loadFile", f]); },
    // A dropped message is recorded, not thrown, so a test can see that it
    // went nowhere.
    postMessage(msg, payload) {
      if (gate && gate() === false) { sink.dropped.push([name, msg, payload]); return; }
      sink.calls.push([name, "postMessage", msg, payload]);
    },
    onMessage(msg, fn) { sink.handlers[name + ":" + msg] = fn; },
    show() {
      if (gate && gate() === false) { sink.dropped.push([name, "show", null]); return; }
      sink.calls.push([name, "show", null, null]);
    },
    hide() {
      if (gate && gate() === false) { sink.dropped.push([name, "hide", null]); return; }
      sink.calls.push([name, "hide", null, null]);
    },
    setClickable(v) { if (gate && gate() === false) { sink.dropped.push([name, "setClickable", v]); return; } sink.calls.push([name, "setClickable", v, null]); },
    close() {}
  };
}

export function loadMain(opts = {}) {
  const sink = {
    calls: [],
    handlers: {},
    logs: [],
    // Everything the plugin set on mpv, so a test can assert on it.
    mpvSet: {},
    mpvCommands: [],
    seeks: [],
    http: opts.http || {},          // url -> body | Promise | Error
    httpCalls: [],
    // The delay each timer was armed with, so a test can check what the plugin
    // asked for rather than only that something was asked for.
    timerMs: [],
    eventRegistrations: [],
    // Messages IINA accepted but the player window swallowed, because it was
    // not loaded yet. postMessage and show/hide are silent no-ops there.
    dropped: []
  };

  // Whether the player window is up. IINA's sidebar/overlay calls throw when
  // it is not, and the plugin's teardown ordering depends on that.
  let isWindowLoaded = opts.windowLoaded === undefined ? true : !!opts.windowLoaded;
  const windowLoaded = () => isWindowLoaded;

  const mpvProps = opts.mpvProps || {};
  const coreStatus = Object.assign({ paused: false, url: "", duration: 0 }, opts.status || {});

  const iina = {
    console: { log: (m) => sink.logs.push(m), warn(){}, error(){} },
    mpv: {
      getNumber(name) { return typeof mpvProps[name] === "number" ? mpvProps[name] : 0; },
      getString(name) { return typeof mpvProps[name] === "string" ? mpvProps[name] : ""; },
      getBool(name, def) { return typeof mpvProps[name] === "boolean" ? mpvProps[name] : !!def; },
      set(name, value) { sink.mpvSet[name] = value; },
      command(name, args) { sink.mpvCommands.push([name, args]); },
      observeProperty() {},
      unobserveProperty() {}
    },
    http: {
      get(url, options) {
        sink.httpCalls.push(url);
        const hit = sink.http[url];
        if (hit === undefined) {
          return Promise.resolve(emptyResponse());
        }
        if (hit instanceof Error) return Promise.reject(hit);
        let body;
        try {
          body = typeof hit === "function" ? hit(url) : hit;
        } catch (e) {
          return Promise.reject(e);
        }
        if (body instanceof Error) return Promise.reject(body);
        // A route function may hand back a promise, to hold a response open
        // while a test does something else. Adopting it matters: storing the
        // promise itself as the payload left every field undefined, so the
        // plugin took its "no data" path and the test passed for the wrong
        // reason.
        if (body && typeof body.then === "function") {
          return body.then(makeResponse, (e) => Promise.reject(e));
        }
        return Promise.resolve(makeResponse(body));
      }
    },
    core: {
      status: coreStatus,
      getChapters() { return opts.chapters || []; },
      seekTo(sec) { sink.seeks.push(sec); },
      osd() {},
      getPassword() { return Promise.resolve(""); }
    },
    // Read through a thunk rather than capturing the value, so a test can flip
    // the gate after the proxy has been built.
    overlay: makeWebViewProxy("overlay", sink, () => windowLoaded()),
    sidebar: makeWebViewProxy("sidebar", sink, () => windowLoaded()),
    event: {
      on(name, fn) {
        sink.eventRegistrations.push(name);
        sink.handlers["event:" + name] = fn;
        return "evt-" + name + "-" + sink.eventRegistrations.length;
      },
      // Unregisters, as IINA's does. Recording the call and leaving the handler
      // in place made "stops the time observer" untestable: nothing in a test
      // could ever observe the observer stopping.
      off(name, id) {
        sink.calls.push(["event", "off", name, id]);
        if (sink.handlers["event:" + name]) delete sink.handlers["event:" + name];
      }
    },
    menu: {
      item(title, fn) { return { title, fn }; },
      addItem(item) { sink.menuItem = item; },
      buildMenu() {}
    },
    utils: { exec() { return Promise.resolve(""); }, ask() { return Promise.resolve(""); } },
    file: {}
  };

  const timers = [];
  const ctx = {
    iina,
    console: { log(){}, warn(){}, error(){} },
    setTimeout(fn, ms) { timers.push(fn); sink.timerMs.push(ms); return timers.length; },
    clearTimeout(id) { if (timers[id - 1]) timers[id - 1] = null; },
    Promise,
    JSON,
    Math,
    Object,
    Array,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
    Date,
    isFinite,
    isNaN,
    parseInt,
    parseFloat,
    encodeURIComponent,
    decodeURIComponent,
    setInterval() { return 0; },
    clearInterval() {}
  };
  ctx.globalThis = ctx;
  const context = vm.createContext(ctx);
  const src = readFileSync(join(ROOT, "main.js"), "utf8");
  new vm.Script(src, { filename: "main.js" }).runInContext(context);

  return {
    ctx: context,
    global: context,
    sink,
    dropped: sink.dropped,
    // Flip the window-loaded gate mid-test.
    setWindowLoaded(v) { isWindowLoaded = !!v; },
    // Flip the paused state mid-test, as playback does.
    setPaused(v) { coreStatus.paused = !!v; },
    // Timer callbacks still armed, so a test can prove a deadline was disarmed
    // rather than left to fire into nothing.
    pendingTimers() { return timers.filter((fn) => fn).length; },
    // Fire every scheduled callback, the way an IINA session would after time
    // passes. The plugin arms timers for its HTTP timeouts and its pause delay.
    runTimers() { const t = timers.slice(); timers.length = 0; t.forEach((fn) => { if (fn) fn(); }); },
    // Deliver an event as IINA would.
    emit(name, payload) {
      const fn = sink.handlers["event:" + name];
      // "No handler" is now also true of one that was switched off on purpose,
      // which is exactly what a test of stopTimeWatcher needs to assert.
      if (!fn) throw new Error(`main.js has no live handler for "${name}"`);
      return fn(payload);
    },
    // Whether anything is still listening, without delivering an event.
    listening(name) { return !!sink.handlers["event:" + name]; },
    // Deliver a message from a WebView.
    fromWebView(which, name, payload) {
      const fn = sink.handlers[which + ":" + name];
      if (!fn) throw new Error(`main.js registered no handler for ${which}:${name}`);
      return fn(payload);
    },
    posted(which, name) {
      return sink.calls
        .filter((c) => c[0] === which && c[1] === "postMessage" && c[2] === name)
        .map((c) => c[3]);
    }
  };
}

export async function settle(rounds = 30) {
  for (let i = 0; i < rounds; i++) {
    await new Promise((r) => setImmediate(r));
  }
}