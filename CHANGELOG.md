# Change Log

## 0.2.0

* New: **Paste from Markdown**. Right-click in the document → «Paste from
  Markdown» (also available as a button in the plugin window): paste or open a
  `.md` file, press Insert — the whole content materialises at the caret in
  ONE operation: headings, real tables, real lists, hyperlinks, inline code,
  code blocks and blockquotes. One undo point. A 270 KB changelog (a 640-row
  table with 636 links) inserts in seconds instead of minutes of line-by-line
  conversion.
* Powered by a vendored markdown-it (MIT, works offline) — full CommonMark
  plus tables. Raw HTML in the source Markdown is disabled (html: false) —
  pasted content cannot inject markup into the document.
* Pasted content without explicit styles inherits the document's default
  formatting (verified on DS 10.0.2).
* The context menu item and the dialog are localized (en/ru).

## 0.1.1

* Fixed: `[text](url)` now actually creates a hyperlink. The SDK's
  `AddHyperlink` silently no-ops inside the plugin sandbox on all web builds
  (it returns null — verified on ONLYOFFICE Docs 10.0.2); the plugin now
  selects the converted span in the editor and pastes an `<a>` HTML fragment
  over it from the plugin side (`PasteHtml`), which reliably produces the
  hyperlink.
* Fixed: text typed right after a conversion no longer continues the
  converted span's format. The caret is now parked at the start of the next
  real character after the span, so typing continues with the SURROUNDING
  text's format — Google-Docs behaviour («**test** » → typing after «test»
  stays plain).
* Fixed: paragraph-mark variants across builds (`"\r"` vs `"\r\n"`) are
  normalized before the trigger check, so a conversion can no longer fire
  the instant the closing marker is typed without the space/Enter trigger.

## 0.1.0

* Initial public release.
* As-you-type Markdown conversion in docx documents, Google-Docs-style:
  - `#`…`######` → Heading 1–6 (standard styles, ToC and navigation work);
  - `**bold**`, `__bold__`, `*italic*`, `_italic_`, `***bold italic***`, `~~strikeout~~`;
  - `` `code` `` → inline code (Consolas, green text, gray shading);
  - ` ``` ` fenced code blocks → «Code Block» style (open with ` ``` ` + Enter, close with ` ``` ` + Enter);
  - `[text](url)` → hyperlink (in some web builds the sandbox may silently ignore `AddHyperlink`).
* Conversion triggers: space after the closing marker, or Enter / Shift+Enter.
* «Convert whole document» one-shot conversion (handy after pasting Markdown text).
* False-positive guards: `_` inside words, `5 * 3 * 2`, leading/trailing spaces, code-block content.
* Co-editing safe: only the paragraph under the local cursor is touched.
* Undo-friendly: Ctrl+Z reverts a conversion as a single history point.
* Toggle with the checkbox in the plugin window; per-user, persisted in the browser.
* Lists are intentionally left to the editor's built-in AutoFormat.
