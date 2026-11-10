var test = require("node:test");
var assert = require("node:assert");
var Render = require("../plugin/scripts/md-render.js");

var renderMd = Render.renderMd;

test("empty input renders empty output", function () {
	assert.strictEqual(renderMd(""), "");
	assert.strictEqual(renderMd(null), "");
	assert.strictEqual(renderMd("   \n  "), "");
});

test("headings render as h1..h6", function () {
	assert.ok(renderMd("# Title").indexOf("<h1>Title</h1>") >= 0);
	assert.ok(renderMd("###### Deep").indexOf("<h6>Deep</h6>") >= 0);
});

test("tables render as real <table>", function () {
	var html = renderMd("| a | b |\n|---|---|\n| 1 | 2 |");
	assert.ok(html.indexOf("<table>") >= 0, "no <table>: " + html);
	assert.ok(html.indexOf("<td>1</td>") >= 0, "no cell: " + html);
});

test("lists render as <ul>/<li>", function () {
	var html = renderMd("- item1\n- item2");
	assert.ok(html.indexOf("<ul>") >= 0, "no <ul>: " + html);
	assert.ok(html.indexOf("<li>item1</li>") >= 0, "no <li>: " + html);
});

test("ordered lists render as <ol>", function () {
	var html = renderMd("1. first\n2. second");
	assert.ok(html.indexOf("<ol>") >= 0, "no <ol>: " + html);
});

test("links render as <a href>", function () {
	var html = renderMd("[72574](https://op.trueconf.com/work_packages/72574)");
	assert.ok(html.indexOf('<a href="https://op.trueconf.com/work_packages/72574">72574</a>') >= 0);
});

test("inline code renders as <code>", function () {
	var html = renderMd("run `startTenantMode` now");
	assert.ok(html.indexOf("<code>startTenantMode</code>") >= 0);
});

test("bold, italic and strikeout render", function () {
	assert.ok(renderMd("**b**").indexOf("<strong>b</strong>") >= 0);
	assert.ok(renderMd("*i*").indexOf("<em>i</em>") >= 0);
	assert.ok(renderMd("~~s~~").indexOf("<s>s</s>") >= 0);
});

test("fenced code blocks render as <pre><code>", function () {
	var html = renderMd("```\nvar x = 1;\n```");
	assert.ok(html.indexOf("<pre><code>") >= 0, "no <pre><code>: " + html);
	assert.ok(html.indexOf("var x = 1;") >= 0);
});

test("blockquotes render as <blockquote>", function () {
	assert.ok(renderMd("> quoted").indexOf("<blockquote>") >= 0);
});

test("raw HTML is escaped (html: false)", function () {
	var html = renderMd("hello <script>alert(1)</script> world");
	assert.ok(html.indexOf("<script>") < 0, "raw <script> leaked: " + html);
	assert.ok(html.indexOf("&lt;script&gt;") >= 0, "not escaped: " + html);
});

test("linkify turns bare URLs into links", function () {
	var html = renderMd("see https://example.com/docs now");
	assert.ok(html.indexOf('<a href="https://example.com/docs"') >= 0, "no link: " + html);
});

test("task file shape: table with links and inline code", function () {
	var html = renderMd(
		"| Задача | Описание |\n" +
		"|---|---|\n" +
		"| [72574](https://op.trueconf.com/work_packages/72574) | команда `startTenantMode` |"
	);
	assert.ok(html.indexOf("<table>") >= 0);
	assert.ok(html.indexOf("work_packages/72574") >= 0);
	assert.ok(html.indexOf("<code>startTenantMode</code>") >= 0);
});
