/*
 * Engine: converts markdown in the paragraph under the cursor as you type.
 *
 * v0.1.2 — event-driven rewrite.
 *
 * The editor pushes `onParagraphText` for every text change; the engine
 * reacts within one editor round-trip instead of a blind poll. The 600 ms
 * poll stays as a fallback for editors that do not deliver the event, and
 * its timer doubles as the watchdog.
 *
 * v0.1.1 lesson (kept): two callCommands in flight from one plugin iframe
 * lose their callbacks — conversions silently died. The busy flag is now
 * held for the WHOLE chain (the v0.1.1 wrapper cleared it between steps, so
 * the poll could start a second chain while the first was still measuring —
 * the exact "periodically does not convert" bug).
 *
 * Conversions are batched: one plan per paragraph change (all spans,
 * heading, fence), one history point, one Ctrl+Z. Span positions are
 * resolved by a lazy binary-search ruler (Rules.createRuler): ~10 prefix
 * probes per boundary with a shared cache instead of the O(n) full-paragraph
 * ruler (2 s per paragraph in the live repro). The ruler bound now grows
 * with the soft-break count — a fixed text.length + 6 bound cut the ruler
 * short on break-heavy paragraphs and made every span near the paragraph
 * tail unresolvable ("apply skipped: offset" in the journal).
 *
 * A callCommand function runs inside the EDITOR context: it can use `Api`
 * and `Asc.scope` only, never plugin-scope closures. Every conversion is
 * therefore split into steps that exchange data through Asc.scope:
 *
 *   read    (editor): paragraph text + style under the caret
 *   plan    (plugin): scan with MdAutoformatRules (pure code, unit-tested)
 *   apply   (editor): verify the text did not change, resolve positions,
 *                     validate every range by GetText, then mutate
 *
 * The text-equality check makes each conversion atomic: a stale read can
 * never damage the document. Failed spans enter a cooldown instead of
 * retrying forever, so one unconvertible span no longer starves the rest of
 * the paragraph. Conversions undo in one step (CreateNewHistoryPoint).
 */
(function (root) {
	"use strict";

	var CODE_BLOCK_STYLE = "Code Block";
	var POLL_MS = 600;
	var WATCHDOG_MS = 15000;
	var WATCHDOG_DOC_MS = 120000;
	var COOLDOWN_MS = 4000;
	// An unresolvable position ruler means the editor's range machinery is
	// broken (GetRange throws "Invalid array length"). Retrying such a span
	// every few seconds only hammers the editor, so it backs off much longer.
	var COOLDOWN_BROKEN_MS = 30000;
	// A paragraph without any of these characters can never match a rule —
	// the event prefilter drops it without a single editor round-trip.
	var MARKDOWN_CHARS = /[*`~_[\]#]/;

	var state = {
		enabled: null, // tri-state until localStorage is read
		ready: false, // document-ready event received
		busy: false,
		docBusy: false, // whole-document conversion in flight
		busySince: 0,
		chainId: 0,
		dirty: false, // a change arrived while a chain was running
		lastFingerprint: null,
		pollTimer: null,
		statusCb: null,
		cooldown: null, // {key, until}
		// Google-Docs-style guards: after a conversion the paragraph is
		// remembered; when Ctrl+Z brings the marker text back the engine
		// must NOT convert it again. And deletions must never trigger a
		// conversion (delete guard via lastScanText length comparison).
		// v0.1.3: the guard is now per paragraph — state.lastConverted[idx]
		// = {from, to}: `from` is the marker text the conversion replaced
		// (Ctrl+Z returns exactly this), `to` is OUR result text. The guard
		// blocks re-conversion while the scanned text equals `from`, and
		// survives the engine's own re-read of the result (the scan right
		// after a conversion shows `to`, which must NOT disarm the guard —
		// before v0.1.3 that re-read disarmed a single global undoGuard and
		// Ctrl+Z re-converted instantly). Any OTHER text (a real user edit)
		// disarms the paragraph.
		lastConverted: {},
		// the ORIGINAL text of the paragraph the last applyItem mutated
		// (== `from` above; captured at mutation time, when the plan text
		// is still the pre-conversion one)
		lastConvertedFrom: null,
		lastScanText: null,
		lastScanParaId: null,
		// v0.1.3: the paragraph INDEX of the last scan (from the neighbour
		// scan, which the MARKDOWN_CHARS splice fix finally makes run).
		// GetInternalId returns null on some server builds, so the delete
		// guard identifies "the same paragraph" by index instead of id.
		lastScanCurIndex: null,
		// v0.1.3: the "Enter was just pressed" signal. The editor fires
		// onParagraphText with an EMPTY text for the paragraph created by
		// Enter; the handler sets this flag. Unlike eventMode it is NOT
		// reset by the poll (a click into an empty paragraph never sets
		// it), and it survives the busy/dirty re-scan path — the next
		// chain whose read shows an empty paragraph consumes it.
		pendingEnter: false,
		// v0.1.3: paragraph index the last conversion chain mutated (the
		// caret paragraph for space-triggered conversions, the PREVIOUS
		// paragraph for the Enter path). finish() uses it to read and
		// record the converted result text.
		lastTargetIndex: -1,
		// v0.1.3: step counter of the running chain. The FIRST mutation of
		// a chain creates the history point, the rest reuse it — otherwise
		// Ctrl+Z after a fence block (or a multi-span paragraph) undoes one
		// line at a time instead of the whole conversion.
		itemStep: 0,
		// v0.1.3: caret anchor returned by the last mutation ({openerAt,
		// len, targetIndex}) — finish() puts the caret right AFTER the
		// converted span instead of at the end of the paragraph.
		caret: null
	};

	var Rules = root.MdAutoformatRules;

	// debug journal in localStorage (same-origin tabs can read it)
	function dbg(msg) {
		try {
			var log = JSON.parse(localStorage.getItem("mdAutoformat.log") || "[]");
			log.push(new Date().toISOString().slice(14, 22) + " " + msg);
			localStorage.setItem("mdAutoformat.log", JSON.stringify(log.slice(-200)));
		} catch (e) {
			/* logging must never break the engine */
		}
	}

	// ---------------------------------------------------------------- storage

	function readEnabled() {
		try {
			return localStorage.getItem("mdAutoformat.enabled") !== "false";
		} catch (e) {
			return true;
		}
	}

	function isEnabled() {
		if (state.enabled === null) {
			state.enabled = readEnabled();
		}
		return state.enabled;
	}

	function setEnabled(value) {
		state.enabled = !!value;
		try {
			localStorage.setItem("mdAutoformat.enabled", state.enabled ? "true" : "false");
		} catch (e) {
			/* private mode: session-only toggle survives */
		}
		state.lastFingerprint = null; // re-arm after a pause
		state.lastConverted = {};
		state.lastConvertedFrom = null;
		state.lastScanText = null;
		state.lastScanParaId = null;
		state.lastScanCurIndex = null;
		state.lastTargetIndex = -1;
		notify("");
	}

	function toggle() {
		setEnabled(!isEnabled());
	}

	function notify(message) {
		if (state.statusCb) {
			state.statusCb({
				enabled: isEnabled(),
				message: message || ""
			});
		}
	}

	// ------------------------------------------------- fence marker helpers

	// A fence marker line is "```" plus an optional language name and
	// NOTHING else — "``` text" stays plain text (item 4).
	function isFenceMarker(text) {
		var s = String(text || "").replace(/[\r\n]+$/, "");
		return /^```[^\s\r\n]*$/.test(s);
	}

	function fenceMarkerLen(text) {
		var s = String(text || "").replace(/[\r\n]+$/, "");
		var m = /^```[^\s\r\n]*/.exec(s);
		return m ? m[0].length : 3;
	}

	// Code Block style is created once with the classic look (monospace +
	// grey fill), mirroring the old single-paragraph fence behaviour.
	// Self-contained (no outer variables) so buildCommand can splice it
	// into the editor sandbox.
	function ensureCodeBlockStyle(doc) {
		var st = doc.GetStyle("Code Block");
		if (!st) {
			st = doc.CreateStyle("Code Block");
			try {
				var tPr = st.GetTextPr();
				tPr.SetFontFamily("Consolas");
				tPr.SetFontSize(19); // 9.5pt
				st.GetParaPr().SetShd("clear", 242, 242, 242);
			} catch (e) {
				/* style stays plain rather than breaking the toggle */
			}
		}
		return st;
	}

	// v0.1.4: the fence-block mutation body, shared by the typing path and
	// "Convert whole document" (buildCommand splices it into the sandbox).
	// Runs as ONE editor command: verifies the block texts, REMOVES both
	// marker paragraphs entirely — text plus the paragraph mark, so the
	// surrounding text shifts up like real markdown typesetting (the first
	// content line takes the opening marker's place, the closing marker
	// merges into the empty paragraph below the block) — and styles the
	// content lines with Code Block. Deleting a paragraph mark only works
	// while the paragraph still has text, and the SDK silently ignores it
	// for the LAST paragraph of the document (that marker falls back to an
	// invisible Normal line). One history point per call, so one Ctrl+Z
	// restores the whole block.
	function fenceBlockBody() {
		try {
			var doc = Api.GetDocument();
			var paras = doc.GetAllParagraphs();
			var f = Asc.scope.fence;
			if (!f || f.from < 0 || f.to >= paras.length || f.to <= f.from) {
				return { ok: false, stage: "fence-index" };
			}
			var norm = function (s) {
				return String(s || "").replace(/[\r\n]+$/, "");
			};
			var i, p, full;
			for (i = f.from; i <= f.to; i++) {
				if (norm(paras[i].GetText()) !== norm(f.texts[i])) {
					return { ok: false, stage: "changed", at: i };
				}
			}
			doc.CreateNewHistoryPoint();
			var codeStyle = ensureCodeBlockStyle(doc);
			var normalStyle = doc.GetStyle("Normal") || doc.GetDefaultStyle();
			// closing marker first (higher index — its removal does not
			// shift the opening one); it merges into the empty paragraph
			// below the block
			p = paras[f.to];
			full = String(p.GetText() || "");
			p.GetRange(0, full.length).Delete();
			if (f.to === paras.length - 1) {
				// the end mark of the very last paragraph cannot be
				// removed — un-style the leftover empty line instead
				try {
					p.SetStyle(normalStyle);
				} catch (e) {
					/* paragraph merged away anyway */
				}
			}
			// re-fetch: the merge changed the paragraph list
			paras = doc.GetAllParagraphs();
			// the opening marker merges into the first content line
			p = paras[f.from];
			full = String(p.GetText() || "");
			p.GetRange(0, full.length).Delete();
			// re-fetch and style the content lines, now sitting at
			// from..from+n-1 where n is the content paragraph count
			paras = doc.GetAllParagraphs();
			var n = f.to - f.from - 1;
			for (i = 0; i < n; i++) {
				var idx = f.from + i;
				if (idx >= paras.length) {
					return { ok: false, stage: "content-index" };
				}
				var pc = paras[idx];
				if (norm(pc.GetText()) !== norm(f.texts[f.from + 1 + i])) {
					return { ok: false, stage: "changed-content", at: idx };
				}
				pc.SetStyle(codeStyle);
			}
			// the paragraph that absorbed the closing marker sits right
			// after the block — keep it invisible
			var tail = f.from + n;
			if (tail < paras.length) {
				try {
					paras[tail].SetStyle(normalStyle);
				} catch (e) {
					/* best effort */
				}
			}
			return { ok: true, count: f.to - f.from + 1, removed: 2 };
		} catch (e) {
			return { ok: false, error: e.message };
		}
	}

	// ------------------------------------------------- callCommand plumbing

	var CALL_COMMAND_TIMEOUT_MS = 60000;

	// Busy state is owned by the chain, NOT by this wrapper (the v0.1.1
	// wrapper cleared busy between chain steps, which let the poll start
	// overlapping chains — lost callbacks, dead spans). A stale callback
	// (chain superseded) is simply ignored.
	function callCommand(fn, callback, timeoutMs) {
		var gen = state.chainId;
		var timer = null;
		try {
			window.Asc.plugin.callCommand(fn, false, true, function (result) {
				if (timer) {
					clearTimeout(timer);
				}
				if (gen === state.chainId && callback) {
					callback(result);
				}
			});
			// A lost callback (editor swallowed the command) must not wedge
			// the engine until the poll watchdog fires — the poll is
			// throttled to ~60s in hidden windows. Abandoning the chain by
			// bumping chainId discards the late callback safely.
			timer = setTimeout(function () {
				if (gen !== state.chainId) {
					return;
				}
				dbg("callCommand timeout (" + (timeoutMs || CALL_COMMAND_TIMEOUT_MS) + "ms): abandoning chain");
				state.chainId++;
				state.busy = false;
				state.docBusy = false;
			}, timeoutMs || CALL_COMMAND_TIMEOUT_MS);
		} catch (e) {
			dbg("callCommand error: " + (e.message || e));
			if (gen === state.chainId && callback) {
				callback(null);
			}
		}
	}

	// ------------------------------------------------------------ poll engine

	function init(statusCb) {
		state.statusCb = statusCb || null;
		setInterval(pollTick, POLL_MS);
		subscribeEditorEvents();
		// Installed into an already-open document, the SDK never fires
		// onDocumentReady again: probe the editor once and adopt it.
		setTimeout(function () {
			if (state.ready) {
				return;
			}
			callCommand(function () {
				var doc = Api.GetDocument();
				var p = doc.GetCurrentParagraph();
				return { ok: !!p };
			}, function (res) {
				if (res && res.ok && !state.ready) {
					onDocumentReady();
				}
			}, 4000);
		}, 1000);
		// Fallback for the rare case where onDocumentReady fired before the
		// plugin wired its handler: after a generous delay the document is
		// certainly loaded, so unblock the poll.
		setTimeout(function () {
			if (!state.ready) {
				state.ready = true;
				dbg("document ready (fallback)");
			}
		}, 60000);
		notify("");
	}

	// Called by the plugin page when the editor fires onDocumentReady.
	// The poll stays gated on this flag: the very first measures run against
	// a half-initialised document and their GetRange calls can corrupt the
	// editor's position lists for the rest of the session.
	function onDocumentReady() {
		if (!state.ready) {
			state.ready = true;
			state.lastFingerprint = null;
			dbg("document ready");
		}
	}

	function subscribeEditorEvents() {
		var plugin = window.Asc && window.Asc.plugin;
		if (!plugin || typeof plugin.attachEditorEvent !== "function") {
			dbg("events: attachEditorEvent unavailable, poll only");
			return;
		}
		try {
			// Two registrations are needed: attachEditorEvent tells the
			// editor to push the event to this window, attachEvent installs
			// the local handler that the SDK's onEvent dispatch looks up in
			// plugin._events. Without the latter the editor pushes nothing
			// visible and the engine silently falls back to the poll — which
			// the browser throttles hard while the plugin window is hidden
			// (the root of the v0.1.1 "autoreplace sometimes does not fire").
			var handler = function (data) {
				if (!state.ready || !isEnabled()) {
					return;
				}
				if (!data || typeof data.text !== "string") {
					return;
				}
				state.eventMode = true;
				// v0.1.1: the paragraph mark comes back in build-specific
				// variants ("\r\n", "\r", "") — normalize once so the
				// empty-paragraph signal and the prefilter behave the same
				// on every build.
				var evText = String(data.text).replace(/[\r\n]+$/, "");
				// v0.1.3: an EMPTY event text is the "Enter pressed" signal
				// (the caret moved to the new empty paragraph; the marker
				// sits in the previous one). Non-empty events clear the
				// signal: a click never fires an event, so only a real Enter
				// can raise it, and typing in the new paragraph cancels a
				// stale one.
				if (evText === "") {
					state.pendingEnter = true;
				} else {
					state.pendingEnter = false;
				}
				// prefilter: paragraphs without markdown characters are
				// dropped without a single editor round-trip. v0.1.3: the
				// EMPTY paragraph created by Enter must pass too — it is
				// the signal that the previous paragraph's marker is
				// finished ("**test**" + Enter -> convert the previous
				// paragraph). The event carries eventMode=true; the poll
				// clears it, so a mouse click into an empty paragraph can
				// never trigger that conversion.
				if (evText !== "" && !MARKDOWN_CHARS.test(evText)) {
					return;
				}
				scheduleScan();
			};
			if (typeof plugin.attachEvent === "function") {
				plugin.attachEvent("onParagraphText", handler);
			}
			plugin.attachEditorEvent("onParagraphText", handler);
			dbg("events: onParagraphText subscribed");
		} catch (e) {
			dbg("events: subscribe failed: " + (e.message || e));
		}
	}

	function pollTick() {
		// watchdog first: a chain whose callback never arrived must not
		// wedge the engine (whole-document runs get a longer leash)
		if (state.busy || state.docBusy) {
			var limit = state.docBusy ? WATCHDOG_DOC_MS : WATCHDOG_MS;
			if (Date.now() - state.busySince > limit) {
				dbg("watchdog: " + (state.docBusy ? "doc" : "chain") + " stuck, releasing");
				state.busy = false;
				state.docBusy = false;
			}
		}
		// v0.1.3: a poll tick is NOT a typing signal. Enter-follows-marker
		// conversion (see planAndApply) must only fire from an editor event,
		// never from the background poll — otherwise a plain mouse click
		// into an empty paragraph re-converts the previous one.
		state.eventMode = false;
		if (!isEnabled() || !state.ready || state.busy || state.docBusy) {
			return;
		}
		scheduleScan();
	}

	// ------------------------------------------------------------ scheduling

	function scheduleScan() {
		if (!isEnabled() || !state.ready) {
			return;
		}
		if (state.busy || state.docBusy) {
			state.dirty = true; // re-scan when the current chain finishes
			return;
		}
		runChain();
	}

	function releaseAndRescan() {
		state.busy = false;
		if (state.dirty) {
			state.dirty = false;
			scheduleScan();
		}
	}

	// ------------------------------------------------------ command builder

	// The editor sandbox that runs callCommand bodies has no plugin closures,
	// no Function constructor, and its eval returns no values — but it DOES
	// eval the serialized source of the function handed to callCommand. So
	// the ruler resolver (self-contained, Rules.createRulerSource) is spliced
	// into the command body's source here, in the plugin context, before the
	// function is handed over.
	function buildCommand(bodyFn) {
		var src = bodyFn.toString();
		var brace = src.indexOf("{");
		// v0.1.3: MARKDOWN_CHARS is a plugin-scope constant; splice its
		// source into the sandbox the same way the ruler helpers are
		// spliced, otherwise the neighbour scan throws
		// "MARKDOWN_CHARS is not defined" and curIndex/prevText are never
		// produced (fence pairing and the Enter-follows-marker branch
		// silently die).
		var full = src.slice(0, brace + 1) + "\n" + "var MARKDOWN_CHARS = " + MARKDOWN_CHARS.toString() + ";\n" + Rules.createRulerSource() + "\n" + Rules.isFenceMarkerSource() + "\n" + fenceMarkerLen.toString() + "\n" + ensureCodeBlockStyle.toString() + "\n" + fenceBlockBody.toString() + "\n" + src.slice(brace + 1);
		return new Function("return " + full)();
	}

	// ---------------------------------------------------------------- chain

	function runChain() {
		state.busy = true;
		state.busySince = Date.now();
		state.chainId++;
		// v0.1.3: capture whether THIS chain was started by an editor event
		// (the Enter keystroke) or by the poll. The read below is
		// asynchronous; the mutable state.eventMode flag would be reset by
		// an interleaving poll tick before planAndApply runs. The captured
		// value travels through the closure instead.
		var chainEventMode = state.eventMode;
		// v0.1.3: same capture for the Enter signal — pendingEnter is only
		// ever cleared by the handler (non-empty event) or by the enter
		// branch itself, never by the poll, but the fast-typing case (a
		// non-empty event lands between this chain's start and its read)
		// must not cancel the Enter that started it.
		var chainPendingEnter = state.pendingEnter;
		dbg("chain #" + state.chainId + " start");
		callCommand(buildCommand(function () {
			try {
				var doc = Api.GetDocument();
				var p = doc.GetCurrentParagraph();
				if (!p) {
					return { ok: false };
				}
				var sn = "";
				try {
					var st = p.GetStyle();
					sn = st ? st.GetName() : "";
				} catch (e) {
					sn = "";
				}
				// v0.1.3: GetText() in the live API ALWAYS ends with the
				// paragraph mark — "\r\n" on the web builds, other variants
				// are possible on other builds (v0.1.1 normalizes them all)
				// — even while the user is still typing and Enter was never
				// pressed. Feeding that raw text to the rules made closerOk
				// see a "finished" paragraph, so "**test**" converted the
				// instant its last character was typed (no trailing space,
				// no Enter). Strip the mark here; the "Enter finishes the
				// marker" case is handled separately in planAndApply via
				// the empty-paragraph signal.
				var text = String(p.GetText() || "").replace(/[\r\n]+$/, "");
				var out = { ok: true, text: text, style: sn };
				// fence state comes from the neighbouring paragraphs: find
				// the current paragraph's index, then collect every fence
				// marker line above it (max 50). An ODD count means the
				// current paragraph sits inside an open code block; the
				// closing-marker+Enter case is an EMPTY paragraph whose
				// PREVIOUS line is a marker and whose markers above still
				// contain the opening one. The neighbour scan (GetAllParagraphs
				// + up to 50 GetText) runs only when the current paragraph
				// could plausibly be fence-related: an empty one or one
				// containing markdown characters.
				try {
					var emptyNow = text === "";
					if (emptyNow || MARKDOWN_CHARS.test(text)) {
						var paras = doc.GetAllParagraphs();
						var pid = null;
						try {
							pid = p.GetInternalId();
						} catch (e) {
							pid = null;
						}
						var curIdx = -1;
						for (var i = 0; i < paras.length; i++) {
							var id = null;
							try {
								id = paras[i].GetInternalId();
							} catch (e) {
								id = null;
							}
							if (pid !== null && id !== null && id === pid) {
								curIdx = i;
								break;
							}
						}
						// v0.1.3: some server builds never return an id from
						// GetInternalId (the delete guard silently stopped
						// working there). Fall back to reference equality —
						// the sandbox proxies are cached per document object.
						if (curIdx < 0) {
							for (var i2 = 0; i2 < paras.length; i2++) {
								if (paras[i2] === p) {
									curIdx = i2;
									break;
								}
							}
						}
						out.curIndex = curIdx;
						out.paraId = pid;
						if (curIdx > 0) {
							out.prevText = String(paras[curIdx - 1].GetText() || "").replace(/[\r\n]+$/, "");
							try {
								var pst = paras[curIdx - 1].GetStyle();
								out.prevStyle = pst ? pst.GetName() : "";
							} catch (e) {
								out.prevStyle = "";
							}
						}
						var markers = [];
						var upto = Math.max(0, curIdx - 1 - 50);
						for (var j = curIdx - 1; j >= upto; j--) {
							if (isFenceMarker(paras[j].GetText())) {
								markers.push(j);
							}
						}
						out.fenceMarkers = markers;
						// the closing-marker+Enter case needs the texts of
						// every block paragraph for the apply-time equality
						// checks. markers[] is scanned top-down: [0] is the
						// closing line (== prev paragraph), [1] the opening
						// one.
						if (markers.length >= 2 && paras[curIdx - 1] && isFenceMarker(paras[curIdx - 1].GetText())) {
							var fenceFrom = markers[1];
							out.fenceTexts = {};
							for (var k = fenceFrom; k <= curIdx - 1; k++) {
								out.fenceTexts[k] = paras[k].GetText();
							}
						}
					}
				} catch (e) {
					/* neighbour scan must never break the chain */
				}
				return out;
			} catch (e) {
				return { ok: false, error: e.message };
			}
		}), function (read) {
			try {
				if (read && read.error) {
					dbg("read error: " + read.error);
				}
			if (!read || !read.ok || typeof read.text !== "string") {
				releaseAndRescan();
				return;
			}
			var fingerprint = read.text + "\u0001" + read.style;
			// v0.1.3: the fingerprint dedup must not swallow the Enter
			// signal. The empty paragraph's fingerprint ("") is constant,
			// so the first poll after Enter dedups the chain and the
			// enter-follows-marker branch never runs. A pendingEnter chain
			// whose read is empty always passes through.
			if (fingerprint === state.lastFingerprint && !(chainPendingEnter && read.text === "")) {
				releaseAndRescan();
				return;
			}
			state.lastFingerprint = fingerprint;
			planAndApply(read.text, read.style || "", {
				prevText: read.prevText,
				curIndex: read.curIndex,
				paraId: read.paraId,
				eventMode: chainEventMode,
				pendingEnter: chainPendingEnter,
				fenceMarkers: read.fenceMarkers || [],
				fenceTexts: read.fenceTexts
			});
			} catch (e) {
				dbg("chain exception: " + (e && e.message || e));
				state.busy = false;
			}
		});
	}

	// --------------------------------------------------------------- cooldown

	function cooldownKey(kind, matchText) {
		return kind + "\u0001" + matchText;
	}

	function coolingDown(key) {
		return state.cooldown && state.cooldown.key === key && Date.now() < state.cooldown.until;
	}

	function startCooldown(key, ms) {
		state.cooldown = { key: key, until: Date.now() + (ms || COOLDOWN_MS) };
		dbg("cooldown: " + key);
	}

	function clearCooldown() {
		state.cooldown = null;
	}

	// --------------------------------------------------------------- planner

	// Build the conversion plan for one paragraph: heading and every inline
	// span (scanOne loop over a shadow copy — the same technique as the
	// whole-document planner). Spans whose cooldown is active are dropped.
	// Fence handling lives in planAndApply (it needs the neighbouring
	// paragraphs), so this stays a pure function of text+style.
	// Returns null when there is nothing to do.
	function planParagraph(text, style) {
		var inCodeBlock = style === CODE_BLOCK_STYLE;
		if (inCodeBlock) {
			return null; // markdown inside a code block is not converted
		}
		var plan = { heading: null, spans: [] };
		var h = Rules.detectHeading(text);
		if (h && !coolingDown("h" + h.level)) {
			plan.heading = { level: h.level, markerLen: h.markerLen, marker: text.slice(0, h.markerLen) };
		}
		var shadow = text;
		var delta = 0;
		var guard = 0;
		while (guard++ < Rules.MAX_PASSES) {
			var m = Rules.scanOne(shadow);
			if (!m) {
				break;
			}
			var matchText = shadow.slice(m.start, m.end);
			var key = cooldownKey(m.kind, matchText);
			if (!coolingDown(key)) {
				plan.spans.push({
					kind: m.kind,
					start: m.start + delta,
					innerStart: m.innerStart + delta,
					innerEnd: m.innerEnd + delta,
					end: m.end + delta,
					opener: shadow.slice(m.start, m.innerStart),
					closer: shadow.slice(m.innerEnd, m.end),
					inner: shadow.slice(m.innerStart, m.innerEnd),
					url: m.url || "",
					key: key
				});
			}
			delta += (m.innerStart - m.start) + (m.end - m.innerEnd);
			shadow = shadow.slice(0, m.start) + shadow.slice(m.innerStart, m.innerEnd) + shadow.slice(m.end);
		}
		if (!plan.heading && !plan.spans.length) {
			return null;
		}
		return plan;
	}

	// Google-Docs-style cursor restore: the editor pins the caret to the
	// first formatting-slot boundary while our deletes run, which lands it
	// BEFORE the converted word ("тест текст *курсив*" -> caret jumps in
	// front of "курсив"). After every conversion the caret is explicitly
	// moved to the end of the paragraph (positions in slots, via the
	// paragraph's own range).
	//
	// v0.1.3 fix: the end position must be the paragraph length WITHOUT the
	// trailing "\r\n" paragraph mark, not length - 2. With a trailing space
	// (the conversion trigger) "**test** " -> "test \r\n" is 7 chars, so
	// length - 2 = 5 landed the caret INSIDE the word (or before the space);
	// stripping the mark gives 5 for "test \r\n" -> caret after the space,
	// i.e. the true end of the paragraph.
	function cursorToParagraphEnd(cb) {
		callCommand(function () {
			try {
				var doc = Api.GetDocument();
				var p = doc.GetCurrentParagraph();
				if (!p) {
					return { ok: false };
				}
				var t = p.GetText();
				var n = Math.max(0, String(t || "").length);
				var endPos = p.GetRange(n, n).GetEndPos();
				doc.MoveCursorToPos(endPos);
				return { ok: true };
			} catch (e) {
				return { ok: false, error: e.message };
			}
		}, function (res) {
			if (res && res.error) {
				dbg("cursor fix error: " + res.error);
			}
			if (cb) {
				cb(res);
			}
		});
	}

	// v0.1.3: move the caret right AFTER the converted span. Mid-line
	// conversions ("test `code` text") must leave the caret next to the
	// converted word, not jump it to the end of the paragraph. The span is
	// found by its exact text — the marker deletes leave empty slots in the
	// model, so positions measured at mutation time are off by one, while
	// GetText() skips slots and matches cleanly.
	function cursorAfterItem(caret, cb) {
		Asc.scope.caret = caret;
		callCommand(buildCommand(function () {
			try {
				var doc = Api.GetDocument();
				var caret = Asc.scope.caret;
				var p = caret.targetIndex >= 0 ? doc.GetAllParagraphs()[caret.targetIndex] : doc.GetCurrentParagraph();
				if (!p) {
					return { ok: false };
				}
				var inner = caret.inner;
				var len = inner.length;
				var at = -1;
				for (var k = 0; k <= 256 && at < 0; k++) {
					try {
						if (p.GetRange(k, k + len).GetText() === inner) {
							at = k;
						}
					} catch (e) {
						/* probe failed, try next candidate */
					}
				}
				if (at < 0) {
					return { ok: false, stage: "caret-inner" };
				}
				// v0.1.1: park the caret at the START of the next real
				// character after the span — the marker deletes leave empty
				// slots, so scan forward past them; when the span ends the
				// paragraph, the first "character" found is the paragraph
				// mark ("\r\n") and its start is the end-of-line boundary.
				// The old GetEndPos() of the inner range parked the caret on
				// the boundary after the FORMATTED run, where the editor
				// kept typing with the span's format (bold/italic/code) —
				// "testX" came out bold. From the next real character's
				// boundary the editor continues with the SURROUNDING run's
				// format instead — Google-Docs behaviour ("**test** " →
				// typing after "test" stays plain). Verified live on
				// DS 10.0.2 (playground): mid-paragraph and end-of-paragraph
				// spans both type plain after this change.
				var b = -1;
				for (var k2 = at + len; k2 <= at + len + 12; k2++) {
					try {
						var ch = p.GetRange(k2, k2 + 1).GetText();
						if (ch) {
							b = k2;
							break;
						}
					} catch (e) {
						/* probe failed, keep scanning */
					}
				}
				var endPos = b >= 0 ? p.GetRange(b, b + 1).GetStartPos() : p.GetRange(at, at + len).GetEndPos();
				doc.MoveCursorToPos(endPos);
				return { ok: true };
			} catch (e) {
				return { ok: false, error: e.message };
			}
		}), function (res) {
			if (res && res.error) {
				dbg("caret fix error: " + res.error);
			}
			if (cb) {
				cb(res);
			}
		});
	}

	function planAndApply(text, style, meta) {
		meta = meta || {};
		state.lastTargetIndex = -1; // no chain running yet
		state.itemStep = 0; // history point per chain, not per command
		state.caret = null; // no item conversion result yet
		// item 8: Ctrl+Z returned the exact text we converted from — the
		// conversion must NOT re-fire (Google-Docs behaviour). The guard is
		// per paragraph (state.lastConverted[idx] = {from, to}): while the
		// scanned text equals `from` the conversion stays blocked, and
		// `to` keeps the guard armed across the engine's own re-read of
		// its result (which would otherwise look like a user edit and
		// disarm the guard — the v0.1.2 bug: Ctrl+Z re-converted
		// instantly). Any other text is a real user edit and disarms the
		// paragraph.
		var conv = (typeof meta.curIndex === "number") ? (state.lastConverted[meta.curIndex] || null) : null;
		if (conv && text === conv.from) {
			state.lastScanText = text;
			state.lastScanParaId = meta.paraId || null;
			state.lastScanCurIndex = meta.curIndex || null;
			dbg("undo guard: " + JSON.stringify(text.slice(0, 24)));
			releaseAndRescan();
			return;
		}
		if (!conv || conv.to !== text) {
			if (typeof meta.curIndex === "number") {
				delete state.lastConverted[meta.curIndex];
			}
			state.lastConvertedFrom = null;
		}
		// item 9: deletions must never trigger a conversion. Any text that
		// is SHORTER than the last scanned text OF THE SAME PARAGRAPH is
		// treated as an edit/delete, not as typing. v0.1.3: two fixes here.
		// (a) GetInternalId returns null on some server builds, which
		// silently disabled the guard (backspace then re-converted the
		// paragraph) — the paragraph is now identified by its INDEX from
		// the neighbour scan instead. (b) The old shape-only fallback
		// (text is a strict PREFIX/SUFFIX of the last scan) fired on the
		// EMPTY paragraph created by Enter — "" is a prefix of everything,
		// so the Enter-follows-marker conversion was swallowed before it
		// started. The index check keeps the guard scoped to the paragraph
		// where the deletion actually happened.
		var samePara = (typeof state.lastScanCurIndex === "number" && state.lastScanCurIndex === meta.curIndex) || (typeof state.lastScanCurIndex !== "number" && typeof meta.curIndex !== "number");
		if (typeof state.lastScanText === "string" && state.lastScanText.length > 0 && samePara && text.length < state.lastScanText.length && (state.lastScanText.indexOf(text) === 0 || state.lastScanText.lastIndexOf(text) === state.lastScanText.length - text.length)) {
			state.lastScanText = text;
			state.lastScanParaId = meta.paraId || null;
			state.lastScanCurIndex = meta.curIndex || null;
			dbg("delete guard: " + JSON.stringify(text.slice(0, 24)));
			releaseAndRescan();
			return;
		}
		state.lastScanText = text;
		state.lastScanParaId = meta.paraId || null;
		state.lastScanCurIndex = meta.curIndex || null;
		// items 3/4: a fence marker line ("```" alone or with a language
		// name) is never converted inline — it opens a block that
		// materialises only when the CLOSING marker is typed and Enter
		// pressed. "``` text" is plain text and untouched by the engine.
		var markerLine = isFenceMarker(text);
		var inCodeBlock = style === CODE_BLOCK_STYLE;
		var fenceClose = null;
		if (markerLine) {
			releaseAndRescan();
			return;
		}
		var fenceMarkers = meta.fenceMarkers || [];
		// v0.1.3: read.text is stripped of the "\r\n" mark, so an empty
		// paragraph is exactly "" now.
		var emptyPara = text === "";
		if (emptyPara && meta.prevText !== undefined && isFenceMarker(meta.prevText) && fenceMarkers.length >= 2) {
			// the closing marker line was typed and Enter pressed: markers
			// are scanned top-down, [0] is the closing line itself (the
			// previous paragraph), [1] the opening one
			var fenceFrom = fenceMarkers[1];
			var fenceTo = meta.curIndex - 1;
			if (typeof fenceFrom === "number" && typeof meta.curIndex === "number" && fenceFrom >= 0 && fenceTo >= fenceFrom) {
				fenceClose = { from: fenceFrom, to: fenceTo };
			}
		}
		if (!fenceClose && fenceMarkers.length % 2 === 1) {
			// inside an open code block: no markdown conversion at all
			releaseAndRescan();
			return;
		}
		if (inCodeBlock && !fenceClose) {
			releaseAndRescan();
			return;
		}
		// mutate one item per editor command (fresh ruler each time), and
		// RE-PLAN after every mutation: the paragraph text changes with each
		// deletion, so the remaining items are re-planned against the new
		// text instead of carrying stale offsets
		var total = 0;
		var done = false;
		var originalText = text;
		var finish = function () {
			if (done) {
				return;
			}
			done = true;
			if (total > 0) {
				clearCooldown();
				state.lastFingerprint = null; // text changed — rescan on next signal
				state.lastScanText = null; // our own mutations are not "deletes"
				notify(total + " item(s)");
				// item 8: remember {from, to} of the converted paragraph —
				// Ctrl+Z returns exactly `from` (the marker text) and the
				// engine must not re-convert it. `to` is read AFTER the
				// mutations so the engine's own re-read of the result does
				// not look like a user edit and disarm the guard (v0.1.3
				// undo fix). The Enter path converted a NEIGHBOUR paragraph
				// (lastTargetIndex), everything else the caret paragraph.
				var convIdx = state.lastTargetIndex;
				state.lastTargetIndex = -1;
				var convFrom = state.lastConvertedFrom;
				state.lastConvertedFrom = null;
				var afterRecord = function () {
					var caret = state.caret;
					state.caret = null;
					// v0.1.3: mid-line conversions put the caret right
					// AFTER the converted span (not at the end of the
					// paragraph). The Enter path converted a neighbour
					// paragraph — the caret stays in the fresh empty
					// paragraph and is not moved at all.
					if (caret && typeof caret.inner === "string" && caret.targetIndex < 0) {
						cursorAfterItem(caret, function () {
							releaseAndRescan();
						});
					} else {
						cursorToParagraphEnd(function () {
							releaseAndRescan();
						});
					}
				};
				if (typeof convIdx === "number" && convIdx >= 0 && typeof convFrom === "string") {
					var record = function (cur) {
						if (cur && typeof cur.text === "string") {
							state.lastConverted[convIdx] = { from: convFrom, to: cur.text };
						}
						afterRecord();
					};
					if (Asc.scope.targetIndex >= 0) {
						readIndex(convIdx, record);
					} else {
						readCurrent(record);
					}
					return;
				}
				afterRecord();
				return;
			}
			releaseAndRescan();
		};
		var readCurrent = function (cb) {
			callCommand(function () {
				try {
					var doc = Api.GetDocument();
					var p = doc.GetCurrentParagraph();
					if (!p) {
						return { ok: false };
					}
					var sn = "";
					try {
						var st = p.GetStyle();
						sn = st ? st.GetName() : "";
					} catch (e) {
						sn = "";
					}
					return { ok: true, text: String(p.GetText() || "").replace(/[\r\n]+$/, ""), style: sn };
				} catch (e) {
					return { ok: false, error: e.message };
				}
			}, function (read) {
				cb(read && read.ok ? { text: read.text, style: read.style || "" } : null);
			});
		};
		// v0.1.3: read a paragraph by its index (the Enter-follows-marker
		// path converts the PREVIOUS paragraph, which is not the current
		// caret paragraph).
		var readIndex = function (idx, cb) {
			callCommand(function () {
				try {
					var doc = Api.GetDocument();
					var paras = doc.GetAllParagraphs();
					if (idx < 0 || idx >= paras.length) {
						return { ok: false };
					}
					var p = paras[idx];
					var sn = "";
					try {
						var st = p.GetStyle();
						sn = st ? st.GetName() : "";
					} catch (e) {
						sn = "";
					}
					return { ok: true, text: String(p.GetText() || "").replace(/[\r\n]+$/, ""), style: sn };
				} catch (e) {
					return { ok: false, error: e.message };
				}
			}, function (read) {
				cb(read && read.ok ? { text: read.text, style: read.style || "" } : null);
			});
		};
		// v0.1.3: continue the conversion loop after one item: re-read the
		// paragraph being converted (caret paragraph or target index) and
		// re-plan the remaining spans.
		var reReadAndContinue = function (next) {
			var reread = function (cur) {
				if (!cur) {
					finish();
					return;
				}
				var plan = planParagraph(cur.text, cur.style);
				if (!plan) {
					finish();
					return;
				}
				var item = null;
				if (plan.spans && plan.spans.length) {
					var s = plan.spans[0];
					item = { kind: s.kind, start: s.start, innerStart: s.innerStart, innerEnd: s.innerEnd, end: s.end, key: s.key, opener: s.opener, closer: s.closer, inner: s.inner, url: s.url };
				} else if (plan.heading) {
					item = { kind: "heading", level: plan.heading.level, markerLen: plan.heading.markerLen, marker: plan.heading.marker };
				}
				if (!item) {
					finish();
					return;
				}
				applyItem(item, cur.text, next.targetIndex);
			};
			if (next.targetIndex >= 0) {
				readIndex(next.targetIndex, reread);
			} else {
				readCurrent(reread);
			}
		};
		var applyItem = function (item, text, targetIndex) {
			// v0.1.3: the FIRST mutation of the chain creates the history
			// point, later ones reuse it (Asc.scope does not survive a
			// callCommand, so a flag inside it cannot — the step counter
			// travels with the item instead). One history point per chain
			// = Ctrl+Z undoes the whole conversion, not one span at a time.
			item.step = state.itemStep++;
			Asc.scope.item = item;
			Asc.scope.text = text;
			Asc.scope.targetIndex = (typeof targetIndex === "number" && targetIndex >= 0) ? targetIndex : -1;
			// v0.1.3: remember which paragraph this chain mutates and what
			// its text was BEFORE the mutation — finish() records the undo
			// guard {from, to} from these (from = the marker text Ctrl+Z
			// returns to; for the Enter path the mutated paragraph is the
			// neighbour at targetIndex and `text` is its pre-conversion
			// text, not the empty caret paragraph).
			state.lastTargetIndex = Asc.scope.targetIndex >= 0 ? Asc.scope.targetIndex : (typeof meta.curIndex === "number" ? meta.curIndex : -1);
			state.lastConvertedFrom = text;
			callCommand(buildCommand(function () {
				try {
					var doc = Api.GetDocument();
					// v0.1.3: targetIndex >= 0 converts a neighbour paragraph
					// (Enter-follows-marker); -1 means the caret paragraph.
					var targetIndex = Asc.scope.targetIndex;
					var p = targetIndex >= 0 ? doc.GetAllParagraphs()[targetIndex] : doc.GetCurrentParagraph();
					if (!p) {
						return { ok: false, stage: "paragraph" };
					}
					var text = Asc.scope.text;
					var item = Asc.scope.item;
					if (String(p.GetText() || "").replace(/[\r\n]+$/, "") !== text) {
						return { ok: false, stage: "changed" };
					}
					// fresh ruler for the CURRENT paragraph state: positions
					// measured now, never shifted. The editor corrupts ranges
					// when several deletes run in one command, so ONE item
					// per command — the batch lives in the plan, not in the
					// editor. createRuler is spliced in by buildCommand.
					var provider = {
						prefix: function (k) {
							try {
								return p.GetRange(0, k).GetText().length;
							} catch (e) {
								return null;
							}
						},
						charAt: function (k) {
							try {
								return p.GetRange(k, k + 1).GetText();
							} catch (e) {
								return null;
							}
						}
					};
					var ruler = createRuler(text, provider);
					if (item.kind === "heading") {
						// text-based check: a range GetText can drop the
						// trailing space of the "# " marker
						if (text.slice(0, item.markerLen) !== item.marker) {
							return { ok: true, count: 0, failures: [{ key: "h" + item.level, stage: "marker", actual: text.slice(0, item.markerLen) }] };
						}
						if (item.step === 0) {
							doc.CreateNewHistoryPoint();
						}
						var kH = ruler.resolve(item.markerLen);
						if (kH >= 0) {
							p.GetRange(0, kH).Delete();
						}
						// the delete can leave the marker's space behind
						var afterText = p.GetText();
						if (afterText.charAt(0) === " ") {
							p.GetRange(0, 1).Delete();
						}
						var hs = doc.GetStyle("Heading " + item.level);
						if (hs) {
							p.SetStyle(hs);
						}
						return { ok: true, count: 1, kind: "heading" };
					}
					var kA = ruler.resolve(item.start);
					if (kA < 0) {
						return { ok: true, count: 0, failures: [{ key: item.key, stage: "offset" }] };
					}
					var kC = ruler.resolve(item.end);
					// resolve() drifts by the invisible formatting slots that
					// appear after every previous conversion in the same
					// paragraph, so re-find both markers in the live text by
					// a linear scan (first match from the left is the
					// leftmost span, and the closer is the first match
					// strictly after the opener).
					var openerAt = -1;
					for (var k0 = 0; k0 <= kC - item.opener.length && openerAt < 0; k0++) {
						try {
							if (p.GetRange(k0, k0 + item.opener.length).GetText() === item.opener) {
								openerAt = k0;
							}
						} catch (e) {
							/* probe failed, try next candidate */
						}
					}
					if (openerAt < 0) {
						return { ok: true, count: 0, failures: [{ key: item.key, stage: "opener" }] };
					}
					var closerAt = -1;
					for (var k1 = openerAt + item.opener.length; k1 <= kC + 12 && closerAt < 0; k1++) {
						try {
							if (p.GetRange(k1, k1 + item.closer.length).GetText() === item.closer) {
								closerAt = k1;
							}
						} catch (e) {
							/* probe failed, try next candidate */
						}
					}
					if (closerAt < 0) {
						return { ok: true, count: 0, failures: [{ key: item.key, stage: "closer" }] };
					}
					if (item.step === 0) {
						doc.CreateNewHistoryPoint();
					}
					// Mutate from the right edge first: deleting the closer
					// does not shift the opener, and deleting the opener
					// shifts the inner text back onto openerAt exactly.
					p.GetRange(closerAt, closerAt + item.closer.length).Delete();
					p.GetRange(openerAt, openerAt + item.opener.length).Delete();
					// v0.1.3: the marker deletes leave EMPTY SLOTS in the
					// model (positions whose GetText() is ""), so the inner
					// text does NOT sit at openerAt any more — a range
					// measured from openerAt would cover a slot plus all
					// but the last inner character (bold/caret were off by
					// one). GetText() skips slots, so find the span by its
					// exact text, starting at the old opener position.
					var innerAt = -1;
					for (var kk = openerAt; kk <= openerAt + 32 && innerAt < 0; kk++) {
						try {
							if (p.GetRange(kk, kk + item.inner.length).GetText() === item.inner) {
								innerAt = kk;
							}
						} catch (e) {
							/* probe failed, try next candidate */
						}
					}
					if (innerAt < 0) {
						return { ok: true, count: 0, failures: [{ key: item.key, stage: "inner" }] };
					}
					var innerAfter = p.GetRange(innerAt, innerAt + item.inner.length);
					if (item.kind === "bold") {
						innerAfter.SetBold(true);
					} else if (item.kind === "italic") {
						innerAfter.SetItalic(true);
					} else if (item.kind === "bolditalic") {
						innerAfter.SetBold(true);
						innerAfter.SetItalic(true);
					} else if (item.kind === "strike") {
						innerAfter.SetStrikeout(true);
					} else if (item.kind === "code") {
						// SetColor/SetShd silently no-op on a range reused
						// right after Delete()s in the same editor command
						// (SetFontFamily/SetBold work fine), so the colour
						// and the fill are applied by a second, separate
						// command — see codeFormatStep below.
						innerAfter.SetFontFamily("Consolas");
						return { ok: true, count: 1, kind: item.kind, codeFormat: true, caret: { inner: item.inner, targetIndex: Asc.scope.targetIndex } };
					} else if (item.kind === "link") {
						// v0.1.3: AddHyperlink no-ops in the same command
						// right after the marker deletes (same SDK quirk as
						// SetColor/SetShd), so the hyperlink is attached by
						// a second, separate command — see linkFormatStep.
						return { ok: true, count: 1, kind: item.kind, linkFormat: true, url: item.url, caret: { inner: item.inner, targetIndex: Asc.scope.targetIndex } };
					}
					return { ok: true, count: 1, kind: item.kind, caret: { inner: item.inner, targetIndex: Asc.scope.targetIndex } };
				} catch (e) {
					return { ok: false, error: e.message };
				}
			}), function (res) {
				if (res && res.ok) {
					total += res.count || 0;
				}
				if (res && res.failures && res.failures.length) {
					for (var i = 0; i < res.failures.length; i++) {
						var f = res.failures[i];
						startCooldown(f.key, f.stage === "offset" ? COOLDOWN_BROKEN_MS : COOLDOWN_MS);
						dbg("apply skipped: " + f.stage + (f.actual !== undefined ? " got " + JSON.stringify(f.actual) : ""));
					}
					state.lastFingerprint = null; // re-attempt after the cooldown
					finish();
					return;
				}
				if (res && res.stage) {
					dbg("apply skipped: " + res.stage);
				} else if (res && res.error) {
					dbg("apply error: " + res.error);
				}
				// item 6/7: SetColor/SetShd need their own editor command
				// (they no-op right after the marker deletes), so find the
				// converted inner text again and paint it green on grey
				if (res && res.ok && res.caret) {
					// v0.1.3: remember where the converted span ends —
					// finish() moves the caret right AFTER it instead of
					// to the end of the paragraph (mid-line conversions
					// must not jump the caret to the line end).
					state.caret = res.caret;
				}
				if (res && res.ok && res.codeFormat) {
					Asc.scope.fmt = { inner: item.inner, targetIndex: Asc.scope.targetIndex };
					callCommand(buildCommand(function () {
						try {
							var doc = Api.GetDocument();
							var targetIndex = Asc.scope.fmt.targetIndex;
							var p = targetIndex >= 0 ? doc.GetAllParagraphs()[targetIndex] : doc.GetCurrentParagraph();
							if (!p) {
								return { ok: false, stage: "paragraph" };
							}
							var inner = Asc.scope.fmt.inner;
							var len = inner.length;
							var at = -1;
							for (var k = 0; k <= 256 && at < 0; k++) {
								try {
									if (p.GetRange(k, k + len).GetText() === inner) {
										at = k;
									}
								} catch (e) {
									/* probe failed, try next candidate */
								}
							}
							if (at < 0) {
								return { ok: false, stage: "fmt-inner" };
							}
							var rr = p.GetRange(at, at + len);
							rr.SetColor(0, 128, 0);
							rr.SetShd("clear", 242, 242, 242);
							return { ok: true, count: 0 };
						} catch (e) {
							return { ok: false, error: e.message };
						}
					}), function (res2) {
						if (res2 && res2.stage) {
							dbg("code fmt skip: " + res2.stage);
						} else if (res2 && res2.error) {
							dbg("code fmt error: " + res2.error);
						}
						reReadAndContinue({ targetIndex: Asc.scope.targetIndex });
					});
					return;
				}
				// v0.1.1: AddHyperlink no-ops inside callCommand on ALL web
				// builds (returns null — its internal gate requires an
				// editor selection state the sandbox cannot provide; even
				// Select() in the same or a previous command does not help,
				// verified live on DS 10.0.2). Workaround: select the span
				// in the sandbox — the LIVE selection follows it — and
				// paste an <a> HTML fragment over the selection from the
				// plugin side via PasteHtml. Verified live: the hyperlink
				// appears in the model.
				if (res && res.ok && res.linkFormat) {
					Asc.scope.fmt = { inner: item.inner, url: res.url, targetIndex: Asc.scope.targetIndex };
					callCommand(buildCommand(function () {
						try {
							var doc = Api.GetDocument();
							var targetIndex = Asc.scope.fmt.targetIndex;
							var p = targetIndex >= 0 ? doc.GetAllParagraphs()[targetIndex] : doc.GetCurrentParagraph();
							if (!p) {
								return { ok: false, stage: "paragraph" };
							}
							var inner = Asc.scope.fmt.inner;
							var len = inner.length;
							var at = -1;
							for (var k = 0; k <= 256 && at < 0; k++) {
								try {
									if (p.GetRange(k, k + len).GetText() === inner) {
										at = k;
									}
								} catch (e) {
									/* probe failed, try next candidate */
								}
							}
							if (at < 0) {
								return { ok: false, stage: "fmt-inner" };
							}
							p.GetRange(at, at + len).Select();
							return { ok: true };
						} catch (e) {
							return { ok: false, error: e.message };
						}
					}), function (resA) {
						if (!resA || !resA.ok) {
							dbg("link select skip: " + (resA && (resA.stage || resA.error) || "?"));
							reReadAndContinue({ targetIndex: Asc.scope.targetIndex });
							return;
						}
						var esc = function (s) {
							return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
						};
						var href = esc(res.url).replace(/"/g, "&quot;");
						var html = '<a href="' + href + '">' + esc(item.inner) + "</a>";
						window.Asc.plugin.executeMethod("PasteHtml", [html], function () {
							callCommand(buildCommand(function () {
								try {
									var doc = Api.GetDocument();
									var targetIndex = Asc.scope.fmt.targetIndex;
									var p = targetIndex >= 0 ? doc.GetAllParagraphs()[targetIndex] : doc.GetCurrentParagraph();
									if (!p) {
										return { ok: false, stage: "paragraph" };
									}
									var made = false;
									try {
										var j = JSON.stringify(p.ToJSON());
										made = j.toLowerCase().indexOf("hyperlink") >= 0;
									} catch (e) {
										/* cannot verify */
									}
									return { ok: true, count: 0, linkMade: made };
								} catch (e) {
									return { ok: false, error: e.message };
								}
							}), function (resB) {
								if (resB && resB.ok && resB.linkMade === false) {
									dbg("link fmt: no hyperlink in the model after PasteHtml");
								}
								reReadAndContinue({ targetIndex: Asc.scope.targetIndex });
							});
						});
					});
					return;
				}
				// re-read the paragraph and re-plan: the mutations changed it
				reReadAndContinue({ targetIndex: Asc.scope.targetIndex });
			});
		};
		var plan = null;
		var first = null;
		if (fenceClose) {
			// the fence close converts the neighbouring paragraphs one at a
			// time (multi-paragraph mutations in a single editor command
			// wedge the SDK), from the opening marker down to the closing
			// one, which becomes Normal again
			var fenceTexts = meta.fenceTexts || null;
			if (!fenceTexts || typeof fenceTexts[fenceClose.from] !== "string" || typeof fenceTexts[fenceClose.to] !== "string") {
				releaseAndRescan();
				return;
			}
			dbg("apply: fence close [" + fenceClose.from + ".." + fenceClose.to + "]");
			// v0.1.4: the whole block is mutated in ONE editor command so
			// that ONE history point covers the entire conversion and
			// Ctrl+Z restores all the markdown at once (the SDK closes the
			// history point after every command). The shared
			// fenceBlockBody() removes both marker paragraphs entirely —
			// the surrounding text shifts up like real markdown typesetting.
			Asc.scope.fence = { from: fenceClose.from, to: fenceClose.to, texts: fenceTexts };
			callCommand(buildCommand(function () {
				return fenceBlockBody();
			}), function (res) {
				if (res && res.ok) {
					total += res.count || 0;
				} else if (res && res.stage) {
					dbg("fence skip: " + res.stage + (typeof res.at === "number" ? " at " + res.at : ""));
				} else if (res && res.error) {
					dbg("fence error: " + res.error);
				}
				finish();
				if (res && res.ok) {
					total += res.count || 0;
				} else if (res && res.stage) {
					dbg("fence skip: " + res.stage + (typeof res.at === "number" ? " at " + res.at : ""));
				} else if (res && res.error) {
					dbg("fence error: " + res.error);
				}
				finish();
			});
			return;
		}
		// v0.1.3: "Enter finishes the marker". The caret moved to the new
		// EMPTY paragraph, the marker sits in the PREVIOUS one. GetText is
		// stripped of its "\r\n" mark now, so the marker at the end of the
		// previous paragraph is no longer "auto-finished" by the mark —
		// this branch converts it on the real Enter keystroke. It is gated
		// on the Enter signal captured at chain start (pendingEnter): only
		// the editor's empty-paragraph event raises it, so a plain mouse
		// click into an empty paragraph (poll) can never re-convert the
		// neighbour. The signal is consumed here — both when a conversion
		// follows and when the previous paragraph turns out to have no
		// marker — so a stale flag cannot leak into a later click.
		if (text === "" && meta.pendingEnter && typeof meta.curIndex === "number" && meta.curIndex > 0) {
			state.pendingEnter = false; // consumed
			if (typeof meta.prevText === "string" && meta.prevText !== "" && !isFenceMarker(meta.prevText)) {
				var prevPlan = planParagraph(meta.prevText + "\r\n", meta.prevStyle || "");
				if (prevPlan) {
					dbg("enter: convert previous paragraph #" + (meta.curIndex - 1));
					var enterApply = function (idx, prevText, prevStyle) {
						var p2 = planParagraph(prevText + "\r\n", prevStyle || "");
						if (!p2) {
							finish();
							return;
						}
						var item2 = null;
						if (p2.spans && p2.spans.length) {
							var s2 = p2.spans[0];
							item2 = { kind: s2.kind, start: s2.start, innerStart: s2.innerStart, innerEnd: s2.innerEnd, end: s2.end, key: s2.key, opener: s2.opener, closer: s2.closer, inner: s2.inner, url: s2.url };
						} else if (p2.heading) {
							item2 = { kind: "heading", level: p2.heading.level, markerLen: p2.heading.markerLen, marker: p2.heading.marker };
						}
						if (!item2) {
							finish();
							return;
						}
						applyItem(item2, prevText, idx);
					};
					enterApply(meta.curIndex - 1, meta.prevText, meta.prevStyle || "");
					return;
				}
			}
		}
		plan = planParagraph(text, style);
		if (!plan) {
			releaseAndRescan();
			return;
		}
		if (plan.spans && plan.spans.length) {
			var s = plan.spans[0];
			first = { kind: s.kind, start: s.start, innerStart: s.innerStart, innerEnd: s.innerEnd, end: s.end, key: s.key, opener: s.opener, closer: s.closer, inner: s.inner, url: s.url };
		} else if (plan.heading) {
			first = { kind: "heading", level: plan.heading.level, markerLen: plan.heading.markerLen, marker: plan.heading.marker };
		}
		if (!first) {
			releaseAndRescan();
			return;
		}
		dbg("apply: " + (plan.heading ? " h" + plan.heading.level : "") + (plan.spans && plan.spans.length ? " spans=" + plan.spans.length : ""));
		applyItem(first, text);
	}

	// ------------------------------------------------------ convert document

	function convertDocument(callback) {
		if (!state.ready) {
			if (callback) {
				callback({ ok: false, stage: "not-ready" });
			}
			return;
		}
		if (state.busy || state.docBusy) {
			if (callback) {
				callback({ ok: false, stage: "busy" });
			}
			return;
		}
		state.docBusy = true;
		state.busy = true;
		state.busySince = Date.now();
		state.chainId++;
		// phase 1 (editor): read every paragraph (text + style)
		callCommand(function () {
			try {
				var doc = Api.GetDocument();
				var paras = doc.GetAllParagraphs();
				var out = [];
				for (var i = 0; i < paras.length && i < 2000; i++) {
					var styleName = "";
					try {
						var st = paras[i].GetStyle();
						styleName = st ? st.GetName() : "";
					} catch (e) {
						styleName = "";
					}
					var text = "";
					try {
						text = paras[i].GetText();
					} catch (e) {
						text = "";
					}
					out.push({ text: text, style: styleName });
				}
				return { ok: true, paragraphs: out };
			} catch (e) {
				return { ok: false, error: e.message };
			}
		}, function (read) {
			if (!read || !read.ok) {
				state.busy = false;
				state.docBusy = false;
				if (callback) {
					callback(null);
				}
				return;
			}
			// phase 2 (plugin): plan conversions per paragraph. Fence marker
			// lines pair up: everything from an opening "```" to its closing
			// "```" becomes one Code Block; an unpaired marker stays plain
			// text (item 4). plans[] keeps paragraph indexes (null = no
			// conversion).
			var plans = [];
			var inCode = false;
			var openIdx = -1;
			var fenceBlocks = [];
			for (var i = 0; i < read.paragraphs.length; i++) {
				var para = read.paragraphs[i];
				var plan = null;
				if (isFenceMarker(para.text)) {
					if (!inCode) {
						inCode = true;
						openIdx = i;
					} else {
						plans[i] = { fence: { close: true, from: openIdx, to: i } };
						inCode = false;
					}
				} else if (!inCode && para.style !== CODE_BLOCK_STYLE) {
					plan = planParagraph(para.text, para.style);
				}
				if (plan) {
					plans[i] = plan;
				}
			}
			// mutation items: (paragraph, span) pairs, left-to-right; the
			// whole-document conversion runs ONE item per editor command —
			// the editor corrupts ranges when several deletes run in one
			// command, so positions are measured fresh for every mutation
			var items = [];
			for (var i = 0; i < plans.length; i++) {
				var plan = plans[i];
				if (!plan) {
					continue;
				}
				if (plan.fence && plan.fence.close) {
					// v0.1.4: the whole block is converted by ONE command
					// (fenceBlockBody) in a separate bottom-up pass after
					// the span/heading items — marker paragraphs are then
					// removed entirely, and since the pass runs from the
					// LAST block upwards, the removals never shift the
					// indices of the blocks still waiting
					fenceBlocks.push(plan.fence);
					continue;
				}
				for (var j = 0; j < plan.spans.length; j++) {
					var s = plan.spans[j];
					items.push({ i: i, kind: s.kind, start: s.start, innerStart: s.innerStart, innerEnd: s.innerEnd, end: s.end, key: s.key, opener: s.opener, closer: s.closer, inner: s.inner, url: s.url });
				}
				if (plan.heading) {
					items.push({ i: i, kind: "heading", level: plan.heading.level, markerLen: plan.heading.markerLen, marker: plan.heading.marker });
				}
			}
			Asc.scope.items = items;
			Asc.scope.reads = read.paragraphs;
			Asc.scope.texts = {};
			for (var t = 0; t < read.paragraphs.length; t++) {
				Asc.scope.texts[t] = read.paragraphs[t].text;
			}
			var count = 0;
			// v0.1.4: fence blocks are converted in a separate bottom-up
			// pass AFTER the span/heading items — paragraph removals then
			// never shift the item indices of the main pass
			var runFencePass = function (done) {
				var runOne = function (k) {
					if (k < 0) {
						done();
						return;
					}
					var fb = fenceBlocks[k];
					Asc.scope.fence = { from: fb.from, to: fb.to, texts: Asc.scope.texts };
					callCommand(buildCommand(function () {
						return fenceBlockBody();
					}), function (res) {
						if (res && res.ok) {
							count += res.count || 0;
						} else if (res && res.stage) {
							dbg("doc fence skip: " + res.stage + (typeof res.at === "number" ? " at " + res.at : ""));
						} else if (res && res.error) {
							dbg("doc fence error: " + res.error);
						}
						runOne(k - 1);
					});
				};
				runOne(fenceBlocks.length - 1);
			};
			var next = function (index) {
				if (index >= items.length) {
					runFencePass(function () {
						// v0.1.3: record {from, to} for every converted paragraph
						// so Ctrl+Z after "Convert whole document" does not
						// re-convert the caret paragraph (one extra read command
						// for the whole document)
						callCommand(function () {
							try {
								var doc = Api.GetDocument();
								var paras = doc.GetAllParagraphs();
								var out = [];
								for (var i = 0; i < paras.length && i < 2000; i++) {
									out.push(String(paras[i].GetText() || "").replace(/[\r\n]+$/, ""));
								}
								return { ok: true, texts: out };
							} catch (e) {
								return { ok: false, error: e.message };
							}
						}, function (res) {
							if (res && res.ok) {
								// v0.1.4: the fence pass may have REMOVED marker
								// paragraphs, so every item's paragraph now sits
								// at a shifted index — map each item through the
								// number of removed positions before it
								var removedPos = [];
								for (var b = 0; b < fenceBlocks.length; b++) {
									removedPos.push(fenceBlocks[b].from, fenceBlocks[b].to);
								}
								var texts = Asc.scope.texts;
								for (var k = 0; k < items.length; k++) {
									var it = items[k];
									var shift = 0;
									for (var r = 0; r < removedPos.length; r++) {
										if (removedPos[r] < it.i) {
											shift++;
										}
									}
									var pi = it.i - shift;
									if (pi >= 0 && pi < res.texts.length && typeof texts[it.i] === "string") {
										state.lastConverted[pi] = { from: texts[it.i], to: res.texts[pi] };
									}
								}
							}
							state.busy = false;
							state.docBusy = false;
							if (callback) {
								callback({ ok: true, count: count });
							}
					});
					});
					return;
				}
				// v0.1.3: one history point for the whole document — the
				// FIRST item creates it, later items reuse it (Ctrl+Z after
				// "Convert whole document" reverts everything at once).
				items[index].step = index;
				Asc.scope.item = items[index];
				callCommand(buildCommand(function () {
					try {
						var doc = Api.GetDocument();
						var paras = doc.GetAllParagraphs();
						var item = Asc.scope.item;
						var reads = Asc.scope.reads;
						var texts = Asc.scope.texts;
						if (item.i >= paras.length) {
							return { ok: false, stage: "index" };
						}
						var p = paras[item.i];
						var text = texts[item.i];
						if (p.GetText() !== text) {
							return { ok: false, stage: "changed" };
						}
						var provider = {
							prefix: function (k) {
								try {
									return p.GetRange(0, k).GetText().length;
								} catch (e) {
									return null;
								}
							},
							charAt: function (k) {
								try {
									return p.GetRange(k, k + 1).GetText();
								} catch (e) {
									return null;
								}
							}
						};
						var ruler = createRuler(text, provider);
						if (item.kind === "heading") {
							var kHM = ruler.resolve(item.markerLen);
							var markerText = null;
							try {
								markerText = kHM >= 0 ? p.GetRange(0, kHM).GetText() : null;
							} catch (e) {
								markerText = null;
							}
							if (markerText !== item.marker) {
								return { ok: false, stage: "marker" };
							}
							if (item.step === 0) {
								doc.CreateNewHistoryPoint();
							}
							if (kHM >= 0) {
								p.GetRange(0, kHM).Delete();
							}
							var hs = doc.GetStyle("Heading " + item.level);
							if (hs) {
								p.SetStyle(hs);
							}
							return { ok: true, count: 1 };
						}
						var kA = ruler.resolve(item.start);
						if (kA < 0) {
							return { ok: false, stage: "offset" };
						}
						var kC = ruler.resolve(item.end);
						if (kC < 0) {
							return { ok: false, stage: "offset" };
						}
						// resolve() drifts by the invisible formatting slots
						// that appear after every previous conversion in the
						// same paragraph, so re-find both markers in the live
						// text by a linear scan (first match from the left is
						// the leftmost span, and the closer is the first
						// match strictly after the opener).
						var openerAt = -1;
						for (var k0 = 0; k0 <= kC - item.opener.length && openerAt < 0; k0++) {
							try {
								if (p.GetRange(k0, k0 + item.opener.length).GetText() === item.opener) {
									openerAt = k0;
								}
							} catch (e) {
								/* probe failed, try next candidate */
							}
						}
						if (openerAt < 0) {
							return { ok: false, stage: "opener" };
						}
						var closerAt = -1;
						for (var k1 = openerAt + item.opener.length; k1 <= kC + 12 && closerAt < 0; k1++) {
							try {
								if (p.GetRange(k1, k1 + item.closer.length).GetText() === item.closer) {
									closerAt = k1;
								}
							} catch (e) {
								/* probe failed, try next candidate */
							}
						}
						if (closerAt < 0) {
							return { ok: false, stage: "closer" };
						}
						if (item.step === 0) {
							doc.CreateNewHistoryPoint();
						}
						// Mutate from the right edge first: deleting the
						// closer does not shift the opener, and deleting the
						// opener shifts the inner text back onto openerAt
						// exactly.
						p.GetRange(closerAt, closerAt + item.closer.length).Delete();
						p.GetRange(openerAt, openerAt + item.opener.length).Delete();
						// v0.1.3: the marker deletes leave empty slots in
						// the model, so find the inner span by its exact
						// text (GetText() skips slots) — a range measured
						// from openerAt would be off by one character.
						var innerAt = -1;
						for (var kk2 = openerAt; kk2 <= openerAt + 32 && innerAt < 0; kk2++) {
							try {
								if (p.GetRange(kk2, kk2 + item.inner.length).GetText() === item.inner) {
									innerAt = kk2;
								}
							} catch (e) {
								/* probe failed, try next candidate */
							}
						}
						if (innerAt < 0) {
							return { ok: false, stage: "inner" };
						}
						var innerAfter = p.GetRange(innerAt, innerAt + item.inner.length);
						if (item.kind === "bold") {
							innerAfter.SetBold(true);
						} else if (item.kind === "italic") {
							innerAfter.SetItalic(true);
						} else if (item.kind === "bolditalic") {
							innerAfter.SetBold(true);
							innerAfter.SetItalic(true);
						} else if (item.kind === "strike") {
							innerAfter.SetStrikeout(true);
						} else if (item.kind === "code") {
							// colour + fill need a separate editor command
							// (they no-op right after the marker deletes)
							innerAfter.SetFontFamily("Consolas");
							return { ok: true, count: 1, codeFormat: true };
						} else if (item.kind === "link") {
							// v0.1.3: the hyperlink needs its own command
							// (AddHyperlink no-ops after the marker deletes)
							return { ok: true, count: 1, linkFormat: true, url: item.url };
						}
						return { ok: true, count: 1 };
					} catch (e) {
						return { ok: false, error: e.message };
					}
				}), function (res) {
					if (res && res.ok) {
						count += res.count || 0;
					}
					if (res && res.stage) {
						dbg("doc skip: " + res.stage);
					} else if (res && res.error) {
						dbg("doc error: " + res.error);
					}
					if (res && res.ok && res.codeFormat) {
						// colour + fill in a separate command (see cursor
						// path); the paragraph index survived the mutation
						Asc.scope.fmt = { inner: items[index].inner, i: items[index].i };
						callCommand(buildCommand(function () {
							try {
								var doc = Api.GetDocument();
								var paras = doc.GetAllParagraphs();
								var fmt = Asc.scope.fmt;
								if (fmt.i < 0 || fmt.i >= paras.length) {
									return { ok: false, stage: "fmt-index" };
								}
								var p = paras[fmt.i];
								var inner = fmt.inner;
								var len = inner.length;
								var at = -1;
								for (var k = 0; k <= 256 && at < 0; k++) {
									try {
										if (p.GetRange(k, k + len).GetText() === inner) {
											at = k;
										}
									} catch (e) {
										/* probe failed, try next candidate */
									}
								}
								if (at < 0) {
									return { ok: false, stage: "fmt-inner" };
								}
								var rr = p.GetRange(at, at + len);
								rr.SetColor(0, 128, 0);
								rr.SetShd("clear", 242, 242, 242);
								return { ok: true, count: 0 };
							} catch (e) {
								return { ok: false, error: e.message };
							}
						}), function (res2) {
							if (res2 && res2.stage) {
								dbg("doc code fmt skip: " + res2.stage);
							} else if (res2 && res2.error) {
								dbg("doc code fmt error: " + res2.error);
							}
							next(index + 1);
						});
						return;
					}
					if (res && res.ok && res.linkFormat) {
						// v0.1.1: AddHyperlink no-ops inside callCommand (see
						// the live-path comment) — select the span and paste
						// an <a> fragment via PasteHtml from the plugin side.
						Asc.scope.fmt = { inner: items[index].inner, url: res.url, i: items[index].i };
						callCommand(buildCommand(function () {
							try {
								var doc = Api.GetDocument();
								var paras = doc.GetAllParagraphs();
								var fmt = Asc.scope.fmt;
								if (fmt.i < 0 || fmt.i >= paras.length) {
									return { ok: false, stage: "fmt-index" };
								}
								var p = paras[fmt.i];
								var inner = fmt.inner;
								var len = inner.length;
								var at = -1;
								for (var k = 0; k <= 256 && at < 0; k++) {
									try {
										if (p.GetRange(k, k + len).GetText() === inner) {
											at = k;
										}
									} catch (e) {
										/* probe failed, try next candidate */
									}
								}
								if (at < 0) {
									return { ok: false, stage: "fmt-inner" };
								}
								p.GetRange(at, at + len).Select();
								return { ok: true };
							} catch (e) {
								return { ok: false, error: e.message };
							}
						}), function (resA) {
							if (!resA || !resA.ok) {
								dbg("doc link select skip: " + (resA && (resA.stage || resA.error) || "?"));
								next(index + 1);
								return;
							}
							var esc = function (s) {
								return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
							};
							var href = esc(res.url).replace(/"/g, "&quot;");
							var html = '<a href="' + href + '">' + esc(items[index].inner) + "</a>";
							window.Asc.plugin.executeMethod("PasteHtml", [html], function () {
								callCommand(buildCommand(function () {
									try {
										var doc = Api.GetDocument();
										var paras = doc.GetAllParagraphs();
										var fmt = Asc.scope.fmt;
										if (fmt.i < 0 || fmt.i >= paras.length) {
											return { ok: false, stage: "fmt-index" };
										}
										var made = false;
										try {
											var j = JSON.stringify(paras[fmt.i].ToJSON());
											made = j.toLowerCase().indexOf("hyperlink") >= 0;
										} catch (e) {
											/* cannot verify */
										}
										return { ok: true, count: 0, linkMade: made };
									} catch (e) {
										return { ok: false, error: e.message };
									}
								}), function (resB) {
									if (resB && resB.ok && resB.linkMade === false) {
										dbg("doc link fmt: no hyperlink in the model after PasteHtml");
									}
									next(index + 1);
								});
							});
						});
						return;
					}
					if (res && res.ok && res.count > 0) {
						// the mutation changed the paragraph: re-read it and
						// re-plan its REMAINING items. texts[] holds the
						// snapshot from phase 1, so a second span of the same
						// paragraph would otherwise always fail the
						// text-equality check ("doc skip: changed").
						Asc.scope.planIdx = items[index].i;
						callCommand(function () {
							var doc = Api.GetDocument();
							var paras = doc.GetAllParagraphs();
							var i = Asc.scope.planIdx;
							if (i >= paras.length) {
								return { ok: false };
							}
							var styleName = "";
							try {
								var st = paras[i].GetStyle();
								styleName = st ? st.GetName() : "";
							} catch (e) {
								styleName = "";
							}
							return { ok: true, text: paras[i].GetText(), style: styleName };
						}, function (read2) {
							if (read2 && read2.ok) {
								var paraIdx = items[index].i;
								Asc.scope.texts[paraIdx] = read2.text;
								var replan = planParagraph(read2.text, read2.style || "");
								var kept = [];
								for (var k = index + 1; k < items.length; k++) {
									if (items[k].i !== paraIdx) {
										kept.push(items[k]);
									}
								}
								var fresh = [];
								if (replan) {
									for (var j = 0; j < replan.spans.length; j++) {
										var s = replan.spans[j];
										fresh.push({ i: paraIdx, kind: s.kind, start: s.start, innerStart: s.innerStart, innerEnd: s.innerEnd, end: s.end, key: s.key, opener: s.opener, closer: s.closer, inner: s.inner, url: s.url });
									}
									if (replan.heading) {
										fresh.push({ i: paraIdx, kind: "heading", level: replan.heading.level, markerLen: replan.heading.markerLen, marker: replan.heading.marker });
									}
								}
								items = items.slice(0, index + 1).concat(fresh).concat(kept);
							}
							next(index + 1);
						});
						return;
					}
					next(index + 1);
				});
			};
			next(0);
		});
	}

	// ------------------------------------------------------------------ exports

	root.MdAutoformatEngine = {
		init: init,
		onDocumentReady: onDocumentReady,
		isEnabled: isEnabled,
		setEnabled: setEnabled,
		toggle: toggle,
		scheduleScan: scheduleScan,
		convertDocument: convertDocument,
		_debug: function () {
			return JSON.stringify({
				enabled: isEnabled(),
				ready: state.ready,
				busy: state.busy,
				docBusy: state.docBusy,
				dirty: state.dirty,
				eventMode: state.eventMode,
				lastFp: state.lastFingerprint ? state.lastFingerprint.slice(-20) : null,
				cooldown: state.cooldown ? state.cooldown.key : null,
				logEntries: (JSON.parse(localStorage.getItem("mdAutoformat.log") || "[]")).length
			});
		}
	};
})(window);
