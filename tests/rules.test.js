const test = require("node:test");
const assert = require("node:assert");
const Rules = require("../plugin/scripts/rules.js");

function kindOf(text) {
    const m = Rules.scanOne(text);
    return m ? m.kind : null;
}

function span(text) {
    return Rules.scanOne(text);
}

// --- bold -------------------------------------------------------------

test("bold ** converts", () => {
    const m = Rules.scanOne("**bold** world");
    assert.equal(m.kind, "bold");
    assert.equal(m.start, 0);
    assert.equal(m.end, 8); // "**bold**" is 8 chars
    assert.equal(m.innerStart, 2);
    assert.equal(m.innerEnd, 6);
});

test("bold __ converts", () => {
    assert.equal(kindOf("__bold__ x"), "bold");
});

test("bold+italic *** converts", () => {
    const m = Rules.scanOne("***жирный курсив*** word");
    assert.equal(m.kind, "bolditalic");
    assert.equal(m.start, 0);
    assert.equal(m.end, 19); // "***жирный курсив***"
    assert.equal(m.innerStart, 3);
    assert.equal(m.innerEnd, 16);
});

test("*** takes priority over ** and *", () => {
    assert.equal(kindOf("***x*** "), "bolditalic");
    assert.equal(kindOf("**x** "), "bold");
    assert.equal(kindOf("*x* "), "italic");
});

test("unbalanced *** does not convert as bold/italic leftovers", () => {
    assert.equal(Rules.scanOne("***x** "), null);
});

test("bold markers after other text keep positions", () => {
    const m = span("say **wow** ");
    assert.equal(m.kind, "bold");
    assert.equal(m.innerStart, 6);
    assert.equal(m.innerEnd, 9);
});

// --- italic -----------------------------------------------------------

test("italic * converts", () => {
    assert.equal(kindOf("hello *world* "), "italic");
});

test("italic _ converts", () => {
    assert.equal(kindOf("hello _world_ "), "italic");
});

// --- guards -----------------------------------------------------------

test("snake_case is not italic", () => {
    assert.equal(kindOf("my_snake_case_name"), null);
});

test("multiplication 5 * 3 is not italic", () => {
    assert.equal(kindOf("5 * 3 * 2"), null);
});

test("content with edge spaces does not convert", () => {
    assert.equal(kindOf("* spaces *"), null);
});

test("unterminated marker does not convert", () => {
    assert.equal(kindOf("2 * 3 plus"), null);
});

test("closing delimiter before a letter does not convert (approved guard)", () => {
    assert.equal(kindOf("**bold**and more"), null);
});

// --- strike / code ----------------------------------------------------

test("strike ~~ converts", () => {
    assert.equal(kindOf("~~gone~~ "), "strike");
});

test("inline code converts", () => {
    const m = span("use `md_autoformat_here` now");
    assert.equal(m.kind, "code");
    assert.equal(m.innerStart, 5);
    assert.equal(m.innerEnd, 23);
});

test("triple backticks do not match inline code", () => {
    assert.equal(kindOf("```"), null);
});

// --- links ------------------------------------------------------------

test("link converts with url", () => {
    const m = span("see [docs](https://example.com/x) now");
    assert.equal(m.kind, "link");
    assert.equal(m.url, "https://example.com/x");
});

test("link span boundaries exclude the closing bracket", () => {
    const m = span("see [docs](https://example.com/x) now");
    assert.equal(m.innerStart, 5); // "docs"
    assert.equal(m.innerEnd, 9);   // after "docs", before "]"
    assert.equal(m.end, 33);       // after the closing ")"
});

test("link without scheme is skipped", () => {
    assert.equal(kindOf("see [1](note) now"), null);
});

// v0.1.3: bare domains convert (Google-Docs behaviour), single words stay
test("link with bare domain converts", () => {
    const m = span("Test [text](example.com) more");
    assert.equal(m.kind, "link");
    assert.equal(m.url, "example.com");
});

test("link with www and path converts", () => {
    const m = span("see [docs](www.example.com/x) now");
    assert.equal(m.kind, "link");
    assert.equal(m.url, "www.example.com/x");
});

// --- headings ---------------------------------------------------------

test("heading levels 1..6", () => {
    assert.equal(Rules.detectHeading("# Title").level, 1);
    assert.equal(Rules.detectHeading("## Title").level, 2);
    assert.equal(Rules.detectHeading("###### Deep").level, 6);
    assert.equal(Rules.detectHeading("####### nope"), null);
    assert.equal(Rules.detectHeading("#5 issue"), null);
    assert.equal(Rules.detectHeading("No marker"), null);
});

test("heading markerLen covers marker+space", () => {
    assert.equal(Rules.detectHeading("## Two").markerLen, 3);
});

// --- fences -----------------------------------------------------------

test("fence marker line detected", () => {
    assert.deepEqual(Rules.detectFence("```"), { marker: true });
    assert.deepEqual(Rules.detectFence("```js"), { marker: true });
});

test("fence marker with inline text is NOT a marker", () => {
    assert.equal(Rules.detectFence("``` text"), null);
});

test("no fence elsewhere", () => {
    assert.equal(Rules.detectFence("hello ```, world"), null);
});

// --- leftmost wins ----------------------------------------------------

test("leftmost span wins", () => {
    const m = span("**a** then *b*");
    assert.equal(m.start, 0);
    assert.equal(m.kind, "bold");
});

test("no space after closer - no conversion (trigger is the space)", () => {
    assert.equal(kindOf("**bold**"), null);
    assert.equal(kindOf("**bold** and"), "bold"); // space typed -> converts
    assert.equal(kindOf("~~gone~~"), null);
    assert.equal(kindOf("hello *world*"), null);
});

// --- v0.1.3: inner single "*" must not break bold (GDocs parity) -------

test("bold with a single inner * converts", () => {
    const m = span("Test text some text **text some * text** x");
    assert.equal(m.kind, "bold");
    assert.equal(m.start, 20); // "Test text some text " is 20 chars
    assert.equal(m.innerStart, 22);
    assert.equal(m.innerEnd, 38); // "text some * text"
});

test("bolditalic with a single inner * converts", () => {
    const m = span("***a * b*** x");
    assert.equal(m.kind, "bolditalic");
    assert.equal(m.innerStart, 3);
    assert.equal(m.innerEnd, 8); // "a * b"
});

test("double inner ** still does not convert as bold", () => {
    assert.equal(kindOf("**a ** b** "), null);
});

// --- Enter / Shift+Enter as a trigger ---------------------------------

test("Enter right after the closing marker converts", () => {
    assert.equal(kindOf("**bold**\r\n"), "bold");
    assert.equal(kindOf("*i*\r\n"), "italic");
    assert.equal(kindOf("~~gone~~\r\n"), "strike");
    assert.equal(kindOf("`code`\r\n"), "code");
});

test("Shift+Enter after the closing marker converts", () => {
    assert.equal(kindOf("**bold**\r\r\n"), "bold");
});

test("marker followed by a line break and more text does not convert", () => {
    assert.equal(kindOf("**bold**\ntext"), null);
});

// --- resolveOffsets (text offset -> model position) -------------------

test("resolveOffsets maps plain text 1:1", () => {
    const text = "ab cd";
    // lens[k] = prefix length, chars[k] = char at model position k
    const lens = [0, 1, 2, 3, 4, 5];
    const chars = ["a", "b", " ", "c", "d", null];
    assert.deepEqual(Rules.resolveOffsets(text, lens, chars, [0, 1, 2, 3, 4, 5]), [0, 1, 2, 3, 4, 5]);
});

test("resolveOffsets skips break-interior positions via char check", () => {
    // soft break between "b" and "c": model positions 2 and 3 share
    // prefix length 2; position 3 renders "\r" but text.charAt(2) is "c"
    const text = "ab\rc";
    const lens = [0, 1, 2, 2, 3, 4];
    const chars = ["a", "b", "\r", "\r", "c", null];
    assert.deepEqual(Rules.resolveOffsets(text, lens, chars, [3]), [4]);
});

test("resolveOffsets handles break rendered at break start", () => {
    const text = "ab\rc";
    const lens = [0, 1, 2, 3, 3, 4];
    const chars = ["a", "b", "\r", "c", null, null];
    assert.deepEqual(Rules.resolveOffsets(text, lens, chars, [2, 3]), [2, 3]);
});

test("resolveOffsets returns null for unresolvable offset", () => {
    const text = "ab";
    const lens = [0, 1, 2];
    const chars = ["a", "b", null];
    assert.equal(Rules.resolveOffsets(text, lens, chars, [5]), null);
});

test("resolveOffsets accepts end-of-text offset without char check", () => {
    const text = "ab";
    const lens = [0, 1, 2, 2];
    const chars = ["a", "b", null, null];
    assert.deepEqual(Rules.resolveOffsets(text, lens, chars, [2]), [2]);
});

test("resolveOffsets handles boundary before the paragraph mark", () => {
    // "**bold**\r\n": the mark renders at ONE position (14) preceded by
    // padding (8..13); the closer boundary at offset 8 must resolve to 8
    const text = "**bold**\r\n";
    const lens = [0, 1, 2, 3, 4, 5, 6, 7, 8, 8, 8, 8, 8, 8, 10, 10, 10];
    const chars = ["*", "*", "b", "o", "l", "d", "*", "*", "", "", "", "", "", "", "\r\n", "", null];
    assert.deepEqual(Rules.resolveOffsets(text, lens, chars, [0, 2, 6, 8]), [0, 2, 6, 8]);
});

test("resolveOffsets still resolves spans after a soft break", () => {
    // "**a\rb** ": break padding between "a" and "b" renders empty
    const text = "**a\rb** ";
    const lens = [0, 1, 2, 2, 2, 2, 2, 2, 3, 4, 5, 6, 7];
    const chars = ["*", "*", "a", "", "", "", "", "", "\r", "b", "*", "*", " "];
    assert.deepEqual(Rules.resolveOffsets(text, lens, chars, [0, 2, 5, 7]), [0, 2, 10, 12]);
});

// --- createRuler (lazy binary-search resolver) --------------------------

function rulerOver(text, lens, chars) {
    // The real editor saturates oversized prefix ranges (GetRange(0, k) for
    // k past the last position returns the whole-paragraph text), so the
    // test provider mirrors that instead of returning null.
    return Rules.createRuler(text, {
        prefix: (k) => {
            if (k < 0) return null;
            if (k >= lens.length) return lens[lens.length - 1];
            return lens[k];
        },
        charAt: (k) => (k < 0 || k >= chars.length) ? null : chars[k]
    });
}

test("createRuler matches resolveOffsets on plain text", () => {
    const text = "ab cd";
    const lens = [0, 1, 2, 3, 4, 5];
    const chars = ["a", "b", " ", "c", "d", null];
    const ruler = rulerOver(text, lens, chars);
    assert.deepEqual([0, 1, 2, 3, 4, 5].map(o => ruler.resolve(o)), [0, 1, 2, 3, 4, 5]);
});

test("createRuler skips break-interior positions via char check", () => {
    const text = "ab\rc";
    const lens = [0, 1, 2, 2, 3, 4];
    const chars = ["a", "b", "\r", "\r", "c", null];
    const ruler = rulerOver(text, lens, chars);
    assert.equal(ruler.resolve(3), 4);
});

test("createRuler accepts end-of-text offset without char check", () => {
    const text = "ab";
    const lens = [0, 1, 2, 2];
    const chars = ["a", "b", null, null];
    const ruler = rulerOver(text, lens, chars);
    assert.equal(ruler.resolve(2), 2);
});

test("createRuler resolves tail offsets of a break-heavy paragraph", () => {
    // The v0.1.1 bug: a fixed text.length + 6 bound cut the ruler short on
    // break-heavy paragraphs (model positions trail text offsets by ~3 per
    // break), so spans near the paragraph tail were unresolvable. The
    // adaptive bound must cover the whole paragraph.
    const text = "x\n".repeat(27) + "*kursiv* \r\n"; // 65 chars, 29 breaks
    // synthetic editor model (as measured live on DS 9.4): each break costs
    // 3 model positions (2 flat padding + 1 break char that renders one
    // char), every other char 1:1; lens[k] = rendered length of [0,k)
    const lens = [], chars = [];
    let rendered = 0;
    for (const ch of text) {
        if (ch === "\n") {
            lens.push(rendered); chars.push("");  // pad (flat)
            lens.push(rendered); chars.push("");  // pad (flat)
            lens.push(rendered); chars.push("\n"); rendered++; // break renders 1
        } else {
            lens.push(rendered); chars.push(ch); rendered++;
        }
    }
    lens.push(rendered); chars.push(null); // sentinel after the last position
    const ruler = rulerOver(text, lens, chars);
    // every text offset must resolve, and to the position whose prefix
    // length equals the offset
    for (let o = 0; o <= text.length; o++) {
        const p = ruler.resolve(o);
        assert.notEqual(p, -1, "offset " + o + " unresolved");
        assert.equal(lens[p], o, "prefix length mismatch at offset " + o);
    }
});

test("createRuler resolves the tail span of a 450-char paragraph (live repro)", () => {
    // exactly the live repro: 450 chars with 27 soft breaks plus the "\r\n"
    // mark, "*kursiv* " at the tail; with the v0.1.1 fixed text.length + 6
    // bound the span boundaries were unresolvable (model positions trail
    // text offsets by ~3 per break, so the trailing padding needs ~90 extra
    // model positions) -- the adaptive bound must cover them
    const text = "x\n".repeat(27) + "x".repeat(384) + " *kursiv* \r\n";
    assert.equal(text.length, 450);
    assert.equal((text.match(/[\r\n]/g) || []).length, 29); // 27 breaks + mark
    // synthetic editor model (as measured live on DS 9.4): each break costs
    // 3 model positions (2 flat padding + 1 break char), all other chars 1:1;
    // the mark renders "\r\n" at one position preceded by flat padding
    const lens = [], chars = [];
    let rendered = 0;
    for (const ch of text) {
        if (ch === "\n") {
            lens.push(rendered); chars.push("");  // pad (flat)
            lens.push(rendered); chars.push("");  // pad (flat)
            lens.push(rendered); chars.push("\n"); rendered++; // break renders 1
        } else {
            lens.push(rendered); chars.push(ch); rendered++;
        }
    }
    for (let i = 0; i < 4; i++) { lens.push(rendered); chars.push(""); } // mark padding (flat)
    lens.push(rendered); chars.push("\r\n"); rendered += 2; // the mark (+2)
    lens.push(rendered); chars.push(null);                  // sentinel
    const ruler = rulerOver(text, lens, chars);
    const m = Rules.scanOne(text);
    assert.ok(m, "span must be found");
    for (const o of [m.start, m.innerStart, m.innerEnd, m.end]) {
        const p = ruler.resolve(o);
        assert.notEqual(p, -1, "offset " + o + " unresolved");
        assert.equal(lens[p], o, "prefix length mismatch at offset " + o);
        assert.equal(chars[p], text[o], "char mismatch at offset " + o);
    }
});

// --- v0.1.3 engine contract: paragraph-mark stripping -------------------
// Live editor GetText() always ends with "\r\n" (the paragraph mark), even
// while the user is still typing. The engine strips the mark BEFORE calling
// the rules, so the rules here are the contract the engine must feed:
//   - a marker at the end of the line with no trailing space must NOT
//     convert while typing ("**test**" -> plain);
//   - the Enter-follows-marker branch re-appends the virtual mark and MUST
//     convert ("**test**\r\n" -> bold).

test("v0.1.3: stripped paragraph text (no mark, no space) does not convert", () => {
    assert.equal(kindOf("**test**"), null);
    assert.equal(kindOf("*test*"), null);
    assert.equal(kindOf("~~test~~"), null);
});

test("v0.1.3: stripped text with a trailing space converts (typing trigger)", () => {
    assert.equal(kindOf("**test** "), "bold");
    assert.equal(kindOf("*test* "), "italic");
});

test("v0.1.3: Enter branch re-appends the virtual mark and converts", () => {
    assert.equal(kindOf("**test**\r\n"), "bold");
    assert.equal(kindOf("abc **test**\r\n"), "bold");
    // headings are detected by detectHeading (not scanOne); with the virtual
    // mark the heading at the end of the previous paragraph still matches
    const h = Rules.detectHeading("# Heading\r\n");
    assert.ok(h && h.level === 1 && h.markerLen === 2, "heading with mark must be detected");
});

test("v0.1.3: unfinished marker plus the mark still does not convert", () => {
    assert.equal(kindOf("**te\r\n"), null);
    assert.equal(kindOf("*te\r\n"), null);
});
