"use strict";
/**
 * The rules for which of a page's links count, shared by the two readers of HTML: parsePage
 * (./page.ts), which runs in the Workers runtime, and scanPage (./html-scan.ts), which runs
 * anywhere. Nothing here needs a runtime, so both give the same answer for the same link.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_ANCHORS_PER_PAGE = exports.MAX_LINKS_PER_PAGE = void 0;
exports.isNonPageRel = isNonPageRel;
exports.decodeHtmlEntities = decodeHtmlEntities;
exports.resolveBase = resolveBase;
exports.resolveHref = resolveHref;
exports.fragmentTargetState = fragmentTargetState;
const url_1 = require("./url");
exports.MAX_LINKS_PER_PAGE = 5_000;
exports.MAX_ANCHORS_PER_PAGE = 20_000;
/**
 * Link relations that don't point at a page a GET should succeed on.
 * https://fonts.gstatic.com returns 404 at its root and xmlrpc.php returns 405, so
 * checking these would raise a false alarm on nearly every site.
 */
const NON_PAGE_RELS = new Set(["preconnect", "dns-prefetch", "pingback", "webmention", "edituri", "wlwmanifest"]);
/** Whether a <link>'s rel says it isn't a page to fetch. */
function isNonPageRel(rel) {
    return (rel ?? "")
        .toLowerCase()
        .split(/\s+/)
        .some((value) => NON_PAGE_RELS.has(value));
}
/**
 * Cloudflare adds /cdn-cgi/ links to pages by itself. Its email protection replaces a
 * mailto with a link that 404s unless JavaScript decodes it in a browser, so checking these
 * raises false alarms on links that work for every visitor. Image resizing is the exception:
 * a site chooses that, and those images can really break.
 */
function isPlatformPath(url) {
    const { pathname } = new URL(url);
    return pathname.startsWith("/cdn-cgi/") && !pathname.startsWith("/cdn-cgi/image/");
}
/** The small set seen in real titles and URLs, not the full 2,231-entry table. */
const NAMED_ENTITIES = new Map([
    ["amp", "&"],
    ["lt", "<"],
    ["gt", ">"],
    ["quot", '"'],
    ["apos", "'"],
    ["nbsp", " "],
    ["ndash", "–"],
    ["mdash", "—"],
    ["hellip", "…"],
    ["lsquo", "‘"],
    ["rsquo", "’"],
    ["ldquo", "“"],
    ["rdquo", "”"],
    ["laquo", "«"],
    ["raquo", "»"],
    ["middot", "·"],
    ["bull", "•"],
    ["copy", "©"],
    ["reg", "®"],
    ["trade", "™"],
]);
function fromCodePoint(code) {
    const invalid = code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff);
    return invalid ? "�" : String.fromCodePoint(code);
}
/**
 * Named entities need their semicolon, so ?a=1&copy=2 stays intact, as it does for
 * browsers in attributes. A Map lookup keeps &constructor; from reaching
 * Object.prototype.
 */
function decodeHtmlEntities(input) {
    if (!input.includes("&"))
        return input;
    return input.replace(/&#(\d{1,7});?|&#[xX]([0-9a-fA-F]{1,6});?|&([a-zA-Z][a-zA-Z0-9]{1,31});/g, (match, dec, hex, name) => {
        if (dec !== undefined)
            return fromCodePoint(parseInt(dec, 10));
        if (hex !== undefined)
            return fromCodePoint(parseInt(hex, 16));
        return NAMED_ENTITIES.get(name ?? "") ?? match;
    });
}
/** Per the HTML spec an unusable <base> is ignored, so fall back to the page's URL. */
function resolveBase(href, pageUrl) {
    if (href === null)
        return pageUrl;
    const resolved = (0, url_1.normalizeUrl)(decodeHtmlEntities(href), pageUrl);
    return resolved.ok ? resolved.url : pageUrl;
}
/**
 * One link's address as written (entities already decoded), made absolute and judged: is it a
 * link we would ever check? The crawler's address rules apply here (crawler rule 5).
 */
function resolveHref(href, base) {
    const normalized = (0, url_1.normalizeUrl)(href, base);
    if (!normalized.ok)
        return { ok: false, reason: normalized.reason };
    if (normalized.fragment === null && href.trim().startsWith("#"))
        return { ok: false, reason: "same_page" };
    const safety = (0, url_1.checkUrlSafety)(normalized.url);
    if (!safety.safe)
        return { ok: false, reason: safety.reason };
    if (isPlatformPath(normalized.url))
        return { ok: false, reason: "platform_path" };
    return { ok: true, url: normalized.url, fragment: normalized.fragment, host: normalized.host, credentialsStripped: normalized.credentialsStripped };
}
/**
 * Whether a link's #fragment has a target among a page's ids. "missing" only when the ids show
 * it's gone, "present" only when it's found, and "unknown" for anything that isn't an element
 * id or can't be judged.
 */
function fragmentTargetState(fragment, anchors, anchorsComplete) {
    if (fragment === null || fragment === undefined || fragment === "")
        return "unknown";
    // Text fragments (#:~:text=...) aren't targets; only the part before the directive is.
    const target = fragment.split(":~:")[0] ?? "";
    if (target === "" || target.toLowerCase() === "top")
        return "unknown";
    // Routes (#/path, #!/path), state (#page=3, #t=30) and code lines (#L10-L20) that
    // GitHub-style viewers handle in JavaScript.
    if (/^[/!]/.test(target) || target.includes("=") || /^[LR]\d+(?:-[LR]?\d+)?$/.test(target)) {
        return "unknown";
    }
    let decoded = target;
    try {
        decoded = decodeURIComponent(target);
    }
    catch {
        // A malformed escape can still match literally, below.
    }
    const found = [target, decoded].some(
    // GitHub renders README headings as id="user-content-x" and scrolls with JavaScript.
    (name) => anchors.has(name) || anchors.has(`user-content-${name}`));
    if (found)
        return "present";
    if (!anchorsComplete || anchors.size === 0)
        return "unknown";
    return "missing";
}
