# Rotproof link check

Finds broken links in your documentation before the change that adds them is published.

It runs in your build, on the finished site:

- **Links to your own pages are checked against the build.** Does the page exist? Does the section? Nothing is sent anywhere.
- **Links to other websites are checked by [Rotproof](https://rotproof.dev).** It's sent their addresses and nothing else. Your pages never leave your build.
- **Only new breaks count.** A link that's already on your live site keeps the answer it has there. Only what the change adds is checked fresh, so most runs take seconds.

## Set up

The full guide, with what each step is for, is at [rotproof.dev/build-check](https://rotproof.dev/build-check).

1. Add and verify your site at [rotproof.dev](https://rotproof.dev). The free plan is enough.
2. Create a token at **Account → API tokens**, and save it in your repository as a secret named `ROTPROOF_TOKEN` (Settings → Secrets and variables → Actions).
3. Add the step after the one that builds your site:

```yaml
- name: Check links
  uses: rotproof-dev/check-links@v1
  with:
    path: build # the folder your build writes the site to
    site: https://docs.example.com # as it is in Rotproof
    token: ${{ secrets.ROTPROOF_TOKEN }}
```

## Settings

| Setting | What it's for |
| --- | --- |
| `path` | The folder with the finished site: `build`, `site`, `book`, `_site`, `docs/.vitepress/dist`. Required. |
| `site` | The site's address, exactly as it is in Rotproof. Required. |
| `token` | Your Rotproof API token, from a secret. Without it, only links to your own pages are checked. |
| `fail-on` | `none` (the default) reports and never fails. `new` fails when the change adds a broken link. `all` also fails on links broken inside the build. |

Start with `none`. Switch to `new` once the report is one you'd act on.

## What it reports

- **Broken links this change adds.** Rotproof checked each twice, about a minute apart, and it isn't on your live site today.
- **Broken inside the build.** A link to a page that isn't in the build, or to a section that isn't on its page. A page missing from the build may be served by something else, such as a redirect, so this is a failure only with `fail-on: all`.
- **Already broken on your site.** Mentioned, and never a failure: the change didn't add them.
- **Couldn't be checked.** Some sites turn away automated checks. That's never counted as broken.
- **Live pages missing from this build.** Pages Rotproof found on your live site, from its sitemap, that the build has nothing at and no redirect for. Once the change is published, links to them from other sites, search results and bookmarks break. For each, the report suggests where it probably moved, a new page with the same title or the same name, and writes the redirect for you when the build has a `_redirects` file or was made by Docusaurus, Hugo or Jekyll. For other tools, see [how to add a redirect](https://rotproof.dev/build-check#redirects). Needs the token, and never fails the check: your host may redirect in settings the build doesn't contain.

The report is on the run's summary page. A broken link shows as a warning, or as an error when it fails the check.

## Outputs

| Output | What it is |
| --- | --- |
| `new-breaks` | How many broken links the change adds. |
| `in-build` | How many links are broken inside the build itself. |
| `missing-pages` | How many pages on the live site the build has nothing at, and no redirect for. |

## Pull requests from forks

GitHub doesn't give secrets to a pull request from a fork, so there's no token and only links to your own pages are checked. The report says so.

**Don't switch the workflow to `pull_request_target` to get round this.** That runs a stranger's change with your secrets, and they can take the token.

## Limits

- Rotproof checks 500 addresses a list and up to 10 lists a run, inside your plan's daily link checks.
- At most 25 new requests go to any one other website per list.
- If Rotproof can't be reached, the check reports that and doesn't fail your build.
- Missing pages are found from Rotproof's latest check of your live site: weekly on the Free plan, daily on the others. A page removed since then is listed until the next check.

## What Rotproof receives

The addresses of the links in your built site, your token, and the site's address. Rotproof requests those addresses as `RotproofBot`, at one request a second per website, and keeps the results for 7 days. See the [privacy policy](https://rotproof.dev/privacy).

Rotproof sends back the addresses and titles of your live site's pages, and the comparison with your build happens on GitHub's machine. Your build's pages are never sent.

This Action makes requests to `rotproof.dev` and nowhere else.

## Help

Questions and problems: [hello@rotproof.dev](mailto:hello@rotproof.dev). To report a security issue, see [rotproof.dev/security](https://rotproof.dev/security).

## License

MIT, © TRD Ventures LLC. See [LICENSE](LICENSE).
