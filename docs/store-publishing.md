# Publishing An Update To The Stores

This guide takes a built release to its three store listings. It assumes the
draft release for the version exists (see the [release guide](release.md)), its
`SHA256SUMS` checks out, and the packages passed
[installed verification](installed-verification.md). Every file named below is
an asset of that draft.

| Store | Upload | Review | Users receive it |
| --- | --- | --- | --- |
| Visual Studio Marketplace | `pin-op-vscode-X.Y.Z.vsix` | Automated scan, minutes | VS Code updates installed copies automatically |
| Chrome Web Store | `pin-op-chrome-X.Y.Z.zip` | Human review, usually one to three days | Chrome updates within hours of publication |
| Firefox Add-ons | `pin-op-firefox-X.Y.Z.zip` plus `pin-op-firefox-source-X.Y.Z.zip` | Automated validation and signing, then possible human review | Firefox updates within a day |

Submit all three the same day. The halves link whenever they speak the same
protocol version, but a feature that crosses the bridge works only when both
are new: in `0.5.0`, a declaration click from the new browser extension is
refused by a `0.4.2` VS Code extension. When the protocol version changes, an
old half and a new half do not link at all until both are updated.

Each store refuses a version number it has already seen, and Firefox Add-ons
never frees one, even for a withdrawn submission. A rejected or withdrawn
submission therefore needs the next patch version everywhere.

## Before uploading

1. Download the draft's assets and run `sha256sum --check --strict SHA256SUMS`.
2. Compare the manifests with the previous release. When the permissions,
   host permissions, or content security policy change, each store asks for a
   justification and users see a permission prompt on update; write the
   justification before starting.
3. Prepare release notes from the version's `CHANGELOG.md` entry: two to five
   plain sentences about what a user notices.
4. If a listing describes a feature this version changes, update its text in
   [store listings](store-listings.md) first, so each store receives the same
   wording.

## Visual Studio Marketplace

The upload is live as soon as the Marketplace finishes its scan, so upload it
last or together with the browser stores.

In the browser:

1. Sign in at <https://marketplace.visualstudio.com/manage/publishers/conus-vision>
   with the account that owns the `conus-vision` publisher.
2. On the Pin-op row, open the **...** menu and choose **Update**.
3. Upload `pin-op-vscode-X.Y.Z.vsix`. The listing shows **Verifying** for a
   few minutes, then the new version.

From a terminal, with an Azure DevOps personal access token that has the
**Marketplace (Manage)** scope for all accessible organizations:

```bash
npx @vscode/vsce publish --packagePath pin-op-vscode-X.Y.Z.vsix
```

`vsce` asks for the token, or reads it from the `VSCE_PAT` environment variable.
Never commit the token or paste it into an issue.

Check the listing page afterwards: the version number, the README (it is the
extension's `README.md`), and the changelog tab.

## Chrome Web Store

1. Open the developer dashboard at
   <https://chrome.google.com/webstore/devconsole> and select Pin-op.
2. Open **Package** and choose **Upload new package**. Select
   `pin-op-chrome-X.Y.Z.zip`. The dashboard rejects a version that is not
   higher than the published one.
3. Open **Store listing** and update the description if
   [store listings](store-listings.md) changed. Leave the screenshots unless
   the interface they show changed.
4. Open **Privacy practices**. With unchanged permissions nothing needs
   editing; with a new permission, add its justification here.
5. Choose **Submit for review**. In the dialog, clear **Publish automatically
   after review** to keep control of the moment it goes live; after approval,
   the item shows **Publish**, and it has to be published within 30 days.
6. Review usually takes one to three days and can take longer. A rejection
   email names the policy; fix it, raise the patch version, rebuild, and
   submit again.

## Firefox Add-ons

1. Open <https://addons.mozilla.org/developers/addon/pin-op/versions/submit/>,
   or **Manage My Submissions**, Pin-op, **Upload New Version**.
2. Keep the distribution channel **On this site**. This is the listed channel,
   and the only one Pin-op uses: an unlisted upload would spend the version
   number the listing needs.
3. Upload `pin-op-firefox-X.Y.Z.zip`. Wait for the automatic validation;
   warnings about minified or bundled code are expected, errors are not.
4. Answer **Yes** to **Do you need to submit source code?** and upload
   `pin-op-firefox-source-X.Y.Z.zip`. The archive contains
   [the build instructions](firefox-source-submission.md) the reviewer follows
   to reproduce the package byte for byte.
5. Enter the release notes. In **Notes to Reviewer**, name the build
   instructions file and the Node.js and pnpm versions it requires.
6. Choose **Submit Version**. Mozilla signs the version after validation, and
   the listing serves it once it is approved; a human review can follow later
   and can still disable the version.
7. When the version shows as approved under **Manage Status & Versions**,
   download its file, check it, and attach it to the GitHub draft, as
   [Attach The Firefox XPI](release.md#attach-the-firefox-xpi) describes.

## After publication

1. Install each listing in a clean browser profile and a clean VS Code profile,
   link them, and click through one Rules origin. The versions shown in
   `chrome://extensions`, `about:addons`, and the VS Code Extensions view must
   all be `X.Y.Z`.
2. Date the version's `CHANGELOG.md` entry on the day the first store published
   it.
3. Publish the GitHub draft release, with the Firefox `.xpi` attached when
   Mozilla has approved the version.

Pin-op by Volodymyr Moskvin (c) 2026 [Conus Vision](https://conus.vision)
