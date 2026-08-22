# Pinned Chromium DevTools Elements sources

This directory contains a verbatim, auditable reference snapshot of ten
allowlisted Chromium DevTools Elements files plus the upstream root BSD
license. The snapshot is provenance input for small Pin-op-owned derivations;
it is not compiled as production code.

The sole accepted upstream revision is:

```text
a092f2943b68ef9aa7c1d2c2a8b7e71aa4087280
```

## Refresh the pinned snapshot

Run the fixed import command from the repository root:

```powershell
corepack pnpm vendor:chromium-elements
```

The importer rejects any other revision before network access, downloads only
the fixed allowlist from the pinned raw GitHub origin, and writes the snapshot
only after every download and hash succeeds. Review the resulting upstream
bytes, notice inventory, hashes, and import date before committing.

## Record intentional local derivations

After creating or intentionally patching a target listed in `UPSTREAM.json`,
refresh only its local digest fields:

```powershell
corepack pnpm vendor:chromium-elements:record-derived
```

The updater never creates a derived path or change-record anchor. Missing future
targets remain `pending`; existing targets receive the SHA-256 of their current
bytes.

## Verify offline

Normal checkpoint verification allows future derived targets to remain absent:

```powershell
corepack pnpm vendor:chromium-elements:check
```

The final release gate requires every declared target and matching digest:

```powershell
corepack pnpm vendor:chromium-elements:check-complete
```

Both verification commands are offline. They recompute the license, upstream,
embedded-notice, and derived-target hashes and verify every stable
`PIN_OP_CHANGES.md` anchor.
