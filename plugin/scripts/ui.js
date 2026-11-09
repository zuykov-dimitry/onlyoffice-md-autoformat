/*
 * UI wiring for the plugin window. The engine lives in the same iframe:
 * keep the window open (it can be minimised) and conversions keep running.
 */
(function () {
	"use strict";

	var enabledEl = document.getElementById("enabled");
	var statusEl = document.getElementById("status");
	var convertBtn = document.getElementById("convert-doc");
	var aboutBtn = document.getElementById("about-btn");
	var mainView = document.getElementById("main-view");
	var aboutView = document.getElementById("about-view");

	function describe(kind) {
		var map = {
			bold: "bold applied",
			italic: "italic applied",
			strike: "strikeout applied",
			code: "inline code applied",
			link: "hyperlink applied",
			"heading 1": "heading 1 applied",
			"heading 2": "heading 2 applied",
			"heading 3": "heading 3 applied",
			"heading 4": "heading 4 applied",
			"heading 5": "heading 5 applied",
			"heading 6": "heading 6 applied"
		};
		return map[kind] || (kind ? kind : "");
	}

	function render(st) {
		enabledEl.checked = st.enabled;
		document.getElementById("enabled-label").textContent =
			st.enabled ? "Autoformat is on" : "Autoformat is off";
		var parts = [];
		if (!st.enabled) {
			parts.push("OFF");
		}
		var msg = describe(st.message);
		if (msg) {
			parts.push(msg);
		}
		statusEl.textContent = parts.join(" \u00B7 ");
		statusEl.className = st.enabled ? "" : "off";
	}

	function wire() {
		window.Asc.plugin.init = function () {
			window.MdAutoformatEngine.init(onStatus);
			render({
				enabled: window.MdAutoformatEngine.isEnabled(),
				message: ""
			});
			// visible version marker: the editor may keep a stale dev-plugin
			// config in localStorage, so "which build is running" must be
			// answerable at a glance
			var versionEl = document.getElementById("plugin-version");
			if (versionEl) {
				versionEl.textContent = "v" + (window.Asc.plugin.info.version || "0.1.0");
			}
		};

		// The engine must not probe ranges before the document is ready:
		// early GetRange calls on a half-initialised document can corrupt
		// the editor's position machinery for the whole session.
		window.Asc.plugin.onDocumentReady = function () {
			window.MdAutoformatEngine.onDocumentReady();
		};

		enabledEl.addEventListener("change", function () {
			window.MdAutoformatEngine.setEnabled(enabledEl.checked);
		});

		// v0.1.0: the About information renders inside this window (a
		// separate PluginWindow would duplicate a close button that the DS
		// window chrome cannot deliver for).
		aboutBtn.addEventListener("click", function () {
			var isRu = /[?&]lang=ru/.test(window.location.search || "");
			var v = (window.Asc.plugin.info && window.Asc.plugin.info.version) || "0.1.0";
			document.getElementById("about-title").textContent = isRu
				? "Markdown-автоформат"
				: "Markdown autoformat";
			document.getElementById("about-version").textContent = isRu
				? "Версия " + v
				: "Version " + v;
			document.getElementById("about-desc").textContent = isRu
				? "Печатайте markdown в docx и получайте форматирование на лету, как в Google Docs: заголовки #, **жирный**, *курсив*, ~~зачёркнутый~~, `код`, ``` блоки кода, ссылки [текст](url)."
				: "Type markdown in docx and get formatting as you type, Google-Docs-style: # headings, **bold**, *italic*, ~~strike~~, `code`, ``` code blocks, [text](url) links.";
			document.getElementById("about-author").textContent = isRu
				? "Автор: Димитрий Зуйков"
				: "Author: Dimitrii Zuikov";
			document.getElementById("about-company").textContent = isRu
				? "Труконф"
				: "TrueConf";
			document.getElementById("about-back").textContent = isRu
				? "← Назад"
				: "← Back";
			mainView.style.display = "none";
			aboutView.style.display = "";
		});

		document.getElementById("about-back").addEventListener("click", function () {
			aboutView.style.display = "none";
			mainView.style.display = "";
		});

		convertBtn.addEventListener("click", function () {
			statusEl.textContent = "converting\u2026";
			window.MdAutoformatEngine.convertDocument(function (res) {
				if (res && res.ok) {
					statusEl.textContent = "converted: " + res.count + " item(s)";
				} else {
					statusEl.textContent = "conversion failed";
				}
			});
		});
	}

	function onStatus(st) {
		render(st);
	}

	// The editor SDK (plugins.js) must be loaded before Asc.plugin exists:
	// wait for it instead of crashing, and explain when it never arrives.
	var tries = 0;
	(function whenReady() {
		if (window.Asc && window.Asc.plugin) {
			wire();
			return;
		}
		if (++tries > 120) { // ~12 s
			statusEl.textContent = "editor SDK not loaded: check network for plugins.js";
			statusEl.className = "off";
			return;
		}
		setTimeout(whenReady, 100);
	})();
})();
