// Release-group / source / quality noise that is never part of a title.
// Noise that is safe to delete wherever it appears: codecs, bit depths,
// channel tags and subtitle-kind markers. None of these is plausibly part of
// a series name.
var JUNK_WORDS = [
  "bluray", "blu ray", "bdrip", "brrip", "bdremux", "remux", "webrip", "webdl",
  // Bare "web" is not here: "Web of Lies" is a real episode title and the
  // global pass deleted the first word of it. It only comes off the end, where
  // "Show Name 1080p WEB" really does carry it.
  "hdtv", "pdtv", "dsr", "dvdrip", "dvd", "hddvd", "hd", "uhd",
  "x264", "x265", "h264", "h265", "hevc", "avc", "av1", "xvid", "divx",
  "aac", "ac3", "eac3", "dts", "dtshd", "truehd", "atmos", "flac", "mp3",
  "opus", "dd", "ddl", "dl", "ddp", "dd5", "ddp5",
  "10bit", "8bit", "hdr", "hdr10", "dv", "sdr", "hlg", "hdr10plus",
  // Channel-count and subtitle-kind tags used by Asian scene releases.
  "ch", "6ch", "2ch", "8ch", "5ch", "jpsc", "big5", "gb",
  "softsub", "hardsub", "softsubs", "hardsubs", "subbed", "subs",
  // Streaming services, which scene names carry in the middle of the title rather
  // than at the end: "The Bear ... HULU WEB-DL" searched for "The Bear HULU".
  // None of these is a word in an English title.
  "nf", "amzn", "hulu", "atvp", "pcok", "disney", "disneyplus", "netflix",
  "paramount",
  // Language codes, with a hard lesson attached: a three-letter code is a real
  // title word more often than you would think. "Chi" deleted The Chi and
  // Chi-Raq, "Spa" deleted the 2021 film, "Max" and "Peacock" are titles of
  // their own. Only codes that are not words belong here, and a new one has to
  // be checked against a title before it goes in.
  "ita", "eng", "fra", "ger", "jpn", "kor", "rus", "por",
  "imdb", "rerip"
];

// Deliberately NOT in JUNK_WORDS: "german", "russian", "season", "series",
// "complete", "limited", "internal", "proper", "web" and the rest of
// TRAILING_JUNK. They used to be in both lists, and the global pass deleted
// them from the middle of real titles: "Russian Doll" became "Doll", "The
// Italian Job" became "The Job", "A Series of Unfortunate Events" became
// "A of Unfortunate Events", "Web of Lies" became "of Lies". Each of those is
// a real show. They are only trimmed from the end, where "Show Name German
// 1080p" really does carry them.

var JUNK_RE = new RegExp(
  "\\b(" + JUNK_WORDS.join("|") + ")\\b", "gi");

// Tokens stripped one at a time from the END of a title. Nothing in here is
// realistically the last word of a show title.
var TRAILING_JUNK = {};
[
  "bluray","bdrip","brrip","remux","webrip","webdl","web","hdtv","pdtv",
  "dsr","dvdrip","dvd","hddvd","hd","uhd","x264","x265","h264","h265",
  "hevc","avc","av1","divx","aac","ac3","eac3","dts","dtshd","truehd",
  "atmos","flac","mp3","opus","dd","ddl","dl","ddp","dd5","ddp5","10bit",
  "8bit","hdr","hdr10","dv","sdr","hlg","repack","proper","internal",
  "limited","extended","uncut","retail","remastered","imax","complete",
  "german","english","french","spanish","italian","japanese","korean",
  "nordic","swedish","danish","dutch","polish","russian","turkish",
  "portuguese","subs","dubbed","multi","dual",
  // Editorial and format words that are also real title words, so they can
  // only ever come off the end.
  "season","series","complete","limited","internal","proper","repack",
  "retail","remastered","imax","extended","uncut","part","vol","volume",
  "disc","cd","alt","alternative"
].forEach(function(w) { TRAILING_JUNK[w] = 1; });

// Words that cannot be a title on their own. Nothing to do with release
// noise: they are what is left when the noise is gone, and they are the reason
// the trailing pass below stops. The editorial words are here because trimming
// them is only safe while a real word is left standing: "Severance Complete"
// loses "Complete", "The Limited Series" keeps its name.
var TITLE_LESS_WORDS = {
  the: 1, a: 1, an: 1, of: 1, and: 1, or: 1, in: 1, on: 1, at: 1, to: 1,
  is: 1, it: 1, no: 1, my: 1, this: 1, that: 1,
  limited: 1, series: 1, season: 1, complete: 1, collection: 1, edition: 1
};

// Trim trailing noise left behind by the substitutions in cleanTitle:
// "Severance DL DDP5 H 264" -> "Severance". A bare digit and a letter with
// digits after it are codec and resolution fragments, never titles.
//
// A lone trailing letter is not trimmed. That rule was here to catch the "H" of
// "DDP5 H 264", but "S.W.A.T", "N.C.I.S" and "M.1931" all lost their letters to
// it, and those are titles. A letter only counts as noise when numbers follow
// it, which is what a codec fragment always looks like.
//
// It stops rather than trim a name down to articles and prepositions. "The
// Limited Series" lost "Series", then "Limited", and was left as "The", which
// searches for nothing and reads worse than the untrimmed name it came from.
function stripTrailingJunk(t) {
  // Only at the very end, which is where a codec fragment leaves it: "DDP5 H
  // 264" leaves "H 264" behind once the tags themselves are gone. Two or three
  // digits, because four of them is a year and "M 1931" is a film.
  var letters = t.replace(/\b[A-Za-z]\s+\d{2,3}$/, " ");
  // A trailing token with no word character in it goes too: removing "DISNEY"
// from "DISNEY+" leaves a "+", and "Show WEB- +" used to be searched for with
// the stray signs attached. Only at the end, because a hyphen in the middle is
// part of a title ("Frieren - Beyond Journey's End").
var words = letters.split(" ").filter(function(w) { return w; });
  while (words.length > 1) {
    var raw = words[words.length - 1];
    var last = raw.toLowerCase().replace(/[^\w]/g, "");
    if (!/[a-z0-9]/i.test(raw)) { words.pop(); continue; }
    if (!TRAILING_JUNK[last] && !/^\d{1,3}$/.test(last)) break;
    var kept = words.pop();
    var allWeak = words.every(function(w) {
      return TITLE_LESS_WORDS[w.toLowerCase().replace(/[^\w]/g, "")];
    });
    if (allWeak) { words.push(kept); break; }
  }
  return words.join(" ").trim();
}

function fileNameFromUrl(url) {
  if (!url) return "";
  var s = String(url);
  try { s = decodeURIComponent(s); } catch(e) {}
  // Drop query/fragment, then take the last path segment.
  s = s.split("#")[0].split("?")[0];
  var parts = s.split("/");
  return parts[parts.length - 1] || "";
}

// "Show Name S01E02" → {season:1, episode:2}
function parseEpisodeCode(base) {
  // seasonFromName records whether the season was actually written in the
  // filename or merely assumed. The absolute-number convention carries no
  // season at all, and for "Show/Season 2/05.mkv" the directory is a better
  // authority than that assumption, but it must never override a season the
  // filename states outright.
  var pats = [
    // S01E02, s1e2, S01.E02, S01E02E03 (multi-episode pack)
    //
    // The boundaries are spelled out rather than written \b: an underscore is
    // a word character, so \b cannot match between "_" and "S" and every
    // scene-style "Show_Name_S02E05_1080p" fell through to the bare-number
    // pattern below, which then read the "1" out of "DDP5_1" and called the
    // episode 1. The far end cannot be \b either: it fails between "05" and
    // "_".
    { re: /(?:^|[^A-Za-z0-9])S(\d{1,3})[\s._-]*E(\d{1,3})(?:\s*[-_]?\s*E?(\d{1,3}))?(?![0-9A-Za-z])/i,
      map: function(m) { return { season:+m[1], episode:+m[2], extra: m[3] ? +m[3] : null, seasonFromName: true }; } },
    // 1x02
    // No lookbehind here or below: it needs Safari 16.4, and the README
    // promises macOS 12. A non-capturing alternation does the same job and
    // keeps the group numbering intact, which is what map() relies on.
    { re: /(?:^|[^\d])(\d{1,2})x(\d{1,3})(?:\s*[-_]\s*(\d{1,3}))?(?!\d)/i,
      map: function(m) { return { season:+m[1], episode:+m[2], extra: m[3] ? +m[3] : null, seasonFromName: true }; } },
    // Season 1 Episode 2
    { re: /(?:^|[^A-Za-z0-9])Season[\s._-]*(\d{1,3})[\s._-]*Episode[\s._-]*(\d{1,3})(?![0-9A-Za-z])/i,
      map: function(m) { return { season:+m[1], episode:+m[2], extra:null, seasonFromName: true }; } },
    // "Naruto.Shippuuden.E484.720p", the anime convention of marking the episode
    // with a bare E and no season. Four digits, because long-running series
    // pass 999: One Piece is into the 1100s.
    { re: /(?:^|[\s._-])E(\d{1,4})(?:[\s._-]|$)/i,
      map: function(m) { return { season:1, episode:+m[1], extra:null, seasonFromName:false, marker:"E" }; } },
    // A season with no episode in the name: a season pack, or a pack-style
    // filename ("Severance.S02.COMPLETE.1080p"). The show can still be
    // identified and the right season opened, which is the whole point of
    // reading it at all, so the episode is left null rather than invented.
    { re: /(?:^|[\s._-])S(\d{1,3})(?![0-9A-Za-z])/i,
      map: function(m) { return { season:+m[1], episode:null, extra:null, seasonFromName: true }; },
      seasonOnly: true },
    { re: /(?:^|[^A-Za-z0-9])Season[\s._-]*(\d{1,3})(?![0-9A-Za-z])/i,
      map: function(m) { return { season:+m[1], episode:null, extra:null, seasonFromName: true }; },
      seasonOnly: true },
    // A number in the middle of the name, between separators, as the anime
    // "- 05 -" convention writes it:
    // "AnimePahe_Nippon_Sangoku_-_05_1080p_Amazon". Both sides must be a dash
    // or underscore, which is what keeps "500 Days of Summer" (space
    // delimited), "1080p", "x264" and "DDP5" out. No start-of-string case: it
    // exists to catch "9-1-1" as episode 9, and 9-1-1 is a television series.
    { re: /[-_][-]?\s*(\d{1,3})(?:[-_]|$)/,
      map: function(m) { return { season:1, episode:+m[1], extra:null, seasonFromName:false }; },
      check: function(base, m) {
        // "DDP5_1" ends in "_1_", which the pattern above matches exactly, and
        // an episode 1 invented from a codec tag is worse than no episode at
        // all. A number only counts when it starts a fresh token, which the
        // character in front of its delimiter decides: a letter or digit
        // there means the delimiter belongs to something longer. That also
        // rejects "9-1-1", whose first group hangs off the title's own digits.
        return !/[A-Za-z0-9]/.test(base.charAt(m.index - 1)); } },
    // "Show Name - 12", an absolute episode number: the common anime/scene
    // convention. Anchored to the end so a year can't be mistaken for one.
    // Four digits, because a long-running series is the case this pattern
    // exists for: "[Erai-raws] One Piece - 1062" is episode 1062, and capped
    // at three it was read as no episode at all, which then showed One Piece
    // season 1. The year guard below is what keeps 1917 and 2019 out.
    { re: /^(.*?)[\s._-]+[-]?\s*(\d{1,4})(?:v\d)?$/i,
      map: function(m) { return { season:1, episode:+m[2], extra:null, seasonFromName: false }; } }
  ];
  for (var i = 0; i < pats.length; i++) {
    var m = base.match(pats[i].re);
    // A pattern can match text it is not allowed to claim: see check above.
    // Fall through to the next pattern rather than giving up, so a name that
    // trips one guard can still be read by another.
    if (m && pats[i].check && !pats[i].check(base, m)) continue;
    if (m) {
      var r = pats[i].map(m);
      // An episode is required unless the pattern says otherwise: only a bare
      // season carries none, and every other pattern matching here is a claim
      // about the episode number.
      if ((!pats[i].seasonOnly && !r.episode) || r.episode < 0) return null;
      // A bare 4-digit year is a movie date, not an episode number. Applied
      // to every pattern rather than one, so that inserting a pattern above
      // cannot quietly leave this guard pointing at the wrong one.
      if (r.episode >= 1900 && r.episode <= 2099) return null;
      if (!r.season || r.season < 0) r.season = 1;
      return r;
    }
  }
  return null;
}

// Strip the episode code and everything that isn't the title.
function cleanTitle(base, code) {
  // Normalise separators FIRST. Scene names are mostly underscores, and a
  // word-boundary anchor fails between "_" and "S" (both word characters), so
  // "Band_of_Brothers_S01E04" would otherwise keep its episode code in the
  // title. Converting to spaces up front makes every pattern below work on
  // ordinary space-separated text.
  // The extension has already come off in parseFilename, so this is a second
  // pass for callers that hand over a whole filename. It has to require a
  // leading letter: "Show.1062" is an episode number, and "[a-z0-9]{2,4}"
  // matched the digits and deleted the episode from the title.
  var t = base.replace(/\.[a-z][a-z0-9]{1,3}$/i, "");
  t = t.replace(/[._]+/g, " ").replace(/\s+/g, " ").trim();

  // Bracket groups usually hold the noise ("[1080p]", "[SubsPlease]").
  t = t.replace(/\[[^\]]*\]/g, " ").replace(/\([^)]*\)/g, " ");
  // Trailing "-GROUP" release tag. Only when at least two words would be
  // left: the pattern cannot tell a release tag from the second half of a
  // hyphenated title, so unguarded it turned "Spider-Man" into "Spider" and
  // left "X-Men" with no title at all.
  var hyphen = t.match(/^(.+?)\s*-\s*[A-Za-z0-9]+\s*$/);
  if (hyphen && hyphen[1].trim().split(/\s+/).length >= 2) t = hyphen[1];
  // CJK characters only ever appear in scene tags, never in a title we can
  // search TMDB with.
  t = t.replace(/[\u3000-\u9fff\uf900-\ufaff\uff00-\uffef]/g, " ");

  if (code) {
    t = t.replace(/\bS\d{1,3}[\s-]*E\d{1,3}(?:[\s-]*E?\d{1,3})?\b/i, " ");
    // A bare season, which is all a season pack has: "Severance S02 1080p".
    if (code.episode === null) {
      t = t.replace(/(?:^|[\s._-])S\d{1,3}(?![\s-]*E\d)/i, " ");
      t = t.replace(/(?:^|[^A-Za-z0-9])Season[\s._-]*\d{1,3}(?![\s-]*Episode)/i, " ");
    }
    t = t.replace(/(?:^|[^\d])\d{1,2}x\d{1,3}(?:\s*[-\s]\s*\d{1,3})?(?!\d)/i, " ");
    t = t.replace(/\bSeason[\s-]*\d{1,3}[\s-]*Episode[\s-]*\d{1,3}\b/i, " ");
    // The bare "E484" anime marker, which has no season to key off.
    t = t.replace(/(?:^|[\s._-])E\d{1,4}(?:[\s._-]|$)/i, " ");
    // Trailing absolute episode number ("Show Name - 12"). Four digits, because
    // that is how a long-running series writes it ("One Piece 1062"), and
    // leaving it capped at three kept the number in the title and cost a wasted
    // search. The year guard keeps "1917" and "2019" as titles.
    t = t.replace(/[\s-]+[-]?\s*\d{1,4}(?:v\d)?$/i, function (m) {
      var n = parseInt(m.replace(/[^\d]/g, ""), 10);
      if (n >= 1900 && n <= 2099) return m;
      return " ";
    });
  }

  // Channel specs must go before digits turn into separate words, and without
  // a leading \b so "DDP5.1" is caught as well as a standalone "5.1".
  t = t.replace(/\d[.]\d(?!\d)/g, " ");
  t = t.replace(/\b\d{3,4}[pi]\b/gi, " ");          // 1080p 720p
  t = t.replace(/\b\d{3,4}x\d{3,4}\b/g, " ");        // 1920x1080
t = t.replace(JUNK_RE, " ");
  t = t.replace(/\s+/g, " ").trim();

  // Order matters here. Trailing noise comes off before the year, not after:
  // "Alien 1979 REMASTERED" only ends in a year once REMASTERED has gone, and
  // the year strip is $-anchored on purpose, because "Blade Runner 2049" and
  // "1917" are titles and a year removed from anywhere but the end takes them
  // apart.
  t = stripTrailingJunk(t);
  // Tolerate trailing space: the strips above leave it.
  t = t.replace(/\s*[\(\[]\s*(19|20)\d{2}\s*[\)\]]/g, " ");
  t = t.replace(/\s+(19|20)\d{2}\s*$/, " ");
  t = t.replace(/\s+/g, " ").trim();
  // And again, for the junk the year removal exposed.
  t = stripTrailingJunk(t);

  // Separators left dangling by the removals ("Breaking Bad -").
  return t.replace(/^[\s\-\u2013\u2014:]+|[\s\-\u2013\u2014:]+$/g, "").trim();
}
