"use strict";
/**
 * Reads a page's links and fragment targets without the Workers runtime, for the CI check
 * (docs/plans/ci-check.md): the Action runs on GitHub's machines, under Node, which has no
 * HTMLRewriter. This is a tag scanner, not a parser: it finds start and end tags the way the
 * HTML standard's tokenizer does and looks at nothing else.
 *
 * It must agree with parsePage (./page.ts) on which links a page has and which ids. The link
 * rules themselves are shared (./links.ts), and a test runs both readers over every fixture
 * and compares them.
 *
 * All output is attacker-controlled, as with parsePage: every consumer escapes it.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.scanPage = scanPage;
const links_1 = require("./links");
/** Elements whose content is text up to their own end tag, never tags. */
const RAW_TEXT = new Set(["script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes", "noscript"]);
/** Elements whose content is parsed but isn't the page: links inside don't count, ids do. */
const HIDDEN = new Set(["template", "svg", "math"]);
const isSpace = (code) => code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d;
const isLetter = (code) => (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
/**
 * Reads a tag whose name starts at `from`. Null when the page ends inside the tag: the
 * standard drops such a tag, and so does this.
 */
function readTag(html, from) {
    const length = html.length;
    let i = from;
    while (i < length) {
        const code = html.charCodeAt(i);
        if (isSpace(code) || code === 0x2f || code === 0x3e)
            break;
        i++;
    }
    const name = html.slice(from, i).toLowerCase();
    const attributes = new Map();
    let selfClosing = false;
    for (;;) {
        while (i < length && (isSpace(html.charCodeAt(i)) || html.charCodeAt(i) === 0x2f)) {
            selfClosing = html.charCodeAt(i) === 0x2f && html.charCodeAt(i + 1) === 0x3e;
            i++;
        }
        if (i >= length)
            return null;
        if (html.charCodeAt(i) === 0x3e)
            return { name, attributes, selfClosing, end: i + 1 };
        selfClosing = false;
        // A name runs to a space, "/", ">" or "=". An "=" in first place is part of the name.
        const nameStart = i;
        i++;
        while (i < length) {
            const code = html.charCodeAt(i);
            if (isSpace(code) || code === 0x2f || code === 0x3e || code === 0x3d)
                break;
            i++;
        }
        const attribute = html.slice(nameStart, i).toLowerCase();
        while (i < length && isSpace(html.charCodeAt(i)))
            i++;
        let value = "";
        if (html.charCodeAt(i) === 0x3d) {
            i++;
            while (i < length && isSpace(html.charCodeAt(i)))
                i++;
            const quote = html.charCodeAt(i);
            if (quote === 0x22 || quote === 0x27) {
                const close = html.indexOf(quote === 0x22 ? '"' : "'", i + 1);
                if (close === -1)
                    return null;
                value = html.slice(i + 1, close);
                i = close + 1;
            }
            else {
                const valueStart = i;
                while (i < length && !isSpace(html.charCodeAt(i)) && html.charCodeAt(i) !== 0x3e)
                    i++;
                value = html.slice(valueStart, i);
            }
        }
        // The first of a repeated attribute wins.
        if (!attributes.has(attribute))
            attributes.set(attribute, value);
    }
}
/** Where the end tag of a raw-text element starts, or the end of the page. */
function rawTextEnd(html, name, from) {
    const lower = `</${name}`;
    let at = from;
    for (;;) {
        const lt = html.indexOf("</", at);
        if (lt === -1)
            return html.length;
        if (html.slice(lt, lt + lower.length).toLowerCase() === lower) {
            const after = html.charCodeAt(lt + lower.length);
            if (Number.isNaN(after) || isSpace(after) || after === 0x2f || after === 0x3e)
                return lt;
        }
        at = lt + 2;
    }
}
function scanPage(html, pageUrl) {
    const raw = [];
    const anchors = new Set();
    const skipped = {};
    const countSkip = (reason) => {
        skipped[reason] = (skipped[reason] ?? 0) + 1;
    };
    let anchorsComplete = true;
    let linksTruncated = false;
    let baseHref = null;
    let hiddenDepth = 0;
    const addAnchor = (value) => {
        if (value === undefined || value === "")
            return;
        if (anchors.size >= links_1.MAX_ANCHORS_PER_PAGE) {
            anchorsComplete = false;
            return;
        }
        anchors.add((0, links_1.decodeHtmlEntities)(value));
    };
    const addLink = (kind, href, at) => {
        if (href === undefined)
            return;
        if (raw.length >= links_1.MAX_LINKS_PER_PAGE) {
            linksTruncated = true;
            return;
        }
        raw.push({ kind, href: (0, links_1.decodeHtmlEntities)(href), at });
    };
    const length = html.length;
    let i = 0;
    while (i < length) {
        const lt = html.indexOf("<", i);
        if (lt === -1)
            break;
        const next = html.charCodeAt(lt + 1);
        if (next === 0x21 || next === 0x3f) {
            // A comment, a doctype, or something the standard treats as a comment.
            if (html.startsWith("<!--", lt)) {
                if (html.startsWith("<!-->", lt) || html.startsWith("<!--->", lt)) {
                    i = html.indexOf(">", lt) + 1;
                    continue;
                }
                const close = html.indexOf("-->", lt + 4);
                const bang = html.indexOf("--!>", lt + 4);
                if (close === -1 && bang === -1)
                    break;
                i = close !== -1 && (bang === -1 || close < bang) ? close + 3 : bang + 4;
                continue;
            }
            const close = html.indexOf(">", lt + 2);
            if (close === -1)
                break;
            i = close + 1;
            continue;
        }
        if (next === 0x2f) {
            if (!isLetter(html.charCodeAt(lt + 2))) {
                // "</>" is nothing; "</" then anything else is a comment up to ">".
                const close = html.indexOf(">", lt + 2);
                if (close === -1)
                    break;
                i = close + 1;
                continue;
            }
            const tag = readTag(html, lt + 2);
            if (tag === null)
                break;
            if (HIDDEN.has(tag.name) && hiddenDepth > 0)
                hiddenDepth--;
            i = tag.end;
            continue;
        }
        if (!isLetter(next)) {
            i = lt + 1;
            continue;
        }
        const tag = readTag(html, lt + 1);
        if (tag === null)
            break;
        i = tag.end;
        const { name, attributes } = tag;
        addAnchor(attributes.get("id"));
        if (name === "a")
            addAnchor(attributes.get("name"));
        if (hiddenDepth === 0) {
            if (name === "a")
                addLink("a", attributes.get("href"), lt);
            else if (name === "img")
                addLink("img", attributes.get("src"), lt);
            else if (name === "script")
                addLink("script", attributes.get("src"), lt);
            else if (name === "iframe")
                addLink("iframe", attributes.get("src"), lt);
            else if (name === "link" && attributes.has("href")) {
                if ((0, links_1.isNonPageRel)(attributes.get("rel") ?? null))
                    countSkip("resource_hint");
                else
                    addLink("link", attributes.get("href"), lt);
            }
            else if (name === "base" && attributes.has("href"))
                baseHref ??= attributes.get("href") ?? null;
        }
        if (name === "plaintext")
            break;
        if (RAW_TEXT.has(name))
            i = rawTextEnd(html, name, i);
        // A self-closed <svg/> or <math/> has no content. <template/> isn't self-closing in HTML.
        else if (HIDDEN.has(name) && !(tag.selfClosing && name !== "template"))
            hiddenDepth++;
    }
    const base = (0, links_1.resolveBase)(baseHref, pageUrl);
    const links = [];
    // Links come in page order, so lines are counted in one pass.
    let line = 1;
    let counted = 0;
    for (const link of raw) {
        for (let at = html.indexOf("\n", counted); at !== -1 && at < link.at; at = html.indexOf("\n", at + 1)) {
            line++;
            counted = at + 1;
        }
        const resolved = (0, links_1.resolveHref)(link.href, base);
        if (!resolved.ok) {
            countSkip(resolved.reason);
            continue;
        }
        links.push({ kind: link.kind, url: resolved.url, fragment: resolved.fragment, host: resolved.host, line });
    }
    return { links, anchors, anchorsComplete, linksTruncated, skipped };
}
