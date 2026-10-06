// ── Your own scene marks ──────────────────────────────────────
// For the titles (and scenes) the databases have not timed: mark the trigger
// at the playhead, then mark the end once playback reaches it — or save it as
// warn-only. Marks attach to the current identification and ride the plugin's
// cue pipeline like a database scene, minus the attribution.
//
// The workflow borrows from SponsorBlock submissions: a segment has a start
// and an end, either captured live or typed, and every mark can be previewed
// from just before its start and just before its landing so the skip can be
// checked for seamlessness before trusting it.
var markPending = null;   // seconds of a trigger waiting for its end
var markEdit = null;      // { index, start, safe } while the inline editor is open

function fmtMarkTime(sec) {
  var s = Math.max(0, Math.floor(Number(sec) || 0));
  var h = Math.floor(s / 3600);
  var m = Math.floor((s % 3600) / 60);
  var ss = s % 60;
  var mm = h ? (m < 10 ? "0" : "") + m : String(m);
  return (h ? h + ":" : "") + mm + ":" + (ss < 10 ? "0" : "") + ss;
}

// mm:ss, h:mm:ss, or plain seconds. Anything else reads as null.
function parseMarkTime(str) {
  var s = String(str == null ? "" : str).trim();
  if (!s) return null;
  var m = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(s);
  if (m) {
    var h = m[1] ? parseInt(m[1], 10) : 0;
    var mm = parseInt(m[2], 10);
    var ss = parseInt(m[3], 10);
    if (ss > 59 || mm > 59) return null;
    return h * 3600 + mm * 60 + ss;
  }
  if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s);
  return null;
}

function paintMarkPending() {
  var el = document.getElementById("ddd-mark-pending");
  var btn = document.getElementById("ddd-mark-trigger");
  var scan = document.getElementById("ddd-mark-scan");
  if (!el || !btn) return;
  if (markPending == null) {
    el.style.display = "none";
    el.innerHTML = "";
    btn.style.display = currentMarkInfo() ? "block" : "none";
    btn.textContent = "+ Mark trigger at playhead";
    if (scan) scan.style.display = currentMarkInfo() ? "block" : "none";
    return;
  }
  el.style.display = "block";
  el.innerHTML = '<div style="margin-bottom:5px">Trigger at <b style="color:#fff">' +
    fmtMarkTime(markPending) + '</b> — play on, then mark the end.</div>' +
    '<button class="mark-btn" onclick="doPreviewPending()" title="Play from 5 seconds before the trigger">\u25B6 Check start</button>' +
    '<button class="mark-btn" onclick="doMarkSafe()">Set end here</button>' +
    '<button class="mark-btn" onclick="doMarkWarnOnly()">Warn only</button>' +
    '<button class="mark-btn" onclick="doMarkCancel()">Cancel</button>';
  btn.style.display = "none";
  if (scan) scan.style.display = "none";
}

function markActionOf(m) {
  return (m && (m.action === "warn" || m.action === "auto" || m.action === "silent"))
    ? m.action : "skip";
}

function markEditorHtml() {
  return '<div class="mark-edit">' +
    '<div class="mark-edit-row"><span class="mark-edit-lbl">Title</span>' +
      '<input id="mark-edit-label" type="text" value="' + htmlEsc(markEdit.label) + '" placeholder="your mark" maxlength="60" /></div>' +
    '<div class="mark-edit-row"><span class="mark-edit-lbl">Start</span>' +
      '<input id="mark-edit-start" type="text" value="' + htmlEsc(fmtMarkTime(markEdit.start)) + '" />' +
      '<button class="mark-btn" onclick="doEditUsePlayhead(\'start\')">Use playhead</button></div>' +
    '<div class="mark-edit-row"><span class="mark-edit-lbl">End</span>' +
      '<input id="mark-edit-end" type="text" value="' +
        (markEdit.safe != null ? htmlEsc(fmtMarkTime(markEdit.safe)) : "") +
        '" placeholder="empty = warn only" />' +
      '<button class="mark-btn" onclick="doEditUsePlayhead(\'end\')">Use playhead</button></div>' +
    '<div class="mark-edit-row"><span class="mark-edit-lbl">Type</span>' +
      '<button class="mark-btn mark-type' + (markEdit.action === "silent" ? " on" : "") + '" onclick="doEditType(\'silent\')" title="Kept in the list, never shows a card">Silent</button>' +
      '<button class="mark-btn mark-type' + (markEdit.action === "warn" ? " on" : "") + '" onclick="doEditType(\'warn\')" title="Card only, no skip button">Warn</button>' +
      '<button class="mark-btn mark-type' + (markEdit.action === "skip" ? " on" : "") + '" onclick="doEditType(\'skip\')" title="Card with a skip button">Skip</button>' +
      '<button class="mark-btn mark-type' + (markEdit.action === "auto" ? " on" : "") + '" onclick="doEditType(\'auto\')" title="Play to the start, then jump to the end on its own">Auto</button></div>' +
    '<div class="mark-edit-row">' +
      '<button class="mark-btn" onclick="doPreviewEditStart()">\u25B6 from start</button>' +
      (markEdit.safe != null
        ? '<button class="mark-btn" onclick="doPreviewEditLanding()">\u25B6 landing</button>'
        : '') +
      '<button class="mark-btn" onclick="doEditSave()">Save</button>' +
      '<button class="mark-btn" onclick="doEditCancel()">Cancel</button>' +
    '</div>' +
  '</div>';
}

function paintMarks() {
  var el = document.getElementById("ddd-marks");
  if (!el) return;
  var info = currentMarkInfo();
  if (!info) {
    el.innerHTML = '<div style="font-size:10px;color:rgba(255,255,255,.25)">' +
      'Identify an episode first; marks attach to it.</div>';
    paintMarkPending();
    return;
  }
  var list = marksFor(info);
  if (!list.length) {
    el.innerHTML = '<div style="font-size:10px;color:rgba(255,255,255,.25)">' +
      'No marks for this one yet.</div>';
  } else {
    var html = "";
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      html += '<div class="ddd-row"><span class="ddd-lbl">' + htmlEsc(m.label || "your mark") + '</span>' +
        '<span class="ddd-time">' + fmtMarkTime(m.start) +
        (m.safe != null ? " &rarr; " + fmtMarkTime(m.safe) : "") + '</span>' +
        '<span class="mark-tag">' + markActionOf(m) + '</span>' +
        '<button class="mark-x" title="Preview from 5s before the start" onclick="doPreviewStart(' + i + ')">\u25B6</button>' +
        '<button class="mark-x" title="Edit the times" onclick="doMarkEdit(' + i + ')">\u270E</button>' +
        '<button class="mark-x" title="Delete this mark" onclick="doMarkDelete(' + i + ')">\u2715</button></div>';
      if (markEdit && markEdit.index === i) html += markEditorHtml();
    }
    el.innerHTML = html;
  }
  paintMarkPending();
}

function pushMarks(info) {
  iina.postMessage("setSceneMarks", { marks: marksFor(info || currentMarkInfo()) });
}

function previewAt(seconds) {
  iina.postMessage("seekToTime", { seconds: Math.max(0, Number(seconds) || 0) });
}

function doPreviewPending() {
  if (markPending != null) previewAt(markPending - 5);
}

function doPreviewStart(i) {
  var list = marksFor(currentMarkInfo());
  if (list[i]) previewAt(Number(list[i].start) - 5);
}

function doPreviewLanding(i) {
  var list = marksFor(currentMarkInfo());
  if (list[i] && list[i].safe != null) previewAt(Number(list[i].safe) - 5);
}

function doPreviewEditStart() {
  if (markEdit) previewAt(markEdit.start - 5);
}

function doPreviewEditLanding() {
  if (markEdit && markEdit.safe != null) previewAt(markEdit.safe - 5);
}

function doMarkTrigger() {
  if (markPending != null) return;
  iina.postMessage("captureTime", { kind: "trigger" });
}

// Subtitles cannot be read where they live inside the container and image
// tracks carry no text, so the scan is offered but the report explains
// itself when there is nothing readable.
function doScanSubtitles() {
  if (!currentMarkInfo()) { showDddMsg("Identify an episode first."); return; }
  var btn = document.getElementById("ddd-mark-scan");
  if (btn) { btn.disabled = true; btn.textContent = "Scanning subtitles\u2026"; }
  iina.postMessage("scanSubtitles", {});
}

iina.onMessage("subScanResult", function(d) {
  var btn = document.getElementById("ddd-mark-scan");
  if (btn) { btn.disabled = false; btn.textContent = "Scan subtitles for tags"; }
  if (!d) return;
  if (!d.ok) {
    // An auto scan failed silently by design; only the button reports — with
    // one exception: a cached subtitle that would not load is worth saying,
    // because a manual load is the workaround.
    if (d.auto && d.reason !== "autoload-failed") return;
    if (d.reason === "autoload-failed") {
      showDddMsg("Couldn't auto-load the remembered subtitle \u2014 load one manually if you need it.");
    } else if (d.reason === "no-external-text") {
      showDddMsg("No external text subtitle loaded \u2014 download one via Subtitles \u2192 OpenSubtitles, then scan.");
    } else if (d.reason === "no-file-api") {
      showDddMsg("This build cannot read subtitle files.");
    } else {
      showDddMsg("Couldn't read the subtitle file.");
    }
    return;
  }
  var info = currentMarkInfo();
  if (!info) return;
  var list = marksFor(info);
  var added = 0;
  (d.proposals || []).forEach(function(p) {
    var start = Number(p.start);
    if (!isFinite(start) || start < 0) return;
    // A rescan must not stack duplicates: anything within five seconds of an
    // existing mark is the same moment.
    for (var i = 0; i < list.length; i++) {
      if (Math.abs(Number(list[i].start) - start) <= 5) return;
    }
    var safe = Number(p.safe);
    list.push({
      label: String(p.label || "tag"),
      start: start,
      safe: (isFinite(safe) && safe > start) ? safe : null,
      // Silent by default: a scan seeds the data without interrupting
      // playback. The ones worth a card are promoted by hand.
      action: "silent"
    });
    added++;
  });
  list.sort(function(a, b) { return a.start - b.start; });
  setMarksFor(info, list);
  paintMarks();
  pushMarks(info);
  if (d.auto) {
    // Quiet unless it actually produced something.
    if (added) showDddMsg("Subtitle detected \u2014 added " + added + " mark" + (added === 1 ? "" : "s") + " (Silent; set the ones you want to Warn, Skip or Auto).");
    return;
  }
  showDddMsg(added
    ? ("Added " + added + " subtitle mark" + (added === 1 ? "" : "s") + " (Silent \u2014 set the ones you want to Warn, Skip or Auto).")
    : "Scanned " + (Number(d.cues) || 0) + " cues; nothing new matched.");
});

iina.onMessage("timeCaptured", function(d) {
  if (!d) return;
  // The inline editor's "Use playhead" fields.
  if ((d.kind === "start" || d.kind === "end") && markEdit) {
    if (d.seconds == null) { showDddMsg("No playhead yet — load a video first."); return; }
    if (d.kind === "start") markEdit.start = Number(d.seconds);
    else markEdit.safe = Number(d.seconds);
    paintMarks();
    return;
  }
  if (d.kind === "safe") {
    if (markPending == null) return;
    if (d.seconds == null || !(Number(d.seconds) > markPending)) {
      showDddMsg("The end must come after the trigger — play on, then mark again.");
      return;
    }
    var info = currentMarkInfo();
    if (!info) return;
    var list = marksFor(info);
    list.push({ label: "your mark", start: markPending, safe: Number(d.seconds), action: "skip" });
    list.sort(function(a, b) { return a.start - b.start; });
    setMarksFor(info, list);
    markPending = null;
    paintMarks();
    pushMarks(info);
    showDddMsg("Mark saved with an end.");
    return;
  }
  // A trigger capture.
  if (d.seconds == null) { showDddMsg("No playhead yet — load a video first."); return; }
  if (!currentMarkInfo()) { showDddMsg("Identify an episode first."); return; }
  markPending = Number(d.seconds);
  paintMarks();
});

function doMarkSafe() {
  if (markPending != null) iina.postMessage("captureTime", { kind: "safe" });
}

function doMarkWarnOnly() {
  if (markPending == null) return;
  var info = currentMarkInfo();
  if (!info) return;
  var list = marksFor(info);
  list.push({ label: "your mark", start: markPending, safe: null, action: "skip" });
  list.sort(function(a, b) { return a.start - b.start; });
  setMarksFor(info, list);
  markPending = null;
  paintMarks();
  pushMarks(info);
  showDddMsg("Mark saved (warn only).");
}

function doMarkCancel() {
  markPending = null;
  paintMarks();
}

function doMarkEdit(i) {
  var info = currentMarkInfo();
  if (!info) return;
  var list = marksFor(info);
  if (i < 0 || i >= list.length) return;
  markEdit = {
    index: i,
    label: String(list[i].label || "your mark"),
    start: Number(list[i].start) || 0,
    safe: (list[i].safe != null) ? Number(list[i].safe) : null,
    action: markActionOf(list[i])
  };
  paintMarks();
}

function doEditType(t) {
  if (!markEdit) return;
  if (t !== "silent" && t !== "warn" && t !== "skip" && t !== "auto") return;
  markEdit.action = t;
  paintMarks();
}

function doEditUsePlayhead(which) {
  if (!markEdit) return;
  iina.postMessage("captureTime", { kind: which === "end" ? "end" : "start" });
}

function doEditCancel() {
  markEdit = null;
  paintMarks();
}

function doEditSave() {
  if (!markEdit) return;
  var info = currentMarkInfo();
  if (!info) return;
  var labelEl = document.getElementById("mark-edit-label");
  var startEl = document.getElementById("mark-edit-start");
  var endEl = document.getElementById("mark-edit-end");
  var label = String((labelEl && labelEl.value) || "").trim().slice(0, 60);
  var start = parseMarkTime(startEl ? startEl.value : "");
  var rawEnd = endEl ? String(endEl.value == null ? "" : endEl.value).trim() : "";
  var safe = rawEnd ? parseMarkTime(rawEnd) : null;
  if (start == null) { showDddMsg("Start not understood — use mm:ss or h:mm:ss."); return; }
  if (rawEnd && safe == null) { showDddMsg("End not understood — use mm:ss or h:mm:ss."); return; }
  if (safe != null && !(safe > start)) { showDddMsg("The end must come after the start."); return; }
  var list = marksFor(info);
  var m = list[markEdit.index];
  if (!m) { markEdit = null; paintMarks(); return; }
  m.label = label || "your mark";
  m.start = start;
  m.safe = safe;
  m.action = markActionOf(markEdit);
  list.sort(function(a, b) { return a.start - b.start; });
  setMarksFor(info, list);
  markEdit = null;
  paintMarks();
  pushMarks(info);
  showDddMsg("Mark updated.");
}

function doMarkDelete(i) {
  var info = currentMarkInfo();
  if (!info) return;
  var list = marksFor(info);
  if (i < 0 || i >= list.length) return;
  list.splice(i, 1);
  setMarksFor(info, list);
  markEdit = null;   // indices shift; close rather than track them
  paintMarks();
  pushMarks(info);
}

// Clearing everything is a two-tap affair: the label arms, a second tap
// within three seconds really clears. No native dialog (the web view may not
// show one), and no undo — deletion is on purpose after a rescan went wrong.
var markClearArmed = false;
var markClearTimer = null;

function doMarkClearAll() {
  var info = currentMarkInfo();
  if (!info) return;
  var list = marksFor(info);
  if (!list.length) return;
  var btn = document.getElementById("ddd-marks-clear");
  if (!markClearArmed) {
    markClearArmed = true;
    if (btn) btn.textContent = "Sure?";
    if (markClearTimer) clearTimeout(markClearTimer);
    markClearTimer = setTimeout(function() {
      markClearArmed = false;
      markClearTimer = null;
      if (btn) btn.textContent = "Clear all";
    }, 3000);
    return;
  }
  markClearArmed = false;
  if (markClearTimer) { clearTimeout(markClearTimer); markClearTimer = null; }
  if (btn) btn.textContent = "Clear all";
  markPending = null;
  markEdit = null;
  setMarksFor(info, []);
  paintMarks();
  pushMarks(info);
  showDddMsg("Marks cleared for this one.");
}

(function initMarks() { paintMarks(); })();
