# Store Listings

## GitHub About
Select a DOM element in Firefox or Chrome and reveal its CSS/SCSS source directly in VS Code.

## Firefox AMO
Pin-op connects one Firefox window to one local VS Code window through an
explicit seven-digit code. Select an element on the page or in the lazy DOM
tree, then see the related CSS or source-mapped SCSS ranges highlighted in the
active IDE file. The DevTools Source pane also shows bounded excerpts that open
the exact current range in VS Code.

Pin-op distinguishes rules for the selected element from rules for its
immediate parent. Auto Refresh updates eligible styles without reloading the
page and reloads the current tab with scroll restoration after changed script,
Vue, PHP, or HTML saves.

The connection uses a loopback-only WebSocket and explicit browser-window
linking. Pin-op is read-only: it does not edit source, execute IDE commands, or
send product data to a remote Pin-op service. Firefox 142 or newer and the
matching Pin-op VS Code extension are required.

Pin-op by Volodymyr Moskvin (c) 2026 [Conus Vision](https://conus.vision)

## Chrome Web Store
Pin-op connects one Chrome or Chromium window to one local VS Code window
through an explicit seven-digit code. Select an element on the page or in the
lazy DOM tree, then see the related CSS or source-mapped SCSS ranges highlighted
in the active IDE file. The DevTools Source pane also shows bounded excerpts
that open the exact current range in VS Code.

Pin-op distinguishes rules for the selected element from rules for its
immediate parent. Auto Refresh updates eligible styles without reloading the
page and reloads the current tab with scroll restoration after changed script,
Vue, PHP, or HTML saves.

The connection uses a loopback-only WebSocket and explicit browser-window
linking. Pin-op is read-only: it does not edit source, execute IDE commands, or
send product data to a remote Pin-op service. Chrome/Chromium 116 or newer and
the matching Pin-op VS Code extension are required.

Pin-op by Volodymyr Moskvin (c) 2026 [Conus Vision](https://conus.vision)
