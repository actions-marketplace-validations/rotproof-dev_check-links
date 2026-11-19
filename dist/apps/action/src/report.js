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
exports.headline = headline;
exports.renderSummary = renderSummary;
exports.logLines = logLines;
/** Findings listed in full in the summary, per section. The counts are always complete. */
const MAX_LISTED = 50;
/** GitHub shows 10 annotations of each level per step. */
const MAX_ANNOTATIONS = 10;
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
    return parts.length === 0 ? "Rotproof: no new broken links" : `Rotproof: ${parts.join(", ")}`;
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
    for (const note of outcome.notes)
        lines.push(`::notice title=Rotproof::${commandData(note)}`);
    lines.push(commandData(headline(outcome)));
    return lines;
}
