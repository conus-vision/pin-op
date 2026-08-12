# PinOp Brand Design

**Date:** 2026-08-12
**Status:** Approved brand foundation

## Summary

Browser2IDE will adopt **PinOp** as its public product name. The canonical
spelling is `PinOp`, pronounced "pin-op". The name is derived from **Plug IN &
OPerate**, expressing a product that connects to a developer's existing tools
and becomes immediately useful without binding the brand to one browser, IDE,
or source language.

The canonical product address will be:

```text
pinop.conus.vision
```

Until a dedicated slogan is approved, public material will use this descriptive
line:

> Connect browser DevTools to your source code.

## Problem

`Browser2IDE` names the two endpoints but does not explain the product's value:
selecting an inspected DOM element and locating the related CSS or SCSS source
inside the developer's editor. It is also tied linguistically to an IDE even
though the product can later support a wider range of editors.

`PinPop` was considered as a more memorable alternative. It was rejected
because active software products already use that exact name and control
several key domains. Its playful sound also communicates less precision than a
professional developer tool requires.

## Brand Decision

| Element | Decision |
| --- | --- |
| Product name | PinOp |
| Canonical casing | `PinOp` |
| Pronunciation | pin-op |
| Name meaning | Plug IN & OPerate |
| Product address | `pinop.conus.vision` |
| Source repository | `github.com/conus-vision/PinOp` |
| Temporary descriptor | Connect browser DevTools to your source code. |

The expansion **Plug IN & OPerate** is the origin and philosophy of the name,
not the public slogan. Public messaging should lead with the user benefit;
the expansion may appear on an About page, launch post, or brand story.

## Positioning

PinOp is a precise, local developer tool that connects browser inspection to
source-code context. The brand should communicate:

- immediate operation after explicit local linking;
- precise movement from a selected page element to relevant source ranges;
- compatibility with the developer's existing browser and editor workflow;
- a path to multiple IDEs and source-language plugins;
- read-only, local behavior unless a future feature is explicitly designed and
  documented otherwise.

The brand must not imply that PinOp currently edits files, operates a remote
service, supports every IDE, or provides strong authentication through its
two-digit link PIN.

## Public Presentation

The product name appears as **PinOp** in headings, extension display names,
browser panels, status UI, release titles, and prose. Lowercase `pinop` is used
only where required by URLs, package names, commands, configuration keys, or
other technical identifier conventions.

The initial public presentation is:

```text
PinOp
Connect browser DevTools to your source code.
```

PinOp launches as the sole public product name. Browser2IDE was neither
advertised nor publicly released, so public surfaces will not use a transitional
`formerly Browser2IDE` label. The existing GitHub repository has been renamed to
`conus-vision/PinOp`; product metadata and documentation will point directly to
that canonical location.

No compatibility aliases, identifier migrations, or legacy artifact names are
required. Code, package, extension, protocol, configuration, and release
identifiers may be renamed together before the first public release. The rollout
must still update all coupled producers, consumers, tests, and documentation in
one verified change so mixed identities cannot ship.

## Slogan Requirements

The permanent slogan will be selected separately. It must:

- explain the movement from browser inspection to source code;
- remain accurate for both CSS and SCSS resolution;
- avoid promising source editing or automatic file switching;
- be understandable without knowing the `Plug IN & OPerate` expansion;
- remain suitable when additional IDEs are supported;
- preferably fit in three to eight English words.

The temporary descriptor remains in use until a slogan meeting these
requirements is approved.

## Availability Findings

A technical availability check on 2026-08-12 found no exact active software
utility, mobile application, VS Code extension, Open VSX extension, Firefox
add-on, or JetBrains plugin named PinOp. The unscoped `pinop` package name was
not present in npm, PyPI, crates.io, or RubyGems at the time of the check.

`pinop.com` is registered and serves an old personal page. The `.app`, `.io`,
`.dev`, and `.org` names returned no RDAP registration, but they are not needed
for the approved address. The GitHub account `pinop` is already occupied.

`PINOP` is also an Australian legal abbreviation for "person in need of
protection." This is not a competing software product, but it may affect generic
search results in Australia. A separate legal trademark clearance has not been
performed and is required before treating technical availability as legal
clearance.

## Scope

This design establishes the product name, meaning, casing, address,
repository, clean pre-launch rename policy, and requirements for the future
slogan. It does not authorize or specify:

- code, package, extension, repository, or publisher identifier changes;
- domain or DNS configuration;
- a logo, icon, color system, or other visual identity;
- a final slogan;
- implementation of support for additional IDEs;
- store submissions or release publication.

Those changes require a separate implementation plan after this design is
reviewed.

## Verification Criteria

The brand rollout will be considered internally consistent when:

1. user-facing product references use `PinOp` with the approved casing;
2. technical identifiers use lowercase `pinop` only where convention requires;
3. the canonical product link is `pinop.conus.vision`;
4. source and issue links use `github.com/conus-vision/PinOp`;
5. the temporary descriptor accurately describes the read-only browser-to-source
   workflow;
6. public product surfaces contain no Browser2IDE compatibility branding;
7. no public message expands current capabilities beyond documented support;
8. a final slogan is adopted only after it satisfies the requirements above.
