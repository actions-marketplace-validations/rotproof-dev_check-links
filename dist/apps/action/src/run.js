"use strict";
/**
 * The CI check (docs/plans/ci-check.md): reads a built documentation site, checks its links to
 * its own pages against the build, and asks Rotproof about the rest.
 *
 * Everything here is a pure function of its inputs and the `Io` it's handed, so it's tested
 * without files or a network. `main.cjs` supplies the real ones on GitHub's machines.
 *
 * - **The pages never leave the build.** Rotproof is sent addresses of links, nothing else.
 * - **Rotproof makes every request to another site,** as RotproofBot, under the crawler's rules.
 *   This program requests nothing but rotproof.dev.
 * - **Everything read from a page is hostile:** addresses and file names are escaped before
 *   they're written to the summary or the log (./report.ts).
 * - **Only what Rotproof confirms can fail a build on its own.** A page missing from the build
 *   may be served by something else, so it's a warning unless the live site says it's gone too.
 * - **Live pages the build lacks are warnings, never failures** (./moved.ts). Rotproof sends its
 *   list of the live site's pages; they're compared here.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_LIVE_PAGES = exports.MAX_PAGES = exports.MAX_LISTS = exports.MAX_LIST = exports.API_ORIGIN = exports.pageUrl = exports.builtFile = void 0;
exports.run = run;
const html_scan_1 = require("../../../packages/core/src/html-scan");
const links_1 = require("../../../packages/core/src/links");
const url_1 = require("../../../packages/core/src/url");
const moved_1 = require("./moved");
const paths_1 = require("./paths");
var paths_2 = require("./paths");
Object.defineProperty(exports, "builtFile", { enumerable: true, get: function () { return paths_2.builtFile; } });
Object.defineProperty(exports, "pageUrl", { enumerable: true, get: function () { return paths_2.pageUrl; } });
exports.API_ORIGIN = "https://rotproof.dev";
/** Addresses in one list: the endpoint's limit (LIST_CHECK_MAX_LINKS in packages/core). */
exports.MAX_LIST = 500;
/** Lists sent in one run, one after another. A documentation site can link to thousands of addresses. */
exports.MAX_LISTS = 10;
/** Pages read from one build. A bigger site is checked as far as this. */
exports.MAX_PAGES = 5_000;
/** Live pages read from Rotproof: the most any plan checks (Agency's 25,000), in answers of 5,000. */
exports.MAX_LIVE_PAGES = 25_000;
/** Places kept for one link. The count is kept in full. */
const MAX_PLACES = 3;
/** How long one run waits for Rotproof in all. A list is closed after 15 minutes at most. */
const MAX_WAIT_MS = 17 * 60_000;
const TOKEN_PATTERN = /^rp_[A-Za-z0-9_-]{43}$/;
const FAILING = {
    broken: "Not found",
    server_error: "Server error",
    unreachable: "Couldn't be reached",
    soft_404: "Says not found",
    parked_domain: "Parked domain",
};
function see(map, key, place) {
    const seen = map.get(key) ?? { places: [], count: 0 };
    seen.count++;
    if (seen.places.length < MAX_PLACES)
        seen.places.push(place);
    map.set(key, seen);
}
const finding = (url, label, detail, seen) => ({ url, label, detail, places: seen.places, placeCount: seen.count });
const isPage = (path) => /\.html?$/i.test(path);
/** The address with a "/" on the end of its path, so "starts with" means "inside". */
function asRoot(address) {
    const normalized = (0, url_1.normalizeUrl)(/^[a-z][a-z0-9+.-]*:/i.test(address.trim()) ? address : `https://${address.trim()}`);
    if (!normalized.ok)
        return null;
    const url = new URL(normalized.url);
    url.search = "";
    if (!url.pathname.endsWith("/"))
        url.pathname += "/";
    return url.href;
}
function readJson(body) {
    try {
        const value = JSON.parse(body);
        return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
    }
    catch {
        return null;
    }
}
function apiLinks(list) {
    const links = Array.isArray(list.links) ? list.links : [];
    return links.flatMap((entry) => {
        if (typeof entry !== "object" || entry === null)
            return [];
        const link = entry;
        if (typeof link.index !== "number")
            return [];
        return [
            {
                index: link.index,
                state: typeof link.state === "string" ? link.state : "pending",
                status: typeof link.status === "string" ? link.status : null,
                confirmed: typeof link.confirmed === "boolean" ? link.confirmed : null,
                source: typeof link.source === "string" ? link.source : null,
                newBreak: link.newBreak === true,
                httpStatus: typeof link.httpStatus === "number" ? link.httpStatus : null,
            },
        ];
    });
}
/** What Rotproof said when it refused, in its own words, or a plain fallback. */
function refusal(response) {
    const error = readJson(response.body)?.error;
    const message = typeof error === "object" && error !== null ? error.message : null;
    return typeof message === "string" && message !== "" ? message.slice(0, 300) : `Rotproof answered ${response.status}.`;
}
/** The live site's pages, as many answers as it takes. Null, with a note, if Rotproof can't say. */
async function readLivePages(io, headers, siteId) {
    const pages = [];
    let readAt = null;
    let after = null;
    do {
        const query = after === null ? "" : `?after=${encodeURIComponent(after)}`;
        const response = await io.request("GET", `${exports.API_ORIGIN}/v1/sites/${encodeURIComponent(siteId)}/pages${query}`, headers);
        const body = response.status === 200 ? readJson(response.body) : null;
        if (body === null || !Array.isArray(body.pages)) {
            return { live: null, notes: [`Rotproof couldn't list your live site's pages, so pages missing from this build weren't looked for. ${response.status === 200 ? "Its answer couldn't be read." : refusal(response)}`] };
        }
        readAt = typeof body.readAt === "number" ? body.readAt : null;
        for (const entry of body.pages) {
            const row = entry;
            if (typeof row === "object" && row !== null && typeof row.url === "string" && /^https?:\/\//i.test(row.url))
                pages.push({ url: row.url, title: typeof row.title === "string" ? row.title : null });
        }
        after = typeof body.next === "string" && body.next !== "" ? body.next : null;
    } while (after !== null && pages.length < exports.MAX_LIVE_PAGES);
    const notes = after === null ? [] : [`Rotproof found more than ${exports.MAX_LIVE_PAGES.toLocaleString("en-US")} pages on your live site. The first ${exports.MAX_LIVE_PAGES.toLocaleString("en-US")} were compared with this build.`];
    if (readAt === null)
        notes.push("Rotproof hasn't finished a check of your live site yet, so pages missing from this build weren't looked for.");
    return { live: { pages: pages.slice(0, exports.MAX_LIVE_PAGES), readAt }, notes };
}
/**
 * Finds the site, reads its live pages, then sends the addresses a list at a time and waits for
 * each. Never throws: whatever goes wrong is a note, and the answers already in hand are kept.
 */
async function askRotproof(io, token, root, urls) {
    const asked = { setup: null, notes: [], byUrl: new Map(), live: null };
    const headers = { Authorization: `Bearer ${token}`, "User-Agent": "rotproof-check-links" };
    const stopped = (note) => ({ ...asked, notes: [...asked.notes, asked.byUrl.size === 0 ? `${note} Links to other sites weren't checked.` : `${note} Some links to other sites weren't checked.`] });
    try {
        const sites = await io.request("GET", `${exports.API_ORIGIN}/v1/sites`, headers);
        if (sites.status === 401)
            return { ...asked, setup: "Rotproof didn't accept the token. Create a new one at rotproof.dev/account/tokens and save it as the repository's secret." };
        if (sites.status !== 200)
            return stopped(`Rotproof couldn't be asked. ${refusal(sites)}`);
        const list = readJson(sites.body)?.sites;
        const site = (Array.isArray(list) ? list : [])
            .filter((entry) => {
            const row = entry;
            return typeof row === "object" && row !== null && typeof row.id === "string" && typeof row.url === "string";
        })
            .find((entry) => asRoot(entry.url) === root);
        if (site === undefined)
            return { ...asked, setup: "This token's organization has no site with that address in Rotproof. Check the `site` setting against the address on rotproof.dev/sites." };
        if (site.verified !== true)
            return { ...asked, setup: "That site isn't verified in Rotproof yet. Verify it at rotproof.dev/sites, then run this again." };
        // The live pages first: one or a few quick answers, and nothing to wait for.
        const live = await readLivePages(io, headers, site.id);
        asked.live = live.live;
        asked.notes.push(...live.notes);
        const base = `${exports.API_ORIGIN}/v1/sites/${encodeURIComponent(site.id)}/link-checks`;
        const deadline = io.now() + MAX_WAIT_MS;
        for (let start = 0; start < urls.length; start += exports.MAX_LIST) {
            const chunk = urls.slice(start, start + exports.MAX_LIST);
            let response = await io.request("POST", base, { ...headers, "Content-Type": "application/json" }, JSON.stringify({ urls: chunk }));
            if (response.status !== 200 && response.status !== 202)
                return stopped(`Rotproof didn't take the list. ${refusal(response)}`);
            let waited = 0;
            for (;;) {
                const body = readJson(response.body);
                if (body === null || typeof body.id !== "string")
                    return stopped("Rotproof's answer couldn't be read.");
                const late = io.now() >= deadline;
                if (body.state === "finished" || late) {
                    for (const link of apiLinks(body)) {
                        const url = chunk[link.index];
                        if (url !== undefined)
                            asked.byUrl.set(url, link);
                    }
                    if (late && body.state !== "finished")
                        return stopped("Rotproof was still checking when this run stopped waiting.");
                    break;
                }
                // A second check comes about a minute after a first failure, so asking faster gains nothing.
                const pause = waited < 30_000 ? 3_000 : 10_000;
                await io.sleep(pause);
                waited += pause;
                const next = await io.request("GET", `${base}/${encodeURIComponent(body.id)}`, headers);
                if (next.status !== 200)
                    return stopped(`Rotproof stopped answering. ${refusal(next)}`);
                response = next;
            }
        }
        return asked;
    }
    catch {
        return stopped("Rotproof couldn't be reached.");
    }
}
const label = (link) => {
    const words = FAILING[link.status ?? ""] ?? "Broken";
    return link.httpStatus !== null && (link.status === "broken" || link.status === "server_error") ? `${words} (${link.httpStatus})` : words;
};
async function run(inputs, io) {
    const failOn = inputs.failOn === "new" || inputs.failOn === "all" ? inputs.failOn : "none";
    const outcome = {
        setupError: null,
        failed: false,
        failOn,
        newBreaks: [],
        inBuild: [],
        already: [],
        unchecked: 0,
        missing: [],
        missingFolders: [],
        liveReadAt: null,
        redirects: null,
        notes: [],
        pages: 0,
        links: 0,
    };
    const stop = (error) => ({ ...outcome, setupError: error, failed: true });
    if (inputs.failOn !== "" && inputs.failOn !== failOn)
        return stop('`fail-on` must be "none", "new" or "all".');
    const root = asRoot(inputs.site);
    if (root === null)
        return stop("`site` must be the site's address, such as https://docs.example.com.");
    const token = inputs.token.trim();
    if (token !== "" && !TOKEN_PATTERN.test(token))
        return stop("`token` isn't a Rotproof API token. They start with rp_. Pass it from a repository secret.");
    const all = io.files();
    const files = new Set(all);
    const pagePaths = all.filter(isPage).sort();
    if (pagePaths.length === 0)
        return stop("There are no HTML pages in `path`. Point it at the folder your build writes the finished site to, and run this after the build.");
    if (pagePaths.length > exports.MAX_PAGES)
        outcome.notes.push(`This build has ${pagePaths.length} pages. The first ${exports.MAX_PAGES} were read.`);
    // First every page, so a link's target can be looked up whichever page it's on.
    const pages = new Map();
    for (const file of pagePaths.slice(0, exports.MAX_PAGES)) {
        const html = io.read(file);
        if (html !== null)
            pages.set(file, (0, html_scan_1.scanPage)(html, (0, paths_1.pageUrl)(root, file)));
    }
    outcome.pages = pages.size;
    if (pages.size < Math.min(pagePaths.length, exports.MAX_PAGES))
        outcome.notes.push("Some pages were too big to read (over 5 MB) and were left out.");
    if ([...pages.values()].some((page) => page.linksTruncated))
        outcome.notes.push("A page has more than 5,000 links. Only its first 5,000 were read.");
    const notInBuild = new Map();
    const sectionMissing = new Map();
    const elsewhere = new Map();
    for (const [file, page] of pages) {
        for (const link of page.links) {
            outcome.links++;
            const place = { file, line: link.line };
            if (!link.url.startsWith(root) && `${link.url}/` !== root) {
                see(elsewhere, link.url, place);
                continue;
            }
            const target = (0, paths_1.builtFile)(root, link.url, files);
            if (target === null) {
                see(notInBuild, link.url, place);
                continue;
            }
            const targetPage = pages.get(target);
            if (link.fragment !== null && targetPage !== undefined && (0, links_1.fragmentTargetState)(link.fragment, targetPage.anchors, targetPage.anchorsComplete) === "missing") {
                see(sectionMissing, `${link.url}#${link.fragment}`, place);
            }
        }
    }
    // Pages missing from the build go first: whether the live site has them decides what they are.
    const wanted = [...notInBuild.keys(), ...elsewhere.keys()];
    const urls = wanted.slice(0, exports.MAX_LIST * exports.MAX_LISTS);
    let answers = new Map();
    let live = null;
    if (token === "") {
        outcome.notes.push("No token was given, so only links to the site's own pages were checked. This is expected on a pull request from a fork.");
    }
    else {
        if (wanted.length > urls.length)
            outcome.notes.push(`This build links to ${wanted.length} addresses that need checking. Rotproof checks ${urls.length} in one run, so the rest weren't checked.`);
        const asked = await askRotproof(io, token, root, urls);
        if (asked.setup !== null)
            return stop(asked.setup);
        outcome.notes.push(...asked.notes);
        answers = asked.byUrl;
        live = asked.live;
    }
    if (live !== null && live.readAt !== null) {
        const linksTo = new Map();
        for (const [url, seen] of notInBuild)
            linksTo.set((0, moved_1.pageKey)(url), (linksTo.get((0, moved_1.pageKey)(url)) ?? 0) + seen.count);
        const redirectsFile = files.has("_redirects") ? io.read("_redirects") : null;
        const missing = (0, moved_1.findMissing)({
            root,
            live: live.pages,
            files,
            built: [...pages].map(([file, page]) => ({ file, url: (0, paths_1.pageUrl)(root, file), title: page.title })),
            rules: redirectsFile === null ? [] : (0, moved_1.readRedirectRules)(redirectsFile, new URL(root).host),
            linksTo,
        });
        outcome.liveReadAt = live.readAt;
        outcome.missing = missing.pages;
        outcome.missingFolders = missing.folders;
        const home = (0, paths_1.builtFile)(root, root, files);
        outcome.redirects = (0, moved_1.redirectHelp)((0, moved_1.redirectTool)(files, home === null ? null : (0, moved_1.generatorOf)(io.read(home) ?? "")), root, missing.pages);
        if (missing.mostlyMissing !== null) {
            const { missing: count, live: total } = missing.mostlyMissing;
            outcome.notes.push(`${count} of the ${total} pages Rotproof found on your live site aren't in this build, so they weren't listed one by one. Check that \`path\` is the folder with the whole finished site.`);
        }
    }
    for (const [url, seen] of notInBuild) {
        const answer = answers.get(url);
        const failing = answer !== undefined && answer.state === "checked" && answer.status !== null && answer.status in FAILING;
        if (answer?.newBreak === true)
            outcome.newBreaks.push(finding(url, label(answer), "This page isn't in the build, and the live site doesn't have it either.", seen));
        else if (failing && answer.source === "site")
            outcome.already.push(finding(url, label(answer), "Not in the build, and already broken on the live site.", seen));
        else if (answer !== undefined && answer.state === "checked" && (answer.status === "ok" || answer.status === "redirect_chain"))
            outcome.inBuild.push(finding(url, "Not in this build", "It works on the live site today. If this change removes the page, the link breaks once it's published.", seen));
        else
            outcome.inBuild.push(finding(url, "Not in this build", "No file in the build answers this address.", seen));
    }
    for (const [url, seen] of sectionMissing)
        outcome.inBuild.push(finding(url, "Section missing", "The page is in the build, but nothing on it has this name.", seen));
    // Without a token nobody was asked, and a note says so. They aren't "couldn't be checked".
    for (const [url, seen] of token === "" ? [] : elsewhere) {
        const answer = answers.get(url);
        if (answer === undefined || answer.state !== "checked" || answer.status === null)
            outcome.unchecked++;
        else if (answer.newBreak)
            outcome.newBreaks.push(finding(url, label(answer), "Checked twice, about a minute apart.", seen));
        else if (answer.status in FAILING && answer.source === "site" && answer.confirmed !== false)
            outcome.already.push(finding(url, label(answer), "Already broken on the live site before this change.", seen));
        else if (answer.status in FAILING || answer.status === "blocked")
            outcome.unchecked++;
    }
    outcome.failed = (failOn === "new" && outcome.newBreaks.length > 0) || (failOn === "all" && outcome.newBreaks.length + outcome.inBuild.length > 0);
    return outcome;
}
