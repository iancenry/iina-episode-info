// ── Bracket groups ─────────────────────────────────────────────────
// Fansub-style names put the series in the leading bracket group, because for
// a fansub the group name *is* the series:
//
//   [One Pace][1062-1063] Egghead 04 [1080p][En Sub][FD5592BE].mp4
//
// cleanTitle has to delete every bracket group to strip the noise, so the
// series name goes with it. What survives is "Egghead 04", and the plugin
// ends up searching for the wrong show entirely. The groups are therefore
// collected before the stripping and offered to the search as candidates of
// their own.

// Split into "looks like a series name" and "probably a tag". A multi-word
// group is treated as the former, which covers "One Pace" and "Frieren:
// Beyond Journey's End" while stepping over the run-on tags fansubs use for
// the same slots ("SubsPlease", "EMBER", "Anime-Raws"). Single-word groups are
// still worth having, because "[Frieren] - 05.mkv" is real, but only once the
// filename's own title has had its turn, since they are far more often a tag.
function bracketTitles(base) {
  var strong = [], weak = [], m;
  var re = /\[([^\]]+)\]/g;
  while ((m = re.exec(base)) !== null) {
    var t = cleanTitle(m[1], null);
    if (!isRealTitle(t)) continue;
    // No letters at all: an episode range such as "[1062-1063]", not a name.
    if (!/[a-z]/i.test(t)) continue;
    // A CRC32 checksum, e.g. "[FD5592BE]": hex letters only, and at least one
    // digit. Requiring the digit is what keeps real words out: every English
    // word made only of the letters a-f is short, but "Decade", "Facade" and
    // "Beaded" were all being discarded as checksums.
    var squashed = t.replace(/\s/g, "");
    if (/^[0-9a-f]{6,8}$/i.test(squashed) && /[0-9]/.test(squashed)) continue;
    // A group made entirely of track labels: "[Dual Audio]", "[Multiple
    // Subtitles]". Multi-word groups are otherwise taken as series names, and
    // these are searched before the filename's own title.
    var noise = true;
    t.split(/\s+/).forEach(function(w) {
      if (!BRACKET_NOISE[w.toLowerCase().replace(/[^\w]/g, "")]) noise = false;
    });
    if (noise) continue;
    var bucket = /\s/.test(t) ? strong : weak;
    if (bucket.indexOf(t) === -1) bucket.push(t);
  }
  return { strong: strong, weak: weak };
}

// An absolute episode number from inside a bracket group: "[1062-1063]".
// Three digits or more is past anything a season/episode code can express, and
// TMDB gives no reliable way to map it. Season 20 of One Piece might be
// episode 1000 or episode 1010 depending on how the split falls.
// "[Group][12][1080p]" writes the episode inside a bracket, where the bracket
// stripping below would destroy it before any pattern could see it.
function episodeFromBrackets(base) {
  var m, re = /\[([^\[\]]+)\]/g;
  while ((m = re.exec(base)) !== null) {
    if (/^\d{1,3}$/.test(m[1].trim())) return parseInt(m[1], 10);
  }
  return null;
}

// Vertical resolutions, which a bare bracket group is far more likely to hold
// than an episode number. "Show.S01E05.[1080].mkv" put the resolution in
// brackets and the code in the name; reading the bracket as the episode
// invented episode 1080 and, because an absolute number suppresses the
// filename's own code, lost S01E05 as well. Fansub layouts do the same:
// "[Group][Show Name][01][1080]".
var RESOLUTION_VALUES = {
  480: 1, 540: 1, 576: 1, 720: 1, 1080: 1, 1440: 1, 2160: 1, 4320: 1, 8640: 1
};

function absoluteFromBrackets(base) {
  var m, re = /\[([^\]]+)\]/g;
  while ((m = re.exec(base)) !== null) {
    // Only a group made purely of digits and separators can be an episode
    // number. "[1080p]", "[DDP5.1]" and "[FD5592BE]" all carry other
    // characters, and reading any of those as 1080 would throw away a
    // perfectly good episode code.
    if (!/^[\d\s\-–—_,]+$/.test(m[1])) continue;
    var nums = m[1].match(/\d{3,4}/g);
    if (!nums) continue;
    // "[1080-1920]" is a resolution pair, and reading it as episode 1080 also
    // suppresses the filename's real episode code. Judged on the aspect ratio
    // rather than a doubling: 1920/1080 is 1.78, so 1080 * 2 = 2160 never
    // matched. A range like "[1062-1063]" has a ratio of about 1 and is left
    // alone.
    if (nums.length === 2 && /^[\s\-–—_,]+$/.test(m[1].replace(/\d{3,4}/g, ""))) {
      var pair = nums.map(function (x) { return parseInt(x, 10); }).sort(function (x, y) { return x - y; });
      var ratio = pair[0] ? pair[1] / pair[0] : 0;
      if (pair[0] >= 480 && ratio >= 1.3 && ratio <= 2.2) continue;
    }
    for (var i = 0; i < nums.length; i++) {
      var n = parseInt(nums[i], 10);
      if (n < 1000) continue;
      // One number on its own and it is a resolution, not an episode. "[1062]"
      // is still an episode, because 1062 is not a resolution.
      if (nums.length === 1 && RESOLUTION_VALUES[n]) continue;
      // The air year in brackets is the commonest thing in this slot for a
      // fansub ("[Doki] Show - 01 [1920x1080][BDRip][2011][JSC]"), and reading
      // it as an episode suppressed the filename's own code and made every
      // query look for a film. parseEpisodeCode refuses a year for the same
      // reason.
      if (n >= 1900 && n <= 2099) continue;
      return n;
    }
  }
  return null;
}

// The most recent parse, kept so the pin writer can ask which directory
// supplied the title without parsing the URL a second time.
var currentParsed = null;

function parseFilename(url) {
  var fname = fileNameFromUrl(url);
  if (!fname) return null;
  var base = fname.replace(/\.[a-z0-9]{2,4}$/i, "");

  // "05 - Hello, Ms. Cobel.mkv" and "05. Hello, Ms. Cobel.mkv" are how library
  // tools lay out an episode when the season lives in the directory: the
  // counter leads and the episode name follows it. The name is metadata, not a
  // series, so it is taken off rather than searched. Left in place it read as a
  // real title, which stopped the directory from ever being consulted and left
  // nothing to identify.
  //
  // Only with a directory to supply the show, though. The shape is also how
  // people name their own files, "01 - Christmas 2019.mp4", and outside a
  // season folder there is nothing above it, so stripping it left "Christmas"
  // as a film title to search for, on a file that should have been ignored.
  // Computed here rather than where it was needed because it decides whether
  // the counter is read at all.
  var hints = parseFolderHints(url);
  var leading = hints ? /^\d{1,3}\s*[-.\u2013\u2014]\s+(?=\S)/.exec(base) : null;
  if (leading) base = base.slice(leading[0].length);

  // An IMDb id in the name identifies the title outright, so it is worth
  // carrying: it replaces the whole title ladder with a single lookup. Some
  // scene releases and most library rips include one. Matched against the
  // extension-free name, because the id is then removed from the same string:
  // matching it in the name with the extension still attached made the removal
  // a no-op whenever the id ended the basename, and "imdb tt11280740" stayed in
  // the title.
  var imdb = /(?:^|[^a-z0-9])(tt\d{7,8})(?:[^0-9]|$)/i.exec(base);
  var imdbId = imdb ? imdb[1].toLowerCase() : null;

  // A date, not an episode and not a release year. "The Daily Show - 2023-01-15"
  // is a daily show named after the day it aired, and Plex writes it that way.
  // Removed before anything reads the name: left in, the year made the file look
  // like a film so every query went to search/movie, and the trailing number
  // pattern read the "15" as episode 15.
  base = base.replace(/(?:^|[^\d])(?:19|20)\d{2}[.\-]\d{2}[.\-]\d{2}(?!\d)/g, " ").trim();

  // Collected before the stripping below, which is what destroys them.
  var altTitles = bracketTitles(base);
  var absolute = absoluteFromBrackets(base);
  var code = null;

  // Brackets usually hold the noise ("[1080p]", "[SubsPlease]") and would
  // otherwise defeat the end-anchored absolute-episode pattern.
  var stripped = base.replace(/\[[^\]]*\]/g, " ")
                     .replace(/\([^)]*\)/g, " ")
                     .replace(/[._]+/g, " ")
                     .replace(/\s+/g, " ").trim();

  // An absolute number in a bracket group makes the trailing small number
  // meaningless rather than an episode code: in
  // "[One Pace][1062-1063] Egghead 04 [...]" that "04" is the fansub's own
  // counter, and trusting it would show "One Piece S01E04" for episode 1062.
  // The series is still worth identifying, so the episode is dropped and the
  // picker is left for the user.
  //
  // The numeric version is tried first. Channel specs and codec fragments end
  // the name and carry digits the absolute-number pattern would otherwise read
  // as an episode: "DDP5.1" leaves a trailing 1, "H.264" leaves 264. They have
  // to go before the separators are flattened, because afterwards "DDP5.1" is
  // indistinguishable from "DDP5 1".
  // Kept with its separators intact. The mid-string episode pattern anchors on
  // "-" and "_", so a name whose digits are delimited by those has to be read
  // before they are flattened to spaces.
  var numRaw = base
    // The chain is matched whole, not up to its first digit: "DTS-HD.MA.5.1"
    // stopped at the 5 and left a ".1" that then read as episode 1.
    .replace(/\bDDP?[0-9](?:\.[A-Za-z0-9]{1,3})*\.[0-9](?![0-9])/gi, " ")
    .replace(/\bDTS(?:-HD)?(?:\.[A-Za-z0-9]{1,3})*\.[0-9](?![0-9])/gi, " ")
    .replace(/\bDTS-?HD(?:\.[A-Za-z0-9]{1,3})*\b/gi, " ")
    // The same chain written with underscores: "DDP5_1", "AAC2_0",
    // "DTS-HD_MA_5_1". A codec-shaped tag has to lead, so "Show_1_2" keeps its
    // numbers; and the trailing digit is not allowed to run into another, so
    // "DDP5_10" keeps its 10. No closing \b: an underscore is a word character,
    // so it cannot match between that digit and the underscore in "_1_atmos",
    // which left this rule matching nothing at all and the episode number being
    // read out of the spec instead.
    .replace(/\b(?:DD|DD[P5]?|DTS(?:[-_]HD)?|E?AC-?3|AAC|TRUEHD|FLAC|OPUS|ATMOS)[0-9]?(?:[._-][A-Za-z0-9]{1,3})*[._-][0-9](?![0-9])/gi, " ")
    .replace(/\b[0-9](?:\.[A-Za-z0-9]{1,3})*\.[0-9](?![0-9])\b/g, " ")  // a bare "5.1"
    .replace(/\bH\.[0-9]{3}\b/gi, " ")
    .replace(/\bX26[45]\b/gi, " ")
    .replace(/\bHEVC\b/gi, " ");
  var numStripped = numRaw
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/[._]+/g, " ")
    .replace(/\s+/g, " ").trim();
  if (absolute === null) {
    // Never the raw name. Falling back to it is what produced the DDP5.1 bug:
    // the cleaned form has no episode, then the raw one finds the trailing "1"
    // and invents episode 1.
    code = parseEpisodeCode(numRaw) || parseEpisodeCode(numStripped);
    if (!code) {
      var bracketed = episodeFromBrackets(base);
      if (bracketed !== null) {
        code = { season: 1, episode: bracketed, extra: null, seasonFromName: false };
      }
    }
  }

  // A four-digit absolute number is past anything a season can express, so it
  // is located by adding up the show's seasons rather than being read as season
  // 1. "[Erai-raws] One Piece - 1062" is episode 1062, which for One Piece is
  // season 20; reporting S01E1062 is a number no season list has.
  //
  // It only counts when something is left to search for. A camera file is
  // "IMG_1234.MOV": one short word and four digits, which is the same shape,
  // and every photo and clip in a personal library then identified itself as
  // episode 1234 of a show called IMG.
  if (code && !code.seasonFromName && code.episode >= 1000) {
    var attributable = code.marker === "E" ||
      cleanTitle(base, code).split(/\s+/).filter(Boolean).length > 1;
    if (attributable) {
      absolute = code.episode;
      code = null;
    } else {
      // A number too big for any season, in a name with nothing else in it.
      // That is a camera file, not an episode, so no episode is claimed.
      code = null;
    }
  }

  // A file called "05.mkv" holds an episode number with nothing in front of
  // it, which the absolute-number pattern needs. Only one to three digits:
  // "1917" is a film and must stay a title.
  if (!code && /^\d{1,3}$/.test(stripped)) {
    code = { season: 1, episode: parseInt(stripped, 10), extra: null, seasonFromName: false };
  }

  // …and the counter that led the filename, taken off above.
  if (!code && leading) {
    code = { season: 1, episode: parseInt(leading[0], 10), extra: null, seasonFromName: false };
  }

  // The id is not part of the name, and leaving it in would pollute the title
  // for the ladder in case the id lookup misses.
  // Cleaned from numRaw, not base. The leftover "1" of "DDP5.1" survives as a
  // bare trailing token, which then blocks the $-anchored year strip and left
  // titles reading "Movie Title 2019".
  var title = cleanTitle(imdbId ? numRaw.replace(imdb[0], " ") : numRaw, code);
  // …and an absolute number is not an episode code either, so it stays in the
  // title unless it is taken off here. "One Piece 1062" searched for itself
  // before the ladder got to "One Piece".
  if (absolute !== null) {
    title = title.replace(new RegExp("[\\s.-]*" + absolute + "v?\\d*$"), " ").trim();
  }

  // Set only when the directory supplied the title. A title the filename gave
  // on its own is not pinned: in a flat library the parent directory is
  // usually the whole media folder, and pinning that to one show would be
  // actively wrong.
  var titleDir = "";
  if (hints) {
    // The directory supplies a title when the filename has none to give, or
    // when all it offers is a number or a placeholder word like "Episode".
    //
    // …or when the filename is in the leading-counter layout, where what
    // follows the counter is the episode's name rather than the show's. It
    // reads as a real title, which would keep the directory from ever being
    // asked, and every file in a season folder would then be searched for by
    // its own episode name.
    if (leading || !isRealTitle(title)) { title = hints.title; titleDir = hints.dir; }
    // …and a season, but only where the filename did not state one.
    if (code && hints.season !== null && !code.seasonFromName) {
      code = { season: hints.season, episode: code.episode, extra: code.extra, seasonFromName: false };
    }
  } else if (isPlaceholderTitle(title)) {
    // Nothing to replace it with. Searching TMDB for "Episode" finds nothing
    // worth showing, so the file is handed to the manual search instead.
    title = "";
  }

  // The filename can hold nothing but bracket groups, which cleanTitle then
  // deletes: "[Jujutsu Kaisen][47][AVC-8bit][1080p].mkv" has no title left, and
  // the series name that bracketTitles had already recovered was discarded
  // with it. Fall back to it.
  //
  // A single-word bracket group is used, and where there are several the LAST one
  // is the best guess: fansubs put the release group first and the series beside
  // the number, so "[Group][Show][01][1080]" is a show called "Show". Taking the
  // first one showed a series called "Group", which is the wrong answer rather
  // than no answer. Every group stays in the candidate ladder, so the ordering
  // only decides what is asked first; titleScore still decides what is kept.
  if (!title || title.length < 2) {
    if (altTitles.strong.length) title = altTitles.strong[0];
    else if (altTitles.weak.length) title = altTitles.weak[altTitles.weak.length - 1];
  }

  // A release year, which is how a film is told apart from a TV episode: no
  // episode code, but a year in the name. Resolutions and channel specs are
  // removed first so "1920x1080" can't be read as the year 1920.
  var yearSrc = base.replace(/\b\d{3,4}[pi]\b/gi, " ")
                    .replace(/\b\d{3,4}x\d{3,4}\b/g, " ")
                    .replace(/\d[.]\d(?!\d)/g, " ");
  // Take the LAST year, not the first: in "1917.2019.1080p" the title is the
  // number and the release year is the one after it.
  var years = yearSrc.match(/(?:^|[^\d])((?:19|20)\d{2})(?=[^\d]|$)/g) || [];
  var year = null;
  if (years.length) {
    year = parseInt(years[years.length - 1].replace(/[^\d]/g, ""), 10);
  }

  // Three digits is usually a counter that found its way into the title slot,
  // and searching TMDB for "01" returns nothing usable. Four digits is
  // different: 1917 and 2001 are real titles. So are some of the shorter ones
  // once something else says what they are: "300.2006" and "24.S01E01" are a
  // film and a series respectively, and a title equal to its own episode
  // number is a counter with nothing to identify.
  var digits = /^\d{1,3}$/.test(title);
  var counter = digits && code && Number(title) === code.episode;
  if (digits && (counter || !(code || year))) return null;

  // One character is a title as well: "M" (1931) and "9" (2006) are both films.
  // With nothing else to go on it is far more likely to be a leftover, which is
  // what the two lines above have already established.
  if (!title || (title.length < 2 && !year)) return null;


  // One object, shared. This used to be written out twice into two variables,
  // which meant a caller mutating the result also changed currentParsed behind
  // it, and every added field had to be added in two places.
  var parsed = {
    fileName: fname, title: title, code: code, year: year, imdbId: imdbId,
    // Series names recovered from bracket groups, and the absolute episode
    // number that made the filename's own episode code untrustworthy.
    altTitles: altTitles, absolute: absolute, titleDir: titleDir,
    // No episode code but a year: almost certainly a film.
    isMovie: !code && !!year
  };
  currentParsed = parsed;
  return parsed;
}

function autoCancelTimer() {
  if (autoTimerId !== null) { clearTimeout(autoTimerId); autoTimerId = null; }
}

// Release-group names are effectively unbounded ("BlueMovie", "NTb", "Raws",
// …), so enumerating them can't work. Instead we hand TMDB a series of
// progressively shorter prefixes of the parsed title and stop at the first
// one that returns anything: full title, then dropping one trailing word at a
// time down to the first word. For "Pantheon - 6CH SoftSub BlueMovie" that
// walks all the way down to "Pantheon".
function titleCandidates(title) {
  var words = String(title).split(/\s+/).filter(Boolean);
  var out = [];
  function push(s) {
    s = s.replace(/^[\s\-–—:.]+|[\s\-–—:.]+$/g, "").trim();
    if (s.length >= 2 && out.indexOf(s) === -1) out.push(s);
  }
  for (var i = words.length; i >= 1; i--) push(words.slice(0, i).join(" "));
  // Never fall back to a bare article, because TMDB would return every show
  // starting with "The" and we'd pick one at random.
  return out.filter(function(s) {
    return !/^(the|a|an|of|and|to|in|on)$/i.test(s);
  });
}

// Below this, the result does not look like the thing that was asked for, so
// the ladder keeps descending instead of committing.
var AUTO_MIN_SCORE = 0.6;
// Below this, a result is unrelated and is not used even as a last resort.
var AUTO_WEAK_SCORE = 0.34;

// How well a result's name matches the query that found it, from 0 to 1.
// TMDB's search is forgiving: a query carrying leftover noise happily
// returns a show that merely starts the same way, and taking the highest
// vote count then locks in the wrong series for the rest of the session.
function titleScore(query, name) {
  var q = normalizeForMatch(query), n = normalizeForMatch(name);
  if (!q || !n) return 0;
  if (q === n) return 1;
  var qs = q.split(" "), ns = n.split(" ");
  // Token prefix, never a raw string prefix. The ladder exists to send
  // progressively shorter prefixes, so "Severance" matching "Severance: The
  // Office" is the design working. But "Man" is also a string prefix of
  // "Maniac Mansion", and matching that is not. Comparing whole words keeps
  // the first case and drops the second.
  //
  // A word-prefix match is always accepted, and the penalty only ranks a long
  // result against a short one. That is deliberate: a one-word candidate
  // finding a six-word show is what a prefix ladder is for, so there is no
  // score here that should talk the ladder out of it.
  // The direction matters, and getting it wrong turned the penalty into a
  // bonus: a two-word candidate against a one-word result computed
  // 0.9 - 0.2 * (1 - 2) and scored 1.1, outside the documented 0 to 1.
  // A longer result means the candidate is a shortened prefix, which the ladder
  // produced on purpose. A shorter result means the candidate overshot, and
  // earns no bonus for it.
  // …and the whole candidate, not just its first word. Matching on one token
  // made "One Pace" a 0.83 match for "One Piece: Clockwork", because both start
  // with "one" even though the second word disagrees; comparing the leading run
  // sends that one down to the spelling check below.
  var shared2 = 0;
  while (shared2 < qs.length && shared2 < ns.length && qs[shared2] === ns[shared2]) shared2++;
  if (shared2 === qs.length) {
    // Every candidate word matched in order, so the candidate is a shortened
    // prefix of the real title: "Severance" for "Severance: The Office". That
    // is what the ladder is for, so it always wins, discounted only by how much
    // extra name came back.
    //
    // qs cannot be longer than ns here: the loop above only completes if it ran
    // out of result tokens last, so ns.length >= qs.length and the difference
    // is never negative. An earlier version guarded against that with a ternary
    // whose false branch was unreachable.
    var extra = ns.length - qs.length;
    return extra > 0 ? 0.9 - 0.2 * (extra / ns.length) : 0.9;
  }
  // Token overlap, so "Office US" still matches "The Office US" without the
  // articles getting in the way. Counted over de-duplicated sets: a repeated
  // word used to be counted twice, which could push the ratio above 1 for a
  // result like "Piece One One" against "One Piece".
  var qset = {}, nset = {}, qn = 0, nn = 0, i, k;
  for (i = 0; i < qs.length; i++) { k = "$" + qs[i]; if (!qset[k]) { qset[k] = 1; qn++; } }
  for (i = 0; i < ns.length; i++) { k = "$" + ns[i]; if (!nset[k]) { nset[k] = 1; nn++; } }
  var shared = 0;
  for (k in qset) if (nset[k]) shared++;
  var union = qn + nn - shared;
  var jaccard = union ? shared / union : 0;
  if (jaccard >= AUTO_MIN_SCORE) return jaccard;
  // Too little in common to be the same name on token overlap alone. Before
  // giving up, measure how close the two are character by character: fansubs
  // routinely spell a series slightly wrong. The One Piece group calls itself
  // "One Pace", scoring 0.33 on tokens, which would send the ladder
  // straight past the right answer.
  if (q.length >= 5 && n.length >= 5) {
    var capped = Math.min(1, levSim(q, n) * 0.95);
    return Math.max(jaccard, capped);
  }
  return jaccard;
}

// 1 = identical, 0 = nothing alike. Only ever called on short strings, so the
// full matrix costs nothing worth avoiding.
function levSim(a, b) {
  if (a === b) return 1;
  var m = a.length, n = b.length;
  if (!m || !n) return 0;
  var prev = [], cur = [], i, j;
  for (j = 0; j <= n; j++) prev[j] = j;
  for (i = 1; i <= m; i++) {
    cur[0] = i;
    for (j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1)
      );
    }
    var swap = prev; prev = cur; cur = swap;
  }
  return 1 - prev[n] / Math.max(m, n);
}

function normalizeForMatch(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    // Leading articles vary between a filename and a TMDB name, so they are
    // not part of the identity of the title.
    .replace(/\b(the|a|an|of|and|to|in|on|with|for)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
