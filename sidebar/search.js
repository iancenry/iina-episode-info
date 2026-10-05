// ── Search ────────────────────────────────────────────────────
function setLoading(on) {
  document.getElementById("go").disabled = on;
  document.getElementById("q").disabled  = on;
}

// A promise chain, not async/await: this is the only ES6+ syntax either web
// view used, and a parse error here takes the whole sidebar script with it,
// leaving a blank panel and no API-key form. Node's --check accepts async, so
// the syntax test could not see it either; tests/syntax.test.mjs now rejects
// it outright.
function doSearch() {
  var q = (document.getElementById("q").value || "").trim();
  if (!q) return;
  // The user is driving from here, so anything still in flight from the
  // automatic lookup is stale. Without this it landed a moment later and
  // replaced the results the user was looking at with a show they never chose.
  invalidateLookups();
  pushSearch(q);
  setLoading(true);
  document.getElementById("panel").innerHTML =
    '<div class="msg"><span class="sp"></span>Searching…</div>';
  fetch("https://api.themoviedb.org/3/search/multi?api_key=" + TK +
    "&query=" + encodeURIComponent(q) + "&include_adult=false")
    .then(function (r) { return r.json(); })
    .then(function (data) { renderSearchResults(data); })
    .catch(function () {
      document.getElementById("panel").innerHTML = '<div class="msg">Search failed.</div>';
    })
    .then(function () { setLoading(false); });
}

function renderSearchResults(data, heading) {
  {
    var list = (data.results||[])
      .filter(function(x){ return x.media_type==="tv"||x.media_type==="movie"; })
      .slice(0,8);

    if (!list.length) {
      document.getElementById("panel").innerHTML = '<div class="msg">No results found.</div>';
      return;
    }

    // FIX: Store search results in an array; onclick uses index only.
    // This avoids any HTML/JSON escaping issues with show titles.
    var searchCache = list;
    var html = "";
    list.forEach(function(item, i) {
      var title = item.title || item.name || "Untitled";
      var year  = yearOf(item.release_date || item.first_air_date);
      var img   = item.poster_path
        ? '<img class="rposter" src="'+IB+item.poster_path+'" />'
        : '<div class="rposter"></div>';
      html += '<div class="rrow">' + img +
        '<div class="ri"><div class="rn">'+htmlEsc(title)+'</div>' +
        '<div class="rs">'+(item.media_type==="tv"?"TV Series":"Movie")+(year?" · "+year:"")+'</div></div>' +
        '<button class="pb" onclick="pickItemByIndex('+i+')">Pick</button>' +
      '</div>';
    });
    // `heading` is set when these rows are the automatic lookup's leftovers
    // rather than something the user searched for, so the reason they are on
    // screen has to be stated above them.
    document.getElementById("panel").innerHTML =
      (heading ? '<div class="sl">' + heading + '</div>' : '') + html;

    // Attach search cache to the panel so pickItemByIndex can reach it
    document.getElementById("panel")._searchCache = searchCache;
  }
}

// ── HTML escape helper ────────────────────────────────────────
// Used whenever text goes into innerHTML (not textContent).
function htmlEsc(s) {
  return String(s||"")
    .replace(/&/g,"&amp;")
    .replace(/</g,"&lt;")
    .replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;")
    .replace(/'/g,"&#39;");
}
