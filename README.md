# onlyoffice-md-autoformat

English | [Русский](README.ru.md)

An ONLYOFFICE Docs plugin: type Markdown in a docx document and get the
formatting on the fly, Google-Docs-style. Works on top of Nextcloud + ONLYOFFICE
integrations, self-hosted Document Servers, and ONLYOFFICE Desktop Editors.

## What gets converted (as you type)

| Input                | Result                                                                 |
|----------------------|------------------------------------------------------------------------|
| `# ` … `###### `     | Heading 1 … Heading 6 (standard styles — ToC and navigation work)      |
| `**text**` + space   | bold (the space after the closing marker is the conversion trigger)    |
| `__text__`           | bold                                                                   |
| `*text*`             | italic                                                                 |
| `_text_`             | italic                                                                 |
| `***text***`         | bold italic                                                            |
| `~~text~~`           | strikeout                                                              |
| `` `code` ``         | Consolas + green text + gray shading                                   |
| ` ``` ` + Enter      | opens a code block; type the code (no markdown conversion inside); closing ` ``` ` + Enter turns the whole block into the «Code Block» style (Consolas, shading) |
| `[text](https://…)`  | hyperlink                                                              |

The conversion trigger is a space after the closing marker, or Enter /
Shift+Enter (otherwise a trailing marker would stay forever). Until a trigger
arrives the markers stay untouched: `**bold**` at the end of a line with no
trailing space is left as is.

Lists (`- `, `1. `) are deliberately not duplicated: the editor's built-in
AutoFormat already creates bulleted lists from `- `/`* ` and numbered lists
from `1. `/`1) `. The plugin does not touch lists and works inside list items.

## Installation

### Way 1 — developer mode (quick, no DS server privileges)

1. Start the dev server from the repository:

   ```bash
   python3 tools/devserver.py 8484
   # Plugin config: http://localhost:8484/config.json
   ```

2. Open a document in ONLYOFFICE → DevTools (F12) → **Console** tab.
3. In the console context dropdown (top, where it says «top») pick **frameEditor**.
4. Run:

   ```js
   Asc.editor.installDeveloperPlugin("http://localhost:8484/config.json");
   ```

5. The plugin appears in the **Plugins** tab. After a page reload repeat step 4
   (dev plugins live within the editor session).

> If the browser blocks mixed content (https editor → http://localhost):
> allow «Insecure content» for the DS site in the site settings (padlock icon),
> or use way 2.

### Way 2 — on the Document Server (permanent, for everyone)

Copy the `plugin/` folder to the DS server into `sdkjs-plugins` (folder name = GUID):

```bash
sudo cp -r plugin "/var/www/onlyoffice/documentserver/sdkjs-plugins/asc.{114F28ED-672A-4640-A6B2-8ED0E9D242CB}"
sudo supervisorctl restart all   # or: docker restart <DS-container>
```

(Docker: `docker cp plugin <container>:/var/www/onlyoffice/documentserver/sdkjs-plugins/asc.{…}`
and restart the container.) Refresh the editor page.

### Way 3 — zip / .plugin (wherever the Plugin Manager allows uploads)

- Web: `dist/md-autoformat.zip` → **Plugins → Manage plugins → Upload a plugin**
  (available not in every web build).
- Desktop Editors: rename `dist/md-autoformat.zip` to `md-autoformat.plugin` →
  **Plugins → Manage plugins → Add plugin**.

`bash build.sh` produces both artifacts in `dist/`.

## Controls

- The checkbox in the plugin window — enable/disable (persisted in the browser).
- **Convert whole document** — one-shot conversion of the entire document
  (handy after pasting text that carries markdown markup).
- **Ctrl+Z** — reverts a conversion entirely (one history entry per conversion).

## False-positive guards

- conversion starts with a space after the closing marker (or Enter/Shift+Enter
  at the end of a line): `**bold**` without a trigger stays markdown,
  `**bold** ` converts;
- `_` inside a word does not fire: `snake_case_name` stays as is;
- `5 * 3 * 2` — not italic (a marker after a digit);
- content cannot start or end with a space: `* space *` — no conversion;
- inside a Code Block markdown is not converted, except the closing ` ``` `;
- a link converts only for `http(s)://`, `www.`, `mailto:`, `ftp://`.

## Co-editing

The plugin touches only the paragraph under the local user's cursor, makes the
conversion idempotent (markers disappear) and rate-limits itself. Every
participant toggles their own plugin independently.

## Limitations (0.1.0)

- the engine lives in the plugin window: after reopening the document the
  plugin must be opened again (background autostart is on the roadmap);
- «Convert whole document» skips a paragraph that changed externally during
  the run (safe; a second pass finishes it);
- a span crossing a soft line break inside converts, but the formatting may
  spread over the whole paragraph (editor behavior for ranges containing a
  break);
- markdown tables are not supported;
- an unclosed code block (a single ` ``` ` without a pair) stays as text;
  lines like ` ``` text` (marker + text on the same line) are not touched;
- `[text](url)` links convert the text (brackets removed), but the hyperlink
  itself is NOT created in TrueConf's web build of OnlyOffice: the sandboxed
  `AddHyperlink` requires a visual-selection flag the plugin cannot set — the
  SDK silently ignores the call (the engine checks the model and logs
  «SDK ignored AddHyperlink»). Desktop builds may behave differently.

## Development

```bash
python3 tools/make-icons.py   # icons
node --test tests/rules.test.js
bash build.sh                 # dist/md-autoformat.zip + dist/md-autoformat.plugin
```

Structure: `plugin/scripts/rules.js` — a pure scanner (UMD, tested in node),
`plugin/scripts/engine.js` — polling of the paragraph under the cursor and
mutations via `callCommand`, `plugin/scripts/ui.js` — the settings window.

The detailed (Russian) version history lives in [CHANGELOG.md](CHANGELOG.md)
and in [README.ru.md](README.ru.md).

## License

[MIT](LICENSE)
