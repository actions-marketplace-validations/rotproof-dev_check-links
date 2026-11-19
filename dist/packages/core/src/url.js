"use strict";
/**
 * URL normalization and the crawler's URL safety rules (CLAUDE.md crawler rule 5).
 *
 * Everything here runs on attacker-controlled strings. Hostnames that resolve to
 * private addresses can't be caught here (no DNS in a pure function); Cloudflare's
 * egress refuses those. This layer covers what is decidable from the URL alone,
 * and must be re-applied at every redirect hop.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_URL_LENGTH = void 0;
exports.normalizePercentEncoding = normalizePercentEncoding;
exports.normalizeUrl = normalizeUrl;
exports.scrubUrlCredentials = scrubUrlCredentials;
exports.parseIpv6 = parseIpv6;
exports.checkUrlSafety = checkUrlSafety;
exports.MAX_URL_LENGTH = 4096;
const SCHEME_PREFIX = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;
const UNRESERVED = /^[A-Za-z0-9\-._~]$/;
/** RFC 3986 equivalence: uppercase escapes, decode escaped unreserved characters. */
function normalizePercentEncoding(part) {
    return part.replace(/%[0-9a-fA-F]{2}/g, (escape) => {
        const char = String.fromCharCode(parseInt(escape.slice(1), 16));
        return UNRESERVED.test(char) ? char : escape.toUpperCase();
    });
}
/**
 * Canonicalize a URL as written on a page, resolving it against `base` if relative.
 *
 * Deliberately keeps query order, trailing slashes and tracking parameters: each can
 * select a different resource, and merging two distinct links would hide a break.
 * Drops embedded credentials, so they can never reach storage, logs or a request.
 */
function normalizeUrl(raw, base) {
    const trimmed = raw.trim();
    if (trimmed === "")
        return { ok: false, reason: "empty" };
    // Checked before the length limit so a huge data: URI is reported as what it is,
    // and before parsing so we never do work on it.
    const scheme = SCHEME_PREFIX.exec(trimmed)?.[1]?.toLowerCase();
    if (scheme !== undefined && scheme !== "http" && scheme !== "https") {
        return { ok: false, reason: "unsupported_scheme" };
    }
    if (trimmed.length > exports.MAX_URL_LENGTH)
        return { ok: false, reason: "too_long" };
    let parsed;
    try {
        parsed = new URL(trimmed, base);
    }
    catch {
        return { ok: false, reason: "invalid" };
    }
    // Second check: the parser strips tabs and newlines, so "java\nscript:" only
    // reveals its scheme here.
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return { ok: false, reason: "unsupported_scheme" };
    }
    const credentialsStripped = parsed.username !== "" || parsed.password !== "";
    const host = parsed.hostname.replace(/\.+$/, "");
    if (host === "")
        return { ok: false, reason: "invalid" };
    const port = parsed.port === "" ? "" : `:${parsed.port}`;
    const path = normalizePercentEncoding(parsed.pathname);
    const query = normalizePercentEncoding(parsed.search);
    const url = `${parsed.protocol}//${host}${port}${path}${query}`;
    if (url.length > exports.MAX_URL_LENGTH)
        return { ok: false, reason: "too_long" };
    return {
        ok: true,
        url,
        fragment: parsed.hash.length > 1 ? parsed.hash.slice(1) : null,
        host,
        credentialsStripped,
    };
}
const isAsciiLetter = (code) => (code | 0x20) >= 0x61 && (code | 0x20) <= 0x7a;
const isDigit = (code) => code >= 0x30 && code <= 0x39;
/** [a-zA-Z0-9+.-] */
const isSchemeChar = (code) => isAsciiLetter(code) || isDigit(code) || code === 0x2b || code === 0x2e || code === 0x2d;
/** \w without the u flag: [a-zA-Z0-9_] */
const isWordChar = (code) => isAsciiLetter(code) || isDigit(code) || code === 0x5f;
const isSlash = (code) => code === 0x2f || code === 0x5c;
/** The run that may hold user:password@. Sticky, so it matches forward from lastIndex only. */
const USERINFO_RUN = /[^\s/\\?#"'<>]*/y;
/**
 * Is there a scheme, as /\b[a-zA-Z][a-zA-Z0-9+.-]*$/ would find one, right before the ":"
 * at `colon`? Looks back only to the previous character that can't be in a scheme.
 */
function hasSchemeBefore(text, colon) {
    let start = colon;
    while (start > 0 && isSchemeChar(text.charCodeAt(start - 1)))
        start--;
    for (let at = start; at < colon; at++) {
        if (isAsciiLetter(text.charCodeAt(at)) && (at === 0 || !isWordChar(text.charCodeAt(at - 1))))
            return true;
    }
    return false;
}
/**
 * Remove user:password@ from every URL inside free text: page text, where link text
 * often repeats the href, and stored header values such as Location. Use normalizeUrl
 * for a value that is only a URL. Everything up to the last @ before the path goes, so a
 * password containing @ goes too, while /@scope/pkg and ?email=a@b stay intact.
 *
 * Same result as text.replace(/\b([a-zA-Z][a-zA-Z0-9+.-]*:[/\\]{2})[^\s/\\?#"'<>]*@/g, "$1"),
 * but linear: that regex took quadratic time on text like "a.a.a.a…", and this runs on
 * crawled page text.
 */
function scrubUrlCredentials(text) {
    let out = "";
    let copied = 0;
    let from = 0;
    for (;;) {
        const colon = text.indexOf(":", from);
        if (colon < 0)
            break;
        from = colon + 1;
        if (!isSlash(text.charCodeAt(colon + 1)) || !isSlash(text.charCodeAt(colon + 2)))
            continue;
        if (!hasSchemeBefore(text, colon))
            continue;
        // Drop through the last @ in the run after "://". Runs never overlap, so this is linear.
        const userinfo = colon + 3;
        USERINFO_RUN.lastIndex = userinfo;
        USERINFO_RUN.test(text);
        const lastAt = text.slice(userinfo, USERINFO_RUN.lastIndex).lastIndexOf("@");
        if (lastAt < 0)
            continue;
        out += text.slice(copied, userinfo);
        copied = userinfo + lastAt + 1;
        from = copied;
    }
    return copied === 0 ? text : out + text.slice(copied);
}
/** Non-global IPv4 ranges (RFC 6890 and successors) as [network, prefix length]. */
const BLOCKED_IPV4 = [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
];
function ipv4ToInt(ip) {
    return ip.split(".").reduce((acc, octet) => acc * 256 + Number(octet), 0);
}
function isBlockedIpv4(ip) {
    const value = ipv4ToInt(ip);
    return BLOCKED_IPV4.some(([network, prefix]) => {
        const size = 2 ** (32 - prefix);
        return Math.floor(value / size) === Math.floor(ipv4ToInt(network) / size);
    });
}
/** Parse the parser's canonical IPv6 text into 8 groups, or null if it isn't valid. */
function parseIpv6(text) {
    const sides = text.split("::");
    if (sides.length > 2)
        return null;
    const groups = (side) => side === undefined || side === "" ? [] : side.split(":").map((g) => parseInt(g, 16));
    const head = groups(sides[0]);
    const tail = groups(sides[1]);
    const missing = 8 - head.length - tail.length;
    if (missing < 0 || (sides.length === 1 && missing !== 0))
        return null;
    const all = [...head, ...new Array(missing).fill(0), ...tail];
    return all.some(Number.isNaN) ? null : all;
}
/**
 * Allow-list: only global unicast (2000::/3) minus its special blocks. This also
 * refuses every transition form that can smuggle an IPv4 address (::ffff:0:0/96,
 * 64:ff9b::/96, 6to4, Teredo). No real link needs those, and failing closed means a
 * new special range can't slip through.
 */
function isGlobalIpv6(text) {
    const groups = parseIpv6(text);
    if (groups === null)
        return false;
    const a = groups[0] ?? 0;
    const b = groups[1] ?? 0;
    if (a < 0x2000 || a > 0x3fff)
        return false;
    if (a === 0x2001 && b < 0x0200)
        return false; // IETF special use, including Teredo
    if (a === 0x2001 && b === 0x0db8)
        return false; // documentation
    if (a === 0x2002)
        return false; // 6to4
    if (a === 0x3fff && b < 0x1000)
        return false; // documentation (RFC 9637)
    return true;
}
function matchesDomain(host, domain) {
    return host === domain || host.endsWith(`.${domain}`);
}
const INTERNAL_DOMAINS = [
    "localhost",
    "localdomain",
    "local",
    "internal",
    "intranet",
    "lan",
    "home",
    "corp",
    "private",
    "home.arpa",
    "onion",
];
/**
 * RFC 2606 names. Documentation is full of links like https://example.com/your-app;
 * they are placeholders, and reporting them would be a false alarm.
 */
const RESERVED_DOMAINS = ["test", "example", "invalid", "example.com", "example.net", "example.org"];
/**
 * Crawler rule 5, decidable from the URL alone. Numeric IPv4 spellings
 * (2130706433, 0x7f.1, 017700000001, 127.1) need no handling here: the URL parser
 * has already canonicalized them to dotted form.
 *
 * Refuses a URL that still has credentials: normalizeUrl removes them, so one reaching
 * this check skipped normalization and must not be fetched.
 */
function checkUrlSafety(url) {
    let parsed;
    try {
        parsed = new URL(url);
    }
    catch {
        return { safe: false, reason: "invalid" };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return { safe: false, reason: "scheme" };
    }
    if (parsed.port !== "")
        return { safe: false, reason: "port" };
    if (parsed.username !== "" || parsed.password !== "") {
        return { safe: false, reason: "credentials" };
    }
    const host = parsed.hostname.replace(/\.+$/, "");
    if (host === "")
        return { safe: false, reason: "invalid" };
    if (host.startsWith("[")) {
        return isGlobalIpv6(host.slice(1, -1))
            ? { safe: true, host }
            : { safe: false, reason: "private_ip" };
    }
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
        return isBlockedIpv4(host) ? { safe: false, reason: "private_ip" } : { safe: true, host };
    }
    if (!host.includes(".") || INTERNAL_DOMAINS.some((d) => matchesDomain(host, d))) {
        return { safe: false, reason: "internal_hostname" };
    }
    if (RESERVED_DOMAINS.some((d) => matchesDomain(host, d))) {
        return { safe: false, reason: "reserved_hostname" };
    }
    return { safe: true, host };
}
