// Every host the source files reference through a URL.
//
// Split out of check-apis.mjs so it can be tested without running the health
// checks, which need the network.

// Comments, removed before anything is scanned.
//
// A host named only in a comment is not a host the plugin calls, and a comment
// was enough to satisfy "every allow-listed host is referenced": adding a dead
// entry to Info.json alongside a `// see https://that-host` line passed.
// String-aware, because "//" also starts every URL, and naive stripping would
// delete the very references this exists to find.
export function stripComments(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  // The quote character that ends a literal, or "" when not inside one.
  let quote = "";
  while (i < n) {
    const c = src[i];
    if (quote) {
      out += c;
      if (c === "\\") {                       // an escaped character
        if (i + 1 < n) { out += src[i + 1]; i += 2; continue; }
      } else if (c === quote) {
        quote = "";
      }
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c;
      i++;
      continue;
    }
    // Not inside a string here, so this "//" really is a comment.
    if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      out += "\n";                             // keep the lines, for the heuristics
      continue;
    }
    if (c === "<" && src.slice(i, i + 4) === "<!--") {
      const end = src.indexOf("-->", i);
      i = end === -1 ? n : end + 3;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// Hosts a URL literal points at. Every absolute URL counts, wherever it
// appears, rather than only the ones sitting directly inside a fetch call.
// Matching call sites meant a URL reached through a variable was invisible:
//
//   var u = "https://tracker.example.com/collect";
//   iina.http.get(u, {});
//
// passed the check, which made the README's "CI fails the build if the code
// ever calls a host outside that list" untrue.
function hostsIn(src) {
  const hosts = new Set();
  for (const m of src.matchAll(/["'`]\bhttps?:\/\/[^\s"'`)<>\\]+/gi)) {
    try {
      // new URL normalises away the port, so an explicit ":8443" is not
      // reported as a different host from the same name without one.
      hosts.add(new URL(m[0].slice(1)).hostname);
    } catch {
      // Not a URL we can parse (a template literal part, say). Skipped rather
      // than guessed at.
    }
  }
  return hosts;
}

// Script bodies in an HTML source, which is where every request these files
// make is written.
function scriptBodies(html) {
  return [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join("\n");
}

// Hosts referenced from the markup: the attributes that make a request, the CSS
// that pulls a stylesheet or a font, and every URL in a style block.
function hostsInMarkup(html) {
  const hosts = new Set();
  const add = (raw) => {
    try {
      hosts.add(new URL(raw).hostname);
    } catch {
      // Unparseable, so nothing to report.
    }
  };
  // Script *bodies* are emptied first, while the opening tag is kept: "<" and
  // ">" are operators in JavaScript, so scanning markup and script separately
  // is the only way to tell a tag from a comparison, and a <script src> still
  // has to be seen as the fetch it is. The bodies are scanned by the caller.
  const markup = html.replace(/(<script\b[^>]*>)[\s\S]*?(<\/script>)/gi, "$1$2");
  const ATTR = /\b(src|action|data|poster|href)\s*=\s*["'`]?(https?:\/\/[^\s"'`)<>\\]+)/gi;
  const SRCSET = /\bsrcset\s*=\s*(["'`])([\s\S]*?)\1/gi;
  for (const tag of markup.match(/<[^>]*>/g) || []) {
    // An href on a link is a destination the user chooses to click, not a
    // request the plugin makes: TMDB's own name is one, in the attribution
    // line, and an <area> in an image map is the same thing. Every other
    // attribute here is the plugin fetching something.
    if (/^<a[\s/>]/i.test(tag) || /^<area[\s/>]/i.test(tag)) continue;
    ATTR.lastIndex = 0;
    let m;
    while ((m = ATTR.exec(tag))) add(m[2]);
    // srcset gets its own pattern because its value contains spaces: it is a
    // comma-separated list where every entry is a URL and a descriptor, and
    // reading only the first left the second host uncalled-for in the list.
    SRCSET.lastIndex = 0;
    while ((m = SRCSET.exec(tag))) {
      for (const part of m[2].split(",")) add(part.trim().split(/\s+/)[0]);
    }
  }
  const css = [
    ...(markup.match(/<style[^>]*>[\s\S]*?<\/style>/gi) || []),
    ...(markup.match(/\sstyle\s*=\s*["'`][^"'`]*["'`]/gi) || [])
  ].join("\n")
    // Entities first: a style attribute spells its inner quotes &quot;, which
    // hid the url() behind it from the pattern below.
    .replace(/&quot;|&#0?34;|&apos;|&#0?39;/g, "\"");
  // Quoted as well as unquoted: url("…") inside a style attribute was missed,
  // and that is the usual spelling of an imported webfont.
  for (const m of css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) add(m[1]);
  for (const m of css.matchAll(/@import\s+["'](https?:\/\/[^"']+)/gi)) add(m[1]);
  return hosts;
}

// The hosts one source file calls.
//
// For a .js file that is the whole thing. For an HTML file it is the scripts
// plus everything the markup itself fetches. Deciding "is this URL inside a
// tag?" by looking for a "<" with no ">" after it cannot work, because "i < n"
// is on every loop in this code: that mistake made the check see 2 hosts where
// the code calls 7, while still reporting success.
export function hostsInSource(src, isHtml) {
  const clean = stripComments(src);
  if (!isHtml) return hostsIn(clean);
  const hosts = hostsIn(scriptBodies(clean));
  for (const h of hostsInMarkup(clean)) hosts.add(h);
  return hosts;
}