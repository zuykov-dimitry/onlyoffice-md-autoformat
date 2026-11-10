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
	var insertView = document.getElementById("insert-md-view");
	var mdInput = document.getElementById("md-input");
	var mdFile = document.getElementById("md-file");
	var mdFileLabel = document.getElementById("md-file-label");
	var insertBtn = document.getElementById("insert-btn");
	var insertStatus = document.getElementById("insert-status");
	var insertBack = document.getElementById("insert-back");

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
				versionEl.textContent = "v" + (window.Asc.plugin.info.version || "0.2.1");
			}
			// localize the v0.2.0 Insert Markdown view
			insertBtn.textContent = L.insert;
			mdFileLabel.textContent = L.openFile;
			insertBack.textContent = L.back;
			mdInput.placeholder = L.placeholder;
			// v0.2.1: "Paste from Markdown" in the editor context menu.
			//
			// The protocol (verified live on the desktop build 10.0.2 and against
			// upstream sdkjs sources): the editor pushes onContextMenuShow ONLY
			// to plugins registered in its eventsMap, which is populated by the
			// config `events` array or by attachEditorEvent. Plain attachEvent
			// never notifies the editor. AddContextMenuItem must be called
			// INSIDE the onContextMenuShow handler — at any other time the
			// editor's context-menu barrier does not exist and the call is a
			// silent no-op. The item itself must be a LEAF: `items: []` renders
			// a submenu arrow and the click opens an empty submenu instead of
			// firing (verified live).
			try {
				if (typeof window.Asc.plugin.attachEditorEvent === "function") {
					var menuItemPayload = function () {
						return [{
							guid: window.Asc.plugin.guid,
							items: [{ id: "onPasteMarkdownClick", text: L.menuItem }]
						}];
					};
					window.Asc.plugin.attachEditorEvent("onContextMenuShow", function () {
						try {
							window.Asc.plugin.executeMethod("AddContextMenuItem", menuItemPayload());
						} catch (e) { /* the context menu is optional */ }
					});
					// The click event is gated by the same eventsMap: without
					// registering onContextMenuClick the editor routes the click
					// but never delivers it (verified live). attachEditorEvent
					// replaces the SDK's built-in event_onContextMenuClick, so
					// keep the original dispatch alive — it is what runs the
					// attachContextMenuClickEvent handlers.
					var builtinClick = window.Asc.plugin.event_onContextMenuClick;
					window.Asc.plugin.attachEditorEvent("onContextMenuClick", function (data) {
						if (builtinClick) {
							builtinClick.call(window.Asc.plugin, data);
						}
					});
				}
				if (typeof window.Asc.plugin.attachContextMenuClickEvent === "function") {
					window.Asc.plugin.attachContextMenuClickEvent("onPasteMarkdownClick", function () {
						showInsertView(true);
					});
				}
			} catch (e) { /* the context menu is optional */ }
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
			var v = (window.Asc.plugin.info && window.Asc.plugin.info.version) || "0.2.1";
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
			showView("about");
		});

		document.getElementById("about-back").addEventListener("click", function () {
			showView("main");
		});

		insertBtn.addEventListener("click", doInsert);
		insertBack.addEventListener("click", function () {
			showView("main");
		});
		mdFile.addEventListener("change", function () {
			var f = mdFile.files && mdFile.files[0];
			if (!f) {
				return;
			}
			var reader = new FileReader();
			reader.onload = function () {
				mdInput.value = String(reader.result || "");
				setInsertStatus(f.name + ": " + L.fileLoaded);
			};
			reader.readAsText(f);
			mdFile.value = ""; // allow re-selecting the same file
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

	// v0.2.0: the "Paste from Markdown" view. The editor UI language comes
	// from ?lang= (same pattern as the About view).
	var langRu = /[?&]lang=ru/.test(window.location.search || "");
	var L = langRu ? {
		insert: "Вставить",
		openFile: "Открыть .md…",
		back: "← Назад",
		placeholder: "Вставьте или напечатайте Markdown здесь…",
		empty: "Нечего вставлять: текст пуст",
		inserting: "вставка…",
		inserted: "вставлено",
		insertFailed: "ошибка вставки",
		fileLoaded: "файл загружен",
		menuItem: "Вставить из Markdown"
	} : {
		insert: "Insert",
		openFile: "Open .md…",
		back: "← Back",
		placeholder: "Paste or type Markdown here…",
		empty: "Nothing to insert: the text is empty",
		inserting: "inserting…",
		inserted: "inserted",
		insertFailed: "insert failed",
		fileLoaded: "file loaded",
		menuItem: "Paste from Markdown"
	};

	function showView(name) {
		mainView.style.display = name === "main" ? "" : "none";
		aboutView.style.display = name === "about" ? "" : "none";
		insertView.style.display = name === "insert-md" ? "" : "none";
	}

	function setInsertStatus(msg, isErr) {
		insertStatus.textContent = msg || "";
		insertStatus.className = isErr ? "err" : "";
	}

	// One PasteHtml = one undo point; the whole document materialises at the
	// caret (tables, lists, links included — verified on DS 10.0.2).
	function doInsert() {
		var src = mdInput.value;
		if (!src.trim()) {
			setInsertStatus(L.empty, true);
			return;
		}
		setInsertStatus(L.inserting);
		var html;
		try {
			html = window.MdAutoformatRender.renderMd(src);
		} catch (e) {
			setInsertStatus("render: " + e.message, true);
			return;
		}
		window.Asc.plugin.executeMethod("PasteHtml", [html], function (res) {
			if (res === true || res === undefined || res === null) {
				mdInput.value = "";
				setInsertStatus(L.inserted);
			} else {
				setInsertStatus(L.insertFailed + " (" + res + ")", true);
			}
		});
	}

	function showInsertView(fromMenu) {
		showView("insert-md");
		if (fromMenu && typeof window.Asc.plugin.executeMethod === "function") {
			try {
				window.Asc.plugin.executeMethod("ShowWindow", ["iframe_" + window.Asc.plugin.guid, 0]);
			} catch (e) { /* older builds: the window is already visible */ }
		}
		// Prefill from the clipboard when the editor lets us read it: the
		// textarea stays the source of truth, a denied permission is fine.
		if (!mdInput.value && navigator.clipboard && typeof navigator.clipboard.readText === "function") {
			try {
				navigator.clipboard.readText().then(function (t) {
					if (t && !mdInput.value) {
						mdInput.value = t;
					}
				}).catch(function () { /* denied — the user pastes manually */ });
			} catch (e) { /* denied — the user pastes manually */ }
		}
		mdInput.focus();
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
