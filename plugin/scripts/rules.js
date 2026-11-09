/*
 * Pure, dependency-free scanner that finds markdown constructions in plain text.
 *
 * Never mutates its input: returns spans described by character offsets so the
 * caller can map them onto ONLYOFFICE paragraph positions.
 *
 * Loadable both as a CommonJS module (node --test) and as a plain script that
 * exposes `window.MdAutoformatRules` inside the plugin iframe.
 */
(function (root, factory) {
	if (typeof module === "object" && module.exports) {
		module.exports = factory();
	} else {
		root.MdAutoformatRules = factory();
	}
})(typeof self !== "undefined" ? self : this, function () {
	"use strict";

	var CODE_BLOCK_STYLE = "Code Block";
	var MAX_PASSES = 10;

	function isWhitespace(ch) {
		return ch === " " || ch === "\t" || ch === "\r" || ch === "\n";
	}

	function isAlnum(ch) {
		return (
			(ch >= "a" && ch <= "z") ||
			(ch >= "A" && ch <= "Z") ||
			(ch >= "0" && ch <= "9") ||
			ch.charCodeAt(0) > 127 // Cyrillic etc. count as word chars
		);
	}

	// The conversion triggers when a SPACE follows the closing delimiter
	// (Google-Docs-style: the space is the explicit "done typing" signal).
	// Pressing Enter/Shift+Enter right after the closer is an equivalent
	// signal: without it a marker typed at the end of a line would stay
	// unconverted forever.
	function closerOk(text, index) {
		if (index >= text.length) {
			return false; // no trailing space - not a trigger yet
		}
		var rest = text.slice(index);
		if (/^[ \t]/.test(rest)) {
			return true;
		}
		return /^[\r\n]+$/.test(rest);
	}

	// The opening delimiter must be preceded by start-of-line, whitespace or
	// punctuation (no letters/digits right before).
	function openerOk(text, index) {
		if (index === 0) {
			return true;
		}
		var ch = text.charAt(index - 1);
		if (isWhitespace(ch)) {
			return true;
		}
		return ".,;:!?([{\"'\u00AB\u00BB".indexOf(ch) !== -1;
	}

	function contentOk(content) {
		return content.length > 0 && !isWhitespace(content.charAt(0)) && !isWhitespace(content.charAt(content.length - 1));
	}

	/**
	 * Try to match `re` (sticky) at `index`.
	 * `openLen` is the marker length before the content; the closing marker
	 * length is `closeLen` (defaults to openLen). For links pass the url
	 * group index: the closing marker is "](url)".
	 */
	function tryMatch(text, index, re, kind, openLen, urlGroup) {
		re.lastIndex = index;
		var m = re.exec(text);
		if (!m) {
			return null;
		}
		var start = index;
		var end = re.lastIndex;
		var content = m[1];
		var url = null;
		var closeLen = openLen;
		if (urlGroup) {
			url = m[urlGroup];
			closeLen = url.length + 3; // "]" + "(" + url + ")"
		}
		var innerStart = start + openLen;
		var innerEnd = end - closeLen;
		if (!contentOk(content)) {
			return null;
		}
		if (!openerOk(text, start)) {
			return null;
		}
		if (!closerOk(text, end)) {
			return null;
		}
		if (kind === "italic" || kind === "bold") {
			// underscore variants must not sit inside a word (snake_case)
			if (text.charAt(index) === "_") {
				if (start > 0 && isAlnum(text.charAt(start - 1))) {
					return null;
				}
				if (end < text.length && isAlnum(text.charAt(end))) {
					return null;
				}
			}
		}
		return {
			kind: kind,
			start: start,
			end: end,
			innerStart: innerStart,
			innerEnd: innerEnd,
			url: url
		};
	}

	// url guard: well-known schemes OR a bare domain with a dot
	// ("example.com") convert; single-word targets stay text so that
	// "(see [1](note))" does not become a link (v0.1.3: bare domains now
	// convert — the old scheme-only guard skipped "[text](example.com)").
	function linkUrlOk(url) {
		return /^(https?:\/\/|www\.|mailto:|ftp:\/\/)/i.test(url) || /^[^.\s]+\.[^.\s]+/.test(url);
	}

	var RE_CODE = /`([^`\n]+)`/y;
	var RE_BOLD_ITALIC_STAR = /\*\*\*(.+?)\*\*\*/y;
	var RE_BOLD_US = /__([^_]+?)__/y;
	// v0.1.3: the content may contain a single "*" ("**a * b**" is bold) —
	// the old [^*] class rejected it. Lazy match stops at the FIRST closing
	// "**"; an inner "*" can never close the span, so this stays safe. The
	// opener guard (openerOk) still rejects "***x**" leftovers: the second
	// star of a *** would open with a "*" right before it.
	var RE_BOLD_STAR = /\*\*(.+?)\*\*/y;
	var RE_STRIKE = /~~([^~]+?)~~/y;
	var RE_ITALIC_US = /_([^_\n]+?)_/y;
	var RE_ITALIC_STAR = /\*([^*\n]+?)\*/y;
	var RE_LINK = /\[([^\]\n]+)\]\(([^()\s]+)\)/y;

	/**
	 * Find the leftmost convertible span in `text`.
	 * Returns {kind, start, end, innerStart, innerEnd, url} or null.
	 */
	function scanOne(text) {
		for (var i = 0; i < text.length; i++) {
			var ch = text.charAt(i);
			var m = null;
			if (ch === "`") {
				m = tryMatch(text, i, RE_CODE, "code", 1);
			} else if (ch === "_" && text.charAt(i + 1) === "_") {
				m = tryMatch(text, i, RE_BOLD_US, "bold", 2);
			} else if (ch === "*" && text.charAt(i + 1) === "*" && text.charAt(i + 2) === "*") {
				m = tryMatch(text, i, RE_BOLD_ITALIC_STAR, "bolditalic", 3);
			} else if (ch === "*" && text.charAt(i + 1) === "*") {
				m = tryMatch(text, i, RE_BOLD_STAR, "bold", 2);
			} else if (ch === "~" && text.charAt(i + 1) === "~") {
				m = tryMatch(text, i, RE_STRIKE, "strike", 2);
			} else if (ch === "_") {
				m = tryMatch(text, i, RE_ITALIC_US, "italic", 1);
			} else if (ch === "*") {
				m = tryMatch(text, i, RE_ITALIC_STAR, "italic", 1);
			} else if (ch === "[") {
				m = tryMatch(text, i, RE_LINK, "link", 1, 2);
				if (m && !linkUrlOk(m.url)) {
					m = null;
				}
			}
			if (m) {
				return m;
			}
		}
		return null;
	}

	/**
	 * "# Title" -> {level, markerLen}. Requires the space after #'s
	 * (CommonMark style). Returns null otherwise.
	 */
	function detectHeading(text) {
		var m = /^(#{1,6}) /.exec(text);
		if (!m) {
			return null;
		}
		return { level: m[1].length, markerLen: m[1].length + 1 };
	}

	/**
	 * Fence marker line: "```" optionally followed by a language name, and
	 * NOTHING else (no inline text after the marker — "``` text" stays plain
	 * text). Marker lines are never converted by themselves: the code block
	 * materialises only when the closing marker is typed and Enter pressed
	 * (Google-Docs behaviour), which the engine detects from the neighbour
	 * paragraphs and applies as one multi-paragraph mutation.
	 */
	function isFenceMarker(text) {
		var s = String(text || "").replace(/\r\n$/, "");
		return /^```[^\s\r\n]*$/.test(s);
	}

	function detectFence(text) {
		if (!isFenceMarker(text)) {
			return null;
		}
		return { marker: true };
	}

	/**
	 * Map GetText offsets onto model positions of a paragraph.
	 *
	 * `lens[k]` is the rendered length of GetRange(0,k).GetText() and
	 * `chars[k]` the rendered single char of GetRange(k,k+1) (both measured
	 * in the editor). Positions stay exact even when the span crosses a soft
	 * line break: for every target offset the first position is taken whose
	 * prefix length equals the offset AND whose single char renders exactly
	 * text.charAt(offset) — this filters out break-interior positions that
	 * share the same prefix length. Boundaries that fall onto the paragraph
	 * mark ("\r\n") have no renderable char of their own (the mark is one
	 * model position and is preceded by padding), so for those offsets the
	 * first position with the right prefix length is accepted as-is.
	 */
	function resolveOffsets(text, lens, chars, offsets) {
		var markStart = text.length >= 2 && text.slice(text.length - 2) === "\r\n" ? text.length - 2 : -1;
		var res = [];
		for (var i = 0; i < offsets.length; i++) {
			var o = offsets[i];
			var found = -1;
			for (var k = 0; k < lens.length; k++) {
				if (lens[k] !== o) {
					continue;
				}
				if (o < text.length && o < markStart && chars[k] !== text.charAt(o)) {
					continue;
				}
				found = k;
				break;
			}
			if (found < 0) {
				return null;
			}
			res.push(found);
		}
		return res;
	}

	/**
	 * First convertible span only. The engine applies it, re-reads the
	 * paragraph text and calls scanOne again until no match remains
	 * (positions stay valid because they are recomputed on fresh text).
	 */
	function scanAll(text) {
		var m = scanOne(text);
		return m ? [m] : [];
	}

	/**
	 * Lazy position ruler with binary search.
	 *
	 * resolveOffsets() above needs the FULL ruler (one GetRange per paragraph
	 * position) which is O(n) editor calls per conversion — on a long
	 * paragraph that is seconds of work and the reason conversions stalled.
	 * The resolver below answers the same question ("which model position
	 * renders text offset o?") with ~log(n) prefix probes + a short plateau
	 * walk, sharing one probe cache across all spans of a paragraph.
	 *
	 * `provider` is editor-side and lazy:
	 *   prefix(k) -> rendered length of GetRange(0, k).GetText(), or null
	 *   charAt(k) -> rendered single char of GetRange(k, k + 1), or null
	 * `hiBound` caps the probe range (paragraph mark + padding live just
	 * past text.length).
	 *
	 * Semantics mirror resolveOffsets(): the first position whose prefix
	 * length equals the target offset AND — for offsets before the paragraph
	 * mark — whose single char renders exactly text.charAt(offset).
	 * Boundaries on the paragraph mark (or past the text) accept the first
	 * position with the right prefix length as-is. Returns -1 when the
	 * offset cannot be resolved (same as resolveOffsets() returning null).
	 */
	function createRuler(text, provider, hiBound) {
		var cache = {};
		// Model positions trail text offsets by break padding. A fixed bound
		// is a guess (padding per break varies ~2.5–3.6, measured live), so
		// the bound ADAPTS: while the prefix at the bound still grows, the
		// paragraph extends beyond it and the bound is stretched. The v0.1.1
		// stall came from a fixed text.length + 6 bound that cut the ruler
		// short on break-heavy paragraphs — tail spans became unresolvable.
		var hi = typeof hiBound === "number" ? hiBound : text.length + 8;
		var markStart = text.length >= 2 && text.slice(text.length - 2) === "\r\n" ? text.length - 2 : -1;

		function ensureHi() {
			var guard = 0;
			while (guard++ < 24) {
				var v = prefix(hi);
				if (v === null || v >= text.length) {
					return;
				}
				hi += 64; // stretch: content still continues past the bound
			}
		}

		function prefix(k) {
			if (k < 0 || k > hi) {
				return null;
			}
			if (cache[k] === undefined) {
				cache[k] = provider.prefix(k);
			}
			return cache[k];
		}

		function resolve(o) {
			if (o < 0 || o > text.length) {
				return -1;
			}
			ensureHi();
			// binary search: first k in [0..hi] with prefix(k) >= o
			var a = 0;
			var b = hi;
			var first = -1;
			while (a <= b) {
				var mid = (a + b) >> 1;
				var v = prefix(mid);
				if (v === null) {
					return -1;
				}
				if (v >= o) {
					first = mid;
					b = mid - 1;
				} else {
					a = mid + 1;
				}
			}
			if (first < 0) {
				return -1;
			}
			// walk the plateau of positions sharing prefix length == o
			// (capped: past the paragraph mark the plateau is unbounded)
			for (var k = first, walked = 0; k <= hi && walked < 32; k++, walked++) {
				var v2 = prefix(k);
				if (v2 === null || v2 !== o) {
					break;
				}
				if (o < text.length && o < markStart) {
					if (provider.charAt(k) === text.charAt(o)) {
						return k;
					}
				} else {
					return k; // end-of-text / paragraph-mark boundary
				}
			}
			return -1;
		}

		return { resolve: resolve };
	}

	return {
		scanOne: scanOne,
		scanAll: scanAll,
		detectHeading: detectHeading,
		detectFence: detectFence,
		isFenceMarker: isFenceMarker,
		resolveOffsets: resolveOffsets,
		createRuler: createRuler,
		// The resolver is fully self-contained (only its parameters and
		// locals), so its SOURCE can be shipped into the editor's callCommand
		// sandbox — that scope has `Api` and `Asc.scope` but no plugin
		// closures, and the ruler must probe GetRange there.
		createRulerSource: function () {
			return createRuler.toString();
		},
		isFenceMarkerSource: function () {
			return isFenceMarker.toString();
		},
		CODE_BLOCK_STYLE: CODE_BLOCK_STYLE,
		MAX_PASSES: MAX_PASSES
	};
});
