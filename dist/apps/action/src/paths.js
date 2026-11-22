"use strict";
/**
 * Where a build's files are served on the site, the way static hosts serve them. Shared by the
 * link check (./run.ts) and the pages a change removes (./moved.ts).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.pageUrl = pageUrl;
exports.builtFile = builtFile;
/** A page's address on the site: the root, the file's path, and no index.html on the end. */
function pageUrl(root, file) {
    const parts = file.split("/");
    const last = parts[parts.length - 1] ?? "";
    if (/^index\.html?$/i.test(last))
        parts[parts.length - 1] = "";
    return root + parts.map(encodeURIComponent).join("/");
}
/**
 * The file a link to the site's own pages would be served from, or null when the build has
 * none. Tries what static hosts try: the path itself, with .html, and as a folder's index.
 */
function builtFile(root, url, files) {
    const rootPath = new URL(root).pathname;
    let path = new URL(url).pathname;
    if (`${path}/` === rootPath)
        path = rootPath;
    let relative;
    try {
        relative = path.slice(rootPath.length).split("/").map(decodeURIComponent).join("/");
    }
    catch {
        return null;
    }
    const candidates = relative === "" || relative.endsWith("/") ? [`${relative}index.html`, `${relative}index.htm`] : [relative, `${relative}.html`, `${relative}/index.html`, `${relative}.htm`];
    return candidates.find((candidate) => files.has(candidate)) ?? null;
}
