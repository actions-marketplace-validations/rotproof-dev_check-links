"use strict";
/**
 * Pages a change removes (docs/plans/moved-pages.md): pages Rotproof found on the live site
 * that the build has no page for, and that nothing in the build redirects. Once the change is
 * published, every link to them from other sites, search results and bookmarks breaks, and no
 * check of this site's own links can see it, because those links aren't on this site.
 *
 * Rotproof sends the live pages' addresses and titles. The comparison happens here, on the
 * build's machine, so the build's pages are never sent anywhere.
 *
 * It only warns: a host can redirect in settings the build doesn't contain, and Rotproof's
 * list of live pages is as old as its latest check of the site.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.readRedirectRules = readRedirectRules;
exports.pageKey = pageKey;
exports.findMissing = findMissing;
exports.generatorOf = generatorOf;
exports.redirectTool = redirectTool;
exports.redirectHelp = redirectHelp;
const paths_1 = require("./paths");
/** More missing than this, and more than half the site, and the build isn't the whole site. */
const MOSTLY_MISSING_MIN = 10;
/** A folder with at least this many live pages, all missing, is one line. */
const FOLDER_MIN = 5;
/** Lines read from a _redirects file. Netlify allows a few thousand; Cloudflare 2,100. */
const MAX_RULES = 10_000;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
 * The rules in a `_redirects` file (Netlify, Cloudflare Pages and Workers) that keep an address
 * answering: a redirect, or a deliberate answer for that one address. A catch-all that serves
 * a single page or a "not found" page for everything (`/* /index.html 200`) doesn't count: the
 * page is still gone.
 */
function readRedirectRules(text, host) {
    const rules = [];
    for (const raw of text.split(/\r?\n/).slice(0, MAX_RULES)) {
        const line = raw.trim();
        if (line === "" || line.startsWith("#"))
            continue;
        const [from = "", ...rest] = line.split(/\s+/);
        // Netlify's query conditions sit between the two addresses, as key=value. A rule that
        // needs one never applies to a page's own address.
        if (rest[0] !== undefined && rest[0].includes("=") && !rest[0].startsWith("/") && !SCHEME.test(rest[0]))
            continue;
        const status = /^(\d{3})!?$/.exec(rest[1] ?? "")?.[1] ?? "301";
        let path = from;
        if (SCHEME.test(from)) {
            try {
                const url = new URL(from.replace(/\*$/, ""));
                if (url.host !== host)
                    continue;
                path = url.pathname + (from.endsWith("*") ? "*" : "");
            }
            catch {
                continue;
            }
        }
        if (!path.startsWith("/"))
            continue;
        const splat = path.endsWith("*");
        if (splat && !status.startsWith("3"))
            continue;
        const parts = path
            .replace(/\*$/, "")
            .replace(/\/+$/, "")
            .split("/")
            .map((part) => (part.startsWith(":") && part.length > 1 ? "[^/]+" : escapeRegExp(part)));
        const body = parts.join("/");
        rules.push({ pattern: new RegExp(splat ? `^${body}(?:/.*)?$` : `^${body}/?$`, "i") });
    }
    return rules;
}
const redirected = (rules, url) => {
    const path = new URL(url).pathname;
    return rules.some((rule) => rule.pattern.test(path));
};
/** One key for the ways a page's address is written: /a, /a/, /a.html, /a/index.html. */
function pageKey(url) {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/index\.html?$/i, "/").replace(/\.html?$/i, "").replace(/\/+$/, "");
    return `${parsed.host}${path}`;
}
const normalTitle = (title) => (title ?? "").toLowerCase().replace(/\s+/g, " ").trim();
/** The last part of an address, the way people rename pages: "setup" from /guide/setup.html. */
function slug(url) {
    const parts = new URL(url).pathname.split("/").filter((part) => part !== "");
    const last = (parts.at(-1) ?? "").replace(/\.html?$/i, "").toLowerCase();
    return last === "index" ? "" : last;
}
/**
 * The new page that matches, when the match is one to one: one missing page has the key, and
 * one page in the whole build, which is new. A title or name used twice says nothing.
 */
function onlyMatch(key, missingByKey, builtByKey, fresh) {
    if (key === "" || missingByKey.get(key) !== 1)
        return null;
    const found = builtByKey.get(key) ?? [];
    return found.length === 1 && found[0] !== undefined && fresh.has(found[0].file) ? found[0] : null;
}
function groupBy(items, key) {
    const out = new Map();
    for (const item of items) {
        const k = key(item);
        if (k === "")
            continue;
        out.set(k, [...(out.get(k) ?? []), item]);
    }
    return out;
}
/** The folders a page is in, inside the site: /api/ and /api/auth/ for /api/auth/keys.html. */
function folders(root, url) {
    const relative = new URL(url).pathname.slice(new URL(root).pathname.length);
    const out = [];
    for (let at = relative.indexOf("/"); at !== -1; at = relative.indexOf("/", at + 1))
        out.push(root + relative.slice(0, at + 1));
    return out;
}
function findMissing({ root, live, files, built, rules, linksTo }) {
    // The site's own pages, once each. A page with a query string isn't a file in any build.
    const seen = new Set();
    const inScope = live.filter((page) => {
        let url;
        try {
            url = new URL(page.url);
        }
        catch {
            return false;
        }
        if (url.search !== "" || (!page.url.startsWith(root) && `${page.url}/` !== root))
            return false;
        const key = pageKey(page.url);
        if (seen.has(key))
            return false;
        seen.add(key);
        return true;
    });
    const liveFiles = new Set();
    const missing = [];
    for (const page of inScope) {
        const file = (0, paths_1.builtFile)(root, page.url, files);
        if (file !== null)
            liveFiles.add(file);
        else if (!redirected(rules, page.url))
            missing.push(page);
    }
    if (missing.length > MOSTLY_MISSING_MIN && missing.length * 2 > inScope.length) {
        return { pages: [], folders: [], mostlyMissing: { missing: missing.length, live: inScope.length } };
    }
    // A folder whose every live page is missing is shown once.
    const liveIn = new Map();
    const missingIn = new Map();
    for (const page of inScope)
        for (const folder of folders(root, page.url))
            liveIn.set(folder, (liveIn.get(folder) ?? 0) + 1);
    for (const page of missing)
        for (const folder of folders(root, page.url))
            missingIn.set(folder, (missingIn.get(folder) ?? 0) + 1);
    const wholeFolder = (page) => folders(root, page.url).find((folder) => (missingIn.get(folder) ?? 0) >= FOLDER_MIN && missingIn.get(folder) === liveIn.get(folder)) ?? null;
    const grouped = new Map();
    const single = [];
    for (const page of missing) {
        const folder = wholeFolder(page);
        if (folder === null)
            single.push(page);
        else
            grouped.set(folder, (grouped.get(folder) ?? 0) + 1);
    }
    // Where each probably went: a page that's new in this build, matched one to one.
    const fresh = new Set(built.filter((page) => !liveFiles.has(page.file)).map((page) => page.file));
    const liveTitles = groupBy(inScope, (page) => normalTitle(page.title));
    const missingTitles = new Map([...groupBy(single, (page) => normalTitle(page.title))].map(([key, pages]) => [key, (liveTitles.get(key) ?? pages).length]));
    const missingSlugs = new Map([...groupBy(single, (page) => slug(page.url))].map(([key, pages]) => [key, pages.length]));
    const builtByTitle = groupBy(built, (page) => normalTitle(page.title));
    const builtBySlug = groupBy(built, (page) => slug(page.url));
    const pages = single.map((page) => {
        const match = onlyMatch(normalTitle(page.title), missingTitles, builtByTitle, fresh) ?? onlyMatch(slug(page.url), missingSlugs, builtBySlug, fresh);
        return { url: page.url, title: page.title, movedTo: match?.url ?? null, linksInBuild: linksTo.get(pageKey(page.url)) ?? 0 };
    });
    return {
        pages: pages.sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0)),
        folders: [...grouped].map(([url, count]) => ({ url, pages: count })).sort((a, b) => (a.url < b.url ? -1 : 1)),
        mostlyMissing: null,
    };
}
/** What the build's home page says made it, from its generator tag. */
function generatorOf(html) {
    for (const tag of html.slice(0, 256 * 1024).match(/<meta\b[^>]*>/gi) ?? []) {
        const attribute = (name) => new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(tag)?.slice(1).find((value) => value !== undefined) ?? null;
        if (attribute("name")?.toLowerCase() === "generator")
            return attribute("content");
    }
    return null;
}
/** A `_redirects` file wins: the team already redirects there, whatever made the pages. */
function redirectTool(files, generator) {
    if (files.has("_redirects"))
        return "redirects-file";
    if (/^docusaurus\b/i.test(generator ?? ""))
        return "docusaurus";
    if (/^hugo\b/i.test(generator ?? ""))
        return "hugo";
    if (/^jekyll\b/i.test(generator ?? ""))
        return "jekyll";
    return null;
}
/** The path as the tool writes it: inside the site, so a site in a folder leaves the folder off. */
const sitePath = (root, url) => `/${new URL(url).pathname.slice(new URL(root).pathname.length)}`;
/**
 * The redirects to add, in the tool's own format, for every missing page with a clear new
 * address. Values are quoted where the format allows it, so an odd address can't break it.
 */
function redirectHelp(tool, root, pages) {
    const moves = pages.flatMap((page) => (page.movedTo === null ? [] : [{ from: page.url, to: page.movedTo }]));
    if (tool === null || moves.length === 0)
        return null;
    if (tool === "redirects-file") {
        return {
            where: "Add these lines to your _redirects file, in the folder your build copies into the site as it is:",
            text: moves.map((move) => `${new URL(move.from).pathname} ${new URL(move.to).pathname} 301`).join("\n"),
        };
    }
    if (tool === "docusaurus") {
        // Routes: no trailing slash on "from"; "to" as the build wrote it, a folder or a page.
        const from = (url) => sitePath(root, url).replace(/\.html?$/i, "").replace(/(.)\/$/, "$1");
        const to = (url) => sitePath(root, url).replace(/\.html?$/i, "");
        return {
            where: "Add these to the redirects of the client redirects plugin (@docusaurus/plugin-client-redirects) in docusaurus.config.js:",
            text: moves.map((move) => `{ from: ${JSON.stringify(from(move.from))}, to: ${JSON.stringify(to(move.to))} },`).join("\n"),
        };
    }
    // Hugo and Jekyll put the old address on the new page.
    const field = tool === "hugo" ? "aliases" : "redirect_from";
    const byTarget = new Map();
    for (const move of moves)
        byTarget.set(move.to, [...(byTarget.get(move.to) ?? []), sitePath(root, move.from)]);
    return {
        where: tool === "hugo"
            ? "Add the old addresses to the front matter of each page they moved to:"
            : "Add the old addresses to the front matter of each page they moved to, with the jekyll-redirect-from plugin:",
        text: [...byTarget].map(([target, from]) => [`# ${sitePath(root, target)}`, `${field}:`, ...from.map((path) => `  - ${JSON.stringify(path)}`)].join("\n")).join("\n"),
    };
}
