# Change Log

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
