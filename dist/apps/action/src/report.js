"use strict";
/**
 * What the check says: the job summary GitHub shows on the run, and the lines it prints.
 *
 * Addresses and file names come from the pages being checked, so they're hostile here as
 * everywhere (CLAUDE.md). The summary is HTML with every value escaped, and has no blank
 * lines, so nothing in it is read as Markdown. Printed lines have their control characters
 * removed and their workflow-command characters escaped, so a file name can't issue a command
 * to the runner.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.missingCount = void 0;
exports.day = day;
exports.headline = headline;
exports.renderSummary = renderSummary;
exports.logLines = logLines;
/** Findings listed in full in the summary, per section. The counts are always complete. */
const MAX_LISTED = 50;
/** GitHub shows 10 annotations of each level per step. */
const MAX_ANNOTATIONS = 10;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** "18 November 2026", in UTC, the same on every runner whatever its locale. */
function day(ms) {
    const date = new Date(ms);
    return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()] ?? ""} ${date.getUTCFullYear()}`;
}
/** Live pages the build lacks: each page, and each whole folder's pages. */
const missingCount = (outcome) => outcome.missing.length + outcome.missingFolders.reduce((sum, folder) => sum + folder.pages, 0);
exports.missingCount = missingCount;
/** One line of plain text: no control characters, so nothing can start a new line. */
const oneLine = (text) => text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ");
/** A value in the summary: on one line, so it can't open a blank line and let Markdown in. */
const escapeHtml = (text) => oneLine(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
/** The data part of a workflow command. */
const commandData = (text) => oneLine(text).replace(/%/g, "%25");
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
function where(finding) {
    const shown = finding.places.map((place) => `${place.file}:${place.line}`).join(", ");
    const more = finding.placeCount - finding.places.length;
    return more > 0 ? `${shown} and ${plural(more, "more place", "more places")}` : shown;
}
function section(title, lead, findings) {
    if (findings.length === 0)
        return "";
    const rows = findings
        .slice(0, MAX_LISTED)
        .map((finding) => `<tr><td><code>${escapeHtml(finding.url)}</code><br>${escapeHtml(finding.detail)}</td><td>${escapeHtml(finding.label)}</td><td><code>${escapeHtml(where(finding))}</code></td></tr>`)
        .join("\n");
    const more = findings.length > MAX_LISTED ? `\n<p>And ${findings.length - MAX_LISTED} more.</p>` : "";
    return `<h3>${escapeHtml(title)}</h3>\n<p>${escapeHtml(lead)}</p>\n<table>\n<tr><th>Link</th><th>What's wrong</th><th>Where, in the build</th></tr>\n${rows}\n</table>${more}\n`;
}
function headline(outcome) {
    if (outcome.setupError !== null)
        return "Rotproof couldn't run the link check";
    const parts = [];
    if (outcome.newBreaks.length > 0)
        parts.push(plural(outcome.newBreaks.length, "new broken link", "new broken links"));
    if (outcome.inBuild.length > 0)
        parts.push(`${plural(outcome.inBuild.length, "link", "links")} broken inside the build`);
    const missing = (0, exports.missingCount)(outcome);
    if (missing > 0)
        parts.push(`${plural(missing, "live page", "live pages")} missing from this build`);
    return parts.length === 0 ? "Rotproof: no new broken links" : `Rotproof: ${parts.join(", ")}`;
}
const pathOf = (url) => {
    const parsed = new URL(url);
    return parsed.pathname + parsed.search;
};
function missingRow(page) {
    const title = page.title === null || page.title === "" ? "" : `<br>${escapeHtml(page.title)}`;
    const moved = page.movedTo === null ? "No clear match. Redirect it to the page that replaced it." : `<code>${escapeHtml(pathOf(page.movedTo))}</code>`;
    const links = page.linksInBuild === 0 ? "None" : `${page.linksInBuild}, listed above`;
    return `<tr><td><code>${escapeHtml(pathOf(page.url))}</code>${title}</td><td>${moved}</td><td>${links}</td></tr>`;
}
const folderRow = (folder) => `<tr><td><code>${escapeHtml(pathOf(folder.url))}</code> and everything in it</td><td>${plural(folder.pages, "live page", "live pages")}, none of them in this build. If another build publishes them, this can be ignored.</td><td></td></tr>`;
/** Pages on the live site the build has nothing at, and the redirects to add for them. */
function missingSection(outcome) {
    if (outcome.missing.length + outcome.missingFolders.length === 0)
        return "";
    const read = outcome.liveReadAt === null ? "Rotproof's latest check of your live site" : `Rotproof's check of your live site on ${day(outcome.liveReadAt)}`;
    const rows = [...outcome.missingFolders.map(folderRow), ...outcome.missing.slice(0, MAX_LISTED).map(missingRow)].join("\n");
    const more = outcome.missing.length > MAX_LISTED ? `\n<p>And ${outcome.missing.length - MAX_LISTED} more.</p>` : "";
    const help = outcome.redirects !== null
        ? `<p>${escapeHtml(outcome.redirects.where)}</p>\n<pre><code>${outcome.redirects.text
            .split("\n")
            .filter((line) => line.trim() !== "")
            .map(escapeHtml)
            .join("\n")}</code></pre>\n`
        : outcome.missing.length > 0
            ? `<p>How to add a redirect in your documentation tool: <a href="https://rotproof.dev/build-check#redirects">rotproof.dev/build-check</a>.</p>\n`
            : "";
    return (`<h3>Live pages missing from this build</h3>\n` +
        `<p>${read} found these pages. This build has nothing at their addresses and no redirect for them, so once it's published, links to them from other sites, search results and bookmarks stop working. Redirect each to the page that replaced it. If your host redirects them in its own settings, or one was removed since that check, this can be ignored.</p>\n` +
        `<table>\n<tr><th>Live page</th><th>Probably moved to</th><th>Links to it in this build</th></tr>\n${rows}\n</table>${more}\n` +
        help);
}
/** The job summary. HTML throughout, with no blank lines. */
function renderSummary(outcome) {
    if (outcome.setupError !== null)
        return `<h2>${escapeHtml(headline(outcome))}</h2>\n<p>${escapeHtml(outcome.setupError)}</p>\n`;
    const facts = `Read ${plural(outcome.pages, "page", "pages")} and ${plural(outcome.links, "link", "links")}.`;
    const unchecked = outcome.unchecked === 0 ? "" : `<p>${plural(outcome.unchecked, "link", "links")} to other sites couldn't be checked. That's never counted as broken: some sites turn away automated checks.</p>\n`;
    const notes = outcome.notes.map((note) => `<p>${escapeHtml(note)}</p>\n`).join("");
    return (`<h2>${escapeHtml(headline(outcome))}</h2>\n<p>${facts}</p>\n` +
        section("Broken links this change adds", "Rotproof checked each of these twice. They aren't on your live site today.", outcome.newBreaks) +
        section("Broken inside the build", "Links to your own pages that the finished site can't answer.", outcome.inBuild) +
        missingSection(outcome) +
        section("Already broken on your site", "These were broken before this change, so they never fail this check.", outcome.already) +
        unchecked +
        notes);
}
/** Lines for the log, as workflow commands: errors when the check fails on them, else warnings. */
function logLines(outcome) {
    if (outcome.setupError !== null)
        return [`::error title=Rotproof::${commandData(outcome.setupError)}`];
    const lines = [];
    const annotate = (findings, failing) => {
        for (const finding of findings.slice(0, MAX_ANNOTATIONS)) {
            lines.push(`::${failing ? "error" : "warning"} title=${commandData(finding.label).replace(/:/g, "%3A").replace(/,/g, "%2C")}::${commandData(`${finding.url} in ${where(finding)}. ${finding.detail}`)}`);
        }
    };
    annotate(outcome.newBreaks, outcome.failOn !== "none");
    annotate(outcome.inBuild, outcome.failOn === "all");
    // Never errors: a host can redirect in settings the build doesn't hold.
    for (const folder of outcome.missingFolders.slice(0, MAX_ANNOTATIONS)) {
        lines.push(`::warning title=Pages missing from this build::${commandData(`None of the ${folder.pages} live pages under ${folder.url} are in this build.`)}`);
    }
    for (const page of outcome.missing.slice(0, MAX_ANNOTATIONS)) {
        const where = page.movedTo === null ? "Redirect it to the page that replaced it." : `It probably moved to ${page.movedTo}: redirect it there.`;
        lines.push(`::warning title=Page missing from this build::${commandData(`${page.url} is on the live site, but not in this build. ${where}`)}`);
    }
    for (const note of outcome.notes)
        lines.push(`::notice title=Rotproof::${commandData(note)}`);
    lines.push(commandData(headline(outcome)));
    return lines;
}
