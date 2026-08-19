# Link Onboarding And Listings Design

## Goal

Make the first Pin-op DevTools screen explain one action clearly: link the
current browser window to the intended VS Code window. After a successful link,
preserve the existing Inspector workflow. Rework the public English copy so the
GitHub repository and extension listings explain the problem, visible result,
quick start, audience, and next action before implementation details.

## DevTools Onboarding

The panel has two explicit presentation modes derived from the existing link
view model. This is presentation state only; the connection protocol and
browser-window ownership model do not change.

### Link Mode

Link mode is active whenever the existing link form is the usable connection
control, including initial `notLinked`, link-validation errors, and rate-limit
recovery.

- The toolbar aligns the connection form to the left.
- The page picker, Auto Refresh, and IDE Highlight controls are hidden.
- The connection form keeps this order: status, code input, paste button, Link
  button.
- Link uses the panel's primary blue action styling.
- Link remains enabled while idle, including when the input is empty. Submitting
  an empty or malformed value uses the existing bounded validation error.
- Link is disabled only while a link operation is busy.
- DOM, Source, selection status, and source-navigation controls are hidden.
- A dedicated onboarding view occupies the workspace.
- The existing compact product branding remains at the bottom.
- Connection and validation errors remain visible without exposing private
  bridge details.

The onboarding copy is:

> **Connect Pin-op to VS Code**
>
> Open your project in VS Code and click the Pin-op status item to copy its
> seven-digit link code. Paste it above and choose Link.
>
> After linking, select a DOM element in the tree or on the page. Pin-op reveals
> the related ranges in the active IDE file.

### Linked Mode

Linked mode begins as soon as the browser window retains explicit link intent,
including linking, connected, reconnecting, IDE-offline, protocol-mismatch, and
recoverable disconnect states.

- The current left-side page picker, Auto Refresh, and IDE Highlight controls
  are visible.
- The current status, visible grouped link code, and Disconnect button remain on
  the right.
- The existing DOM, Source, footer status, source navigation, compatibility
  warning, and responsive split/stack/tab behavior remain unchanged.
- Disconnect returns the panel to link mode only after the existing unlink state
  transition succeeds. Existing rollback behavior remains authoritative.

## Accessibility And Layout

- Visibility is set by the panel view from the authoritative view model, rather
  than inferred with CSS selectors such as `:has()`.
- Hidden controls are removed from keyboard navigation with the native `hidden`
  property.
- The onboarding heading and copy use normal document flow and remain readable
  in wide/low, narrow/high, and narrow/low DevTools docks.
- The toolbar remains horizontally scrollable at its existing minimum width.
- The primary Link button retains visible hover, focus, busy, and disabled
  states with accessible contrast in light and dark browser themes.

## GitHub README

The root README remains English and follows a problem-to-action narrative:

1. A one-sentence hero states the developer problem and Pin-op's visible result.
2. A short problem paragraph explains the browser-to-source context gap.
3. A compact Mermaid diagram shows Browser DevTools, the loopback WebSocket,
   and the linked IDE window.
4. A terminal-free quick start leads to the first visible highlight and Source
   excerpt.
5. Two or three concrete use cases identify the intended audience.
6. Inspector capabilities, compatibility, privacy, and architecture provide
   evaluation detail after the quick start.
7. Contributor commands remain available below product usage.
8. The README ends with clear documentation, issue, and star calls to action,
   followed by the author attribution.

The README must not claim a signed Firefox XPI or public release before those
artifacts exist. Candidate and release status stay explicit.

## Extension Listings

- `extensions/vscode/README.md` becomes the VS Code Marketplace long
  description and follows the same concise problem, result, quick-start, safety,
  and compatibility order.
- A tracked store-listing document contains ready-to-publish long descriptions
  for Firefox AMO and Chrome Web Store, plus the recommended GitHub About line.
- Firefox and Chrome long descriptions use equivalent product claims and do not
  imply editing, command execution, remote transport, or unsupported source
  types.
- Root package, VS Code manifest, Firefox manifest, and Chrome manifest use this
  127-character canonical plain-text description:

  `Highlights styles and source code in your IDE for the selected DOM element. Pin-op by Volodymyr Moskvin. (c) 2026 Conus Vision.`
- Long Markdown descriptions end with this exact line:

  `Pin-op by Volodymyr Moskvin (c) 2026 [Conus Vision](https://conus.vision)`

- Plain-text metadata uses the same attribution without Markdown syntax while
  respecting platform length limits.

## Testing

- Panel-controller tests prove Link is enabled for empty idle input and disabled
  only while busy.
- Panel-runtime/view tests prove link mode hides feature controls and operational
  panes, shows onboarding, aligns the form mode, and restores the current linked
  UI.
- Asset tests prove the onboarding copy, primary button styling, and unique
  controls are packaged for both browsers.
- Identity and packaging tests enforce the canonical short description, length
  limit, and required attribution in long descriptions.
- Existing protocol, linking rollback, Inspector, responsive layout, package,
  and smoke tests remain green.

## Non-Goals

- No automatic browser-to-IDE association.
- No changes to the seven-digit code, bridge protocol, or explicit window
  ownership.
- No source editing, browser-side CSS editing, command execution, or reverse
  sync.
- No new analytics, remote service, or HTTP product transport.
