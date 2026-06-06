// Renders agent Markdown into Telegram's HTML subset and splits it into
// payloads that are individually valid and within Telegram's length limit.
//
// Why HTML instead of Telegram's Markdown parse modes:
//   - HTML only requires escaping `< > &`, which is total and unambiguous,
//     unlike legacy Markdown (no escapes) or MarkdownV2 (escape ~18 chars with
//     context-dependent rules).
//   - Entities are explicit open/close tags, so when a long message must be
//     split mid-formatting we can mechanically close the open tags at the cut
//     and reopen them in the next chunk. Markdown delimiters can't be
//     re-balanced reliably.
//   - Using a real CommonMark lexer also fixes incidental-markup bugs for free:
//     intraword `_` (e.g. `hello_world`) is not emphasis in CommonMark, so it
//     renders literally instead of opening an unterminated entity.
//
// Telegram's supported tags: b/strong, i/em, u/ins, s/strike/del, code, pre,
// a, blockquote, tg-spoiler. There are no list/heading/table/hr tags, so those
// block types are downgraded to text (bold heading line, bulleted lines, a
// monospace table, a rule of dashes).

import { marked, type Token, type Tokens } from "marked";

// Telegram limits are measured in UTF-16 code units of the *visible* text
// (after entity parsing); tags and the markup of entities do not count.
export const TELEGRAM_MESSAGE_LIMIT = 4096;
export const TELEGRAM_CAPTION_LIMIT = 1024;

const BLOCK_SEPARATOR = "\n\n";

// Escape a literal whose every `&` must become an entity (code spans, code
// blocks, table bodies). The source text is taken verbatim.
function escapeLiteral(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Escape an attribute value (href, code language): escapeLiteral plus the double
// quote that would otherwise terminate the attribute.
function escapeAttr(value: string): string {
	return escapeLiteral(value).replace(/"/g, "&quot;");
}

const NAMED_ENTITY_DECODE: Array<[RegExp, string]> = [
	[/&lt;/g, "<"],
	[/&gt;/g, ">"],
	[/&quot;/g, '"'],
	[/&apos;/g, "'"],
	[/&#39;/g, "'"],
];

function safeCodePoint(code: number): string {
	return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
}

// Decode the entities this module understands into real characters. `&amp;` is
// decoded last so `&amp;lt;` resolves to the literal `&lt;`. Unrecognized
// sequences (e.g. `&copy;`, `&foo;`) are intentionally left untouched so that a
// following escape pass turns their `&` into `&amp;`.
function decodeEntities(value: string): string {
	let out = value
		.replace(/&#(\d+);/g, (_, dec: string) => safeCodePoint(Number.parseInt(dec, 10)))
		.replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => safeCodePoint(Number.parseInt(hex, 16)));
	for (const [pattern, replacement] of NAMED_ENTITY_DECODE) out = out.replace(pattern, replacement);
	return out.replace(/&amp;/g, "&");
}

// Escape prose. marked leaves source entities (e.g. `&amp;`, `&#169;`) raw in
// text tokens, so we decode the ones we understand to real characters and then
// fully escape. This guarantees nothing reaches Telegram's strict HTML parser
// as an unrecognized entity (a literal `&foo;` would otherwise be rejected with
// "can't parse entities").
function escapeText(value: string): string {
	return escapeLiteral(decodeEntities(value));
}

function renderInline(tokens: Token[] | undefined): string {
	if (!tokens) return "";
	let out = "";
	for (const token of tokens) {
		switch (token.type) {
			case "text": {
				const text = token as Tokens.Text;
				out += text.tokens?.length ? renderInline(text.tokens) : escapeText(text.text);
				break;
			}
			case "escape":
				out += escapeText((token as Tokens.Escape).text);
				break;
			case "strong":
				out += `<b>${renderInline((token as Tokens.Strong).tokens)}</b>`;
				break;
			case "em":
				out += `<i>${renderInline((token as Tokens.Em).tokens)}</i>`;
				break;
			case "del":
				out += `<s>${renderInline((token as Tokens.Del).tokens)}</s>`;
				break;
			case "codespan":
				out += `<code>${escapeLiteral((token as Tokens.Codespan).text)}</code>`;
				break;
			case "br":
				out += "\n";
				break;
			case "link": {
				const link = token as Tokens.Link;
				out += `<a href="${escapeAttr(link.href)}">${renderInline(link.tokens)}</a>`;
				break;
			}
			case "image": {
				// Telegram HTML has no inline image; link the alt text to the source.
				const image = token as Tokens.Image;
				out += `<a href="${escapeAttr(image.href)}">${escapeText(image.text || image.href)}</a>`;
				break;
			}
			case "html":
				// Raw HTML in the source is not Telegram-safe; show it literally.
				out += escapeText((token as Tokens.HTML).text);
				break;
			default:
				out += escapeText((token as { text?: string }).text ?? "");
		}
	}
	return out;
}

function renderCode(code: Tokens.Code): string {
	const body = escapeLiteral(code.text);
	const lang = (code.lang ?? "").trim().split(/\s+/)[0];
	if (lang) return `<pre><code class="language-${escapeAttr(lang)}">${body}</code></pre>`;
	return `<pre>${body}</pre>`;
}

function renderList(list: Tokens.List, depth: number): string {
	const indent = "  ".repeat(depth);
	const lines: string[] = [];
	let index = typeof list.start === "number" ? list.start : 1;
	for (const item of list.items) {
		const marker = list.ordered ? `${index++}.` : "•";
		const checkbox = item.task ? `${item.checked ? "☑" : "☐"} ` : "";
		const inlineParts: string[] = [];
		const nested: string[] = [];
		for (const sub of item.tokens) {
			if (sub.type === "list") {
				nested.push(renderList(sub as Tokens.List, depth + 1));
			} else if (sub.type === "text") {
				const text = sub as Tokens.Text;
				inlineParts.push(text.tokens?.length ? renderInline(text.tokens) : escapeText(text.text));
			} else if (sub.type === "paragraph") {
				inlineParts.push(renderInline((sub as Tokens.Paragraph).tokens));
			} else if (sub.type === "code") {
				inlineParts.push(escapeLiteral((sub as Tokens.Code).text));
			} else if (sub.type !== "space") {
				const text = (sub as { text?: string }).text;
				if (text) inlineParts.push(escapeText(text));
			}
		}
		// Telegram has no list rendering; flatten each item to a single line.
		const body = inlineParts
			.join(" ")
			.replace(/\s*\n\s*/g, " ")
			.trim();
		lines.push(`${indent}${marker} ${checkbox}${body}`.trimEnd());
		for (const block of nested) lines.push(block);
	}
	return lines.join("\n");
}

function renderTable(table: Tokens.Table): string {
	// Best-effort: a monospace block keeps columns roughly aligned. Cell markup
	// is dropped because the table itself is already a downgrade.
	const cell = (value: string): string => value.replace(/\s+/g, " ").trim();
	const header = table.header.map((c) => cell(c.text));
	const rows = table.rows.map((row) => row.map((c) => cell(c.text)));
	const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => (row[i] ?? "").length)));
	const format = (cells: string[]) => cells.map((value, i) => value.padEnd(widths[i] ?? 0)).join("  ");
	const separator = widths.map((width) => "-".repeat(width)).join("  ");
	const lines = [format(header), separator, ...rows.map(format)];
	return `<pre>${escapeLiteral(lines.join("\n"))}</pre>`;
}

function renderBlocks(tokens: Token[]): string[] {
	const blocks: string[] = [];
	for (const token of tokens) {
		switch (token.type) {
			case "space":
				break;
			case "heading":
				blocks.push(`<b>${renderInline((token as Tokens.Heading).tokens)}</b>`);
				break;
			case "paragraph":
				blocks.push(renderInline((token as Tokens.Paragraph).tokens));
				break;
			case "text": {
				const text = token as Tokens.Text;
				blocks.push(text.tokens?.length ? renderInline(text.tokens) : escapeText(text.text));
				break;
			}
			case "blockquote":
				blocks.push(`<blockquote>${renderBlocks((token as Tokens.Blockquote).tokens).join("\n")}</blockquote>`);
				break;
			case "list":
				blocks.push(renderList(token as Tokens.List, 0));
				break;
			case "code":
				blocks.push(renderCode(token as Tokens.Code));
				break;
			case "table":
				blocks.push(renderTable(token as Tokens.Table));
				break;
			case "hr":
				blocks.push("──────────");
				break;
			case "html":
				blocks.push(escapeText((token as Tokens.HTML).text).trim());
				break;
			default: {
				const text = (token as { text?: string }).text;
				if (text) blocks.push(escapeText(text));
			}
		}
	}
	return blocks.filter((block) => block.length > 0);
}

export function markdownToTelegramHtmlBlocks(markdown: string): string[] {
	const tokens = marked.lexer(markdown.replace(/\r\n/g, "\n").trim());
	return renderBlocks(tokens);
}

// Visible length as Telegram counts it: tags removed, entities count as one.
export function visibleLength(html: string): number {
	return decodeEntities(html.replace(/<[^>]+>/g, "")).length;
}

function closeTagFor(openTag: string): string {
	const match = /^<\s*([a-zA-Z0-9]+)/.exec(openTag);
	return match ? `</${match[1]}>` : "";
}

type Atom = { kind: "open" | "close" | "text"; str: string };

function tokenizeHtml(html: string): Atom[] {
	const atoms: Atom[] = [];
	let i = 0;
	while (i < html.length) {
		const ch = html[i];
		if (ch === "<") {
			// Safe to scan to the first `>`: every attribute value is run through
			// escapeAttr, so a literal `>` can never appear inside a tag here.
			const end = html.indexOf(">", i);
			const tag = end === -1 ? html.slice(i) : html.slice(i, end + 1);
			atoms.push({ kind: tag.startsWith("</") ? "close" : "open", str: tag });
			i += tag.length;
		} else if (ch === "&") {
			const semi = html.indexOf(";", i);
			if (semi !== -1 && semi - i <= 10) {
				atoms.push({ kind: "text", str: html.slice(i, semi + 1) });
				i = semi + 1;
			} else {
				atoms.push({ kind: "text", str: ch });
				i += 1;
			}
		} else {
			// Emit surrogate pairs as a single 2-char atom so they are never
			// split across chunk boundaries (which would produce invalid UTF-16).
			const code = html.charCodeAt(i);
			if (code >= 0xd800 && code <= 0xdbff && i + 1 < html.length) {
				atoms.push({ kind: "text", str: html[i] + html[i + 1] });
				i += 2;
			} else {
				atoms.push({ kind: "text", str: ch });
				i += 1;
			}
		}
	}
	return atoms;
}

// Split a single block whose visible length exceeds the limit. Inline tags
// (including a <pre><code> wrapper) are closed at the cut and reopened in the
// next piece, so every piece is independently valid.
function splitBlock(html: string, limit: number): string[] {
	const pieces: string[] = [];
	const stack: string[] = [];
	let current = "";
	let currentVisible = 0;
	for (const atom of tokenizeHtml(html)) {
		if (atom.kind === "open") {
			stack.push(atom.str);
			current += atom.str;
			continue;
		}
		if (atom.kind === "close") {
			stack.pop();
			current += atom.str;
			continue;
		}
		// atom.str.length is 1 for BMP chars/entities, 2 for surrogate pairs.
		const atomVisible = atom.str.length;
		if (currentVisible + atomVisible > limit) {
			current += stack.map(closeTagFor).reverse().join("");
			pieces.push(current);
			current = stack.join("");
			currentVisible = 0;
		}
		current += atom.str;
		currentVisible += atomVisible;
	}
	// Defensive: close anything still open (balanced input leaves the stack empty).
	if (stack.length > 0) current += stack.map(closeTagFor).reverse().join("");
	if (current.length > 0) pieces.push(current);
	return pieces;
}

// Pack rendered blocks into messages: combine adjacent blocks up to the limit,
// and split any single oversized block.
export function chunkTelegramHtml(blocks: string[], limit = TELEGRAM_MESSAGE_LIMIT): string[] {
	const messages: string[] = [];
	let current = "";
	let currentVisible = 0;
	const flush = () => {
		if (current.length > 0) messages.push(current);
		current = "";
		currentVisible = 0;
	};
	for (const block of blocks) {
		const blockVisible = visibleLength(block);
		if (blockVisible > limit) {
			flush();
			for (const piece of splitBlock(block, limit)) messages.push(piece);
			continue;
		}
		const separatorVisible = current.length > 0 ? BLOCK_SEPARATOR.length : 0;
		if (currentVisible + separatorVisible + blockVisible > limit) {
			flush();
			current = block;
			currentVisible = blockVisible;
		} else {
			current = current.length > 0 ? current + BLOCK_SEPARATOR + block : block;
			currentVisible += separatorVisible + blockVisible;
		}
	}
	flush();
	return messages;
}

export function renderTelegramHtmlChunks(markdown: string, limit = TELEGRAM_MESSAGE_LIMIT): string[] {
	return chunkTelegramHtml(markdownToTelegramHtmlBlocks(markdown), limit);
}

// Caption for a media message. Captions can't be chunked, so an over-limit
// caption degrades to truncated plain text (carried separately as a follow-up
// message by the caller if needed).
export function renderTelegramHtmlCaption(
	markdown: string,
	limit = TELEGRAM_CAPTION_LIMIT,
): { text: string; parseMode?: "HTML" } {
	const html = markdownToTelegramHtmlBlocks(markdown).join(BLOCK_SEPARATOR);
	if (visibleLength(html) <= limit) return { text: html, parseMode: "HTML" };
	const plain = htmlToPlainText(html);
	if (plain.length <= limit) return { text: plain };
	// Telegram measures length in UTF-16 code units; slice by code units but back
	// off one if the cut would leave a lone high surrogate.
	let truncated = plain.slice(0, limit - 1);
	const lastUnit = truncated.charCodeAt(truncated.length - 1);
	if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) truncated = truncated.slice(0, -1);
	return { text: `${truncated}…` };
}

// Tag-stripped, entity-decoded text for the plain-text fallback used when
// Telegram still rejects the HTML. Links keep their URL so it isn't lost.
export function htmlToPlainText(html: string): string {
	const withLinks = html.replace(/<a href="([^"]*)">(.*?)<\/a>/gs, (_, href: string, text: string) =>
		text === href ? href : `${text} (${href})`,
	);
	return decodeEntities(withLinks.replace(/<[^>]+>/g, ""));
}
