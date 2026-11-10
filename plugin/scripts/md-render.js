/*
 * Markdown → HTML renderer for the "Paste from Markdown" pipeline (v0.2.0).
 *
 * The as-you-type engine converts text in EXISTING paragraphs; this module is
 * the second path: it renders a whole Markdown document to HTML so the editor
 * can materialise it with a single PasteHtml call — tables, lists, links and
 * code blocks included, in one operation and one undo point.
 *
 * markdown-it is vendored (plugin/vendor/markdown-it.min.js, MIT) so the
 * plugin works offline. Raw HTML in the source Markdown is disabled
 * (html: false) — pasted content must never inject markup into the document.
 *
 * Loadable both as a CommonJS module (node --test) and as a plain script that
 * exposes `window.MdAutoformatRender` inside the plugin iframe.
 */
(function (root, factory) {
	if (typeof module === "object" && module.exports) {
		module.exports = factory(require("../vendor/markdown-it.min.js"));
	} else {
		root.MdAutoformatRender = factory(root.markdownit);
	}
})(typeof self !== "undefined" ? self : this, function (markdownit) {
	"use strict";

	var md = markdownit({
		html: false,     // raw HTML in the source must not reach the document
		linkify: true,   // bare "https://…" becomes a link
		breaks: false    // CommonMark: single newlines are soft breaks
	});

	/**
	 * Render Markdown source to an HTML fragment suitable for PasteHtml.
	 * Returns "" for empty input. The fragment carries no inline styles:
	 * PasteHtml content without styles inherits the document's default
	 * formatting (verified on DS 10.0.2).
	 */
	function renderMd(text) {
		var src = String(text || "");
		if (!src.trim()) {
			return "";
		}
		return md.render(src);
	}

	return { renderMd: renderMd };
});
