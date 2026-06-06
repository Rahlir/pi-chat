import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	chunkTelegramHtml,
	htmlToPlainText,
	markdownToTelegramHtmlBlocks,
	renderTelegramHtmlCaption,
	renderTelegramHtmlChunks,
	TELEGRAM_CAPTION_LIMIT,
	TELEGRAM_MESSAGE_LIMIT,
	visibleLength,
} from "../src/render/telegram-html.ts";

const ENTITY_DECODE: Array<[RegExp, string]> = [
	[/&lt;/g, "<"],
	[/&gt;/g, ">"],
	[/&quot;/g, '"'],
	[/&#39;/g, "'"],
	[/&amp;/g, "&"],
];

// Independent reimplementation of "what the user sees" so tests don't just
// mirror the module's own helpers.
function visibleText(html: string): string {
	let out = html.replace(/<[^>]+>/g, "");
	for (const [pattern, replacement] of ENTITY_DECODE) out = out.replace(pattern, replacement);
	return out;
}

// Returns true if every Telegram inline/block tag is properly opened, closed,
// and nested. This is the invariant Telegram enforces; a chunk that fails it is
// the exact "can't parse entities" bug we are guarding against.
function tagsBalanced(html: string): boolean {
	const stack: string[] = [];
	const tag = /<(\/?)([a-zA-Z0-9]+)[^>]*>/g;
	for (let m = tag.exec(html); m !== null; m = tag.exec(html)) {
		const isClose = m[1] === "/";
		const name = m[2];
		if (isClose) {
			if (stack.pop() !== name) return false;
		} else {
			stack.push(name);
		}
	}
	return stack.length === 0;
}

describe("renderInline escaping", () => {
	test("intraword underscore is literal, not emphasis", () => {
		const [block] = markdownToTelegramHtmlBlocks("send hello_world please");
		assert.equal(block, "send hello_world please");
		assert.ok(!block.includes("<i>"));
	});

	test("nested strong/em and codespan", () => {
		const [block] = markdownToTelegramHtmlBlocks("a **bold _it_** and `code()`");
		assert.equal(block, "a <b>bold <i>it</i></b> and <code>code()</code>");
	});

	test("code spans fully escape & < >", () => {
		const [block] = markdownToTelegramHtmlBlocks("`x < y && z > 0`");
		assert.equal(block, "<code>x &lt; y &amp;&amp; z &gt; 0</code>");
	});

	test("prose preserves existing entities but escapes bare ampersand and angles", () => {
		const [block] = markdownToTelegramHtmlBlocks("a &amp; b & c and 3 < 4 > 1");
		assert.equal(block, "a &amp; b &amp; c and 3 &lt; 4 &gt; 1");
	});

	test("invalid entity-like sequences are escaped so Telegram cannot reject them", () => {
		const [block] = markdownToTelegramHtmlBlocks("see &foo; and &copy; here");
		assert.equal(block, "see &amp;foo; and &amp;copy; here");
		assert.equal(visibleText(block), "see &foo; and &copy; here");
	});

	test("numeric character references decode to real characters", () => {
		const [block] = markdownToTelegramHtmlBlocks("copy &#169; and lt &#60; and hex &#x3C;");
		assert.equal(block, "copy © and lt &lt; and hex &lt;");
	});

	test("links escape href ampersands and keep inline text", () => {
		const [block] = markdownToTelegramHtmlBlocks("[lnk](https://h/a?b=1&c=2)");
		assert.equal(block, '<a href="https://h/a?b=1&amp;c=2">lnk</a>');
	});

	test("images become links to the source", () => {
		const [block] = markdownToTelegramHtmlBlocks("![alt text](https://img/y.png)");
		assert.equal(block, '<a href="https://img/y.png">alt text</a>');
	});

	test("raw inline HTML is shown literally", () => {
		const [block] = markdownToTelegramHtmlBlocks("before <b>x</b> after");
		assert.ok(block.includes("&lt;b&gt;x&lt;/b&gt;"));
		assert.ok(tagsBalanced(block));
	});
});

describe("block rendering and downgrades", () => {
	test("fenced code keeps language and escapes body", () => {
		const [block] = markdownToTelegramHtmlBlocks("```js\nconst x = 1 & 2;\nif (x<3) {}\n```");
		assert.equal(block, '<pre><code class="language-js">const x = 1 &amp; 2;\nif (x&lt;3) {}</code></pre>');
	});

	test("indented (langless) code uses bare pre", () => {
		const [block] = markdownToTelegramHtmlBlocks("```\nplain\n```");
		assert.equal(block, "<pre>plain</pre>");
	});

	test("a quote in the language tag cannot break out of the class attribute", () => {
		const [block] = markdownToTelegramHtmlBlocks('```js"onerror=x\ncode\n```');
		assert.ok(!/class="language-[^"]*"[^>]/.test(block));
		assert.ok(block.includes("&quot;"));
		assert.ok(tagsBalanced(block));
	});

	test("headings downgrade to bold", () => {
		assert.deepEqual(markdownToTelegramHtmlBlocks("## Title _x_"), ["<b>Title <i>x</i></b>"]);
	});

	test("ordered, unordered, nested lists downgrade to text lines", () => {
		const [unordered] = markdownToTelegramHtmlBlocks("- a\n- b\n  - nested");
		assert.equal(unordered, "• a\n• b\n  • nested");
		const [ordered] = markdownToTelegramHtmlBlocks("3. first\n4. second");
		assert.equal(ordered, "3. first\n4. second");
	});

	test("task list items render checkboxes", () => {
		const [block] = markdownToTelegramHtmlBlocks("- [x] done\n- [ ] todo");
		assert.equal(block, "• ☑ done\n• ☐ todo");
	});

	test("blockquote wraps inner content", () => {
		const [block] = markdownToTelegramHtmlBlocks("> quoted **b**");
		assert.equal(block, "<blockquote>quoted <b>b</b></blockquote>");
	});

	test("tables downgrade to a monospace pre block", () => {
		const [block] = markdownToTelegramHtmlBlocks("| a | bb |\n|---|----|\n| 1 | 2 |");
		assert.ok(block.startsWith("<pre>") && block.endsWith("</pre>"));
		assert.ok(visibleText(block).includes("a"));
		assert.ok(visibleText(block).includes("bb"));
		assert.ok(tagsBalanced(block));
	});

	test("horizontal rule downgrades to a visible rule", () => {
		assert.deepEqual(markdownToTelegramHtmlBlocks("---"), ["──────────"]);
	});
});

describe("visibleLength", () => {
	test("counts entities as one and ignores tags", () => {
		assert.equal(visibleLength("<b>ab</b>"), 2);
		assert.equal(visibleLength("a &amp; b"), 5); // "a & b"
		assert.equal(visibleLength('<a href="https://very/long/url">hi</a>'), 2);
	});
});

describe("chunkTelegramHtml", () => {
	test("combines small blocks within the limit", () => {
		const blocks = ["one", "two", "three"];
		assert.deepEqual(chunkTelegramHtml(blocks, 4096), ["one\n\ntwo\n\nthree"]);
	});

	test("never emits a chunk over the limit and keeps every block", () => {
		const blocks = Array.from({ length: 20 }, (_, i) => `paragraph number ${i}`);
		const limit = 40;
		const chunks = chunkTelegramHtml(blocks, limit);
		for (const chunk of chunks) {
			assert.ok(visibleLength(chunk) <= limit, `chunk over limit: ${visibleLength(chunk)}`);
			assert.ok(tagsBalanced(chunk));
		}
		const joined = chunks.join("\n\n");
		for (const block of blocks) assert.ok(joined.includes(block), `lost block: ${block}`);
	});

	test("splits a bold run across the boundary, closing and reopening tags", () => {
		const original = "x".repeat(50);
		const blocks = markdownToTelegramHtmlBlocks(`**${original}**`);
		const chunks = chunkTelegramHtml(blocks, 20);
		assert.ok(chunks.length > 1);
		for (const chunk of chunks) {
			assert.ok(chunk.startsWith("<b>") && chunk.endsWith("</b>"));
			assert.ok(visibleLength(chunk) <= 20);
			assert.ok(tagsBalanced(chunk));
		}
		assert.equal(chunks.map(visibleText).join(""), original);
	});

	test("surrogate pair (emoji) at split boundary stays intact", () => {
		// "aa😀bb": 😀 is U+1F600 (two UTF-16 code units). With limit=3 the split
		// falls right between the surrogate pair if they are treated as separate
		// visible units. They must be kept together in the same chunk.
		const chunks = chunkTelegramHtml(["aa\u{1F600}bb"], 3);
		for (const chunk of chunks) {
			for (let i = 0; i < chunk.length; i++) {
				const code = chunk.charCodeAt(i);
				if (code >= 0xd800 && code <= 0xdbff) {
					// High surrogate must be followed by low surrogate in the same chunk.
					const next = chunk.charCodeAt(i + 1);
					assert.ok(next >= 0xdc00 && next <= 0xdfff, `lone high surrogate at pos ${i}`);
				}
				if (code >= 0xdc00 && code <= 0xdfff) {
					const prev = chunk.charCodeAt(i - 1);
					assert.ok(prev >= 0xd800 && prev <= 0xdbff, `lone low surrogate at pos ${i}`);
				}
			}
		}
		// All content is preserved.
		assert.equal(chunks.map(visibleText).join(""), "aa\u{1F600}bb");
	});

	test("splits an oversized fenced block into valid pre pieces", () => {
		const code = Array.from({ length: 8 }, (_, i) => `line_${i} = ${i} & ${i}`).join("\n");
		const blocks = markdownToTelegramHtmlBlocks(`\`\`\`py\n${code}\n\`\`\``);
		const chunks = chunkTelegramHtml(blocks, 30);
		assert.ok(chunks.length > 1);
		for (const chunk of chunks) {
			assert.ok(chunk.startsWith('<pre><code class="language-py">'));
			assert.ok(chunk.endsWith("</code></pre>"));
			assert.ok(visibleLength(chunk) <= 30);
			assert.ok(tagsBalanced(chunk));
		}
		assert.equal(chunks.map(visibleText).join(""), code);
	});

	test("full pipeline default limit holds for a large mixed document", () => {
		const doc = [
			"# Heading",
			"A paragraph with `code` and **bold** and a link [x](https://h/a?b=1&c=2).",
			`\`\`\`ts\nconst data = ${"y".repeat(9000)};\n\`\`\``,
			"- one\n- two\n- three",
			"> a quote",
		].join("\n\n");
		const chunks = renderTelegramHtmlChunks(doc);
		assert.ok(chunks.length > 1);
		for (const chunk of chunks) {
			assert.ok(visibleLength(chunk) <= TELEGRAM_MESSAGE_LIMIT);
			assert.ok(tagsBalanced(chunk));
		}
	});
});

describe("renderTelegramHtmlCaption", () => {
	test("short caption renders as HTML", () => {
		const caption = renderTelegramHtmlCaption("a **b**");
		assert.deepEqual(caption, { text: "a <b>b</b>", parseMode: "HTML" });
	});

	test("over-limit caption degrades to truncated plain text without parse mode", () => {
		const caption = renderTelegramHtmlCaption(`**${"z".repeat(TELEGRAM_CAPTION_LIMIT + 100)}**`);
		assert.equal(caption.parseMode, undefined);
		assert.ok(caption.text.length <= TELEGRAM_CAPTION_LIMIT);
		assert.ok(!caption.text.includes("<b>"));
		assert.ok(caption.text.endsWith("…"));
	});
});

describe("htmlToPlainText", () => {
	test("strips tags, keeps URLs, and decodes entities", () => {
		const plain = htmlToPlainText('<b>hi</b> <a href="https://h/x">link</a> &amp; <code>a&lt;b</code>');
		assert.equal(plain, "hi link (https://h/x) & a<b");
	});

	test("a link whose text equals its href is not duplicated", () => {
		assert.equal(htmlToPlainText('<a href="https://h/x">https://h/x</a>'), "https://h/x");
	});
});
