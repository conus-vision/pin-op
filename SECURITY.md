# Security Policy

## Supported Versions

| Version | Status |
| --- | --- |
| 0.3.x | Supported when the `0.3.0` release is published. |
| Earlier versions | Unsupported. |

No public `0.3.0` release is claimed yet. Until publication, identify the exact
reviewed source commit when reporting or reproducing an issue.

## Report A Vulnerability

Report vulnerabilities privately through
[GitHub private vulnerability reporting](https://github.com/conus-vision/pin-op/security/advisories/new).
Include the affected product version, protocol version, browser and VS Code
versions, reproduction steps, impact, and any suggested mitigation.

Do not open a public issue, discussion, or pull request for an unpatched
vulnerability. Coordinate public disclosure after a fix or mitigation exists.

## Security Model

Pin-op is a local, read-only source tool. Product traffic is an authenticated
loopback WebSocket; there is no product HTTP service. Linking is an explicit
browser-window action. The two-digit PIN provides accidental-cross-link
protection, not strong authentication against another process running as the
same desktop user.

Browser credentials and the displayed code use session storage. Pin-op
sends bounded facts and bounded active-document source excerpts but does not
send full source documents, workspace paths, or source URIs. It does not upload
source, write files, edit page-owned DOM, or execute arbitrary commands. Auto
Refresh is limited to replacing eligible stylesheet links or reloading the
current participating tab. The DOM tree stays browser-local; cross-origin
frames and closed shadow roots fail closed. Reports involving link/session
handling, protocol-version mismatch, extension origins, inspected-page
injection, node-ref boundaries, message validation, source plugins, refresh,
or sensitive inspection values are in scope.

See the detailed [security model](docs/security.md) and
[privacy policy](PRIVACY.md).
