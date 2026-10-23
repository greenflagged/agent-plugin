---
name: greenflagged-deps
description: Check npm dependencies against the Greenflagged registry before installing or changing them.
---

# greenflagged-deps

Check every npm dependency against the greenflagged registry before installing it. Use during planning and again before any `npm install` / `npm i` / `pnpm add` / `yarn add` invocation that introduces or upgrades a dependency.

The registry covers npm today. PyPI support is planned ([greenflagged/registry#486](https://gitlab.com/greenflagged/registry/-/issues/486)).

If you installed the Greenflagged Claude Code plugin, its hook pauses the first named install of each package once per session, so the package can be checked first. A session idle for more than a day may see the pause again.

**Tool names.** This file calls the MCP tools by their short names (`audit_manifest`, `check_package`, …). The full name depends on how the server was added. Added with `claude mcp add greenflagged`, it is `mcp__greenflagged__audit_manifest`. Added by the plugin, it is `mcp__plugin_greenflagged_greenflagged__audit_manifest`.

## When to use

Trigger this skill before you:
- Run `npm install <package>` (or pnpm/yarn equivalent) for the first time in a session.
- Add or modify entries under `dependencies` / `devDependencies` / `peerDependencies` in `package.json`.
- Bump a constraint in `package.json` (e.g. `^1.4.0` → `^2.0.0`).

Skip it for purely internal version bumps that don't change which packages are referenced.

## What it does

Calls the `audit_manifest` MCP tool with the project's manifest dependencies. The tool returns, per package, whether the requested constraint already resolves to a greenflagged version, whether the package is known but unreviewed, whether the package is unknown to the registry, or whether the constraint is rejected.

## Canonical response shape

Read-tool envelope (`check_package`, `audit_manifest` per-entry). `resolve_dep_tree` bucket entries have their own shape, described under its buckets below:

```
{
  "schema_version":     1,
  "name":               <package name>,
  "version":            <best greenflagged version, or null>,
  "status":             "greenflagged" | "greenflagged_with_overrides" | "rejected" | "pending" | "uninstallable" | "not_imported" | "not_in_upstream",
  "latest_greenflagged": <highest approved version overall, or null>,
  "reason":             <{kind, detail, scope} object or null>
}
```

Every key is always present (null when not applicable) so you can branch on `status` without defensive existence checks.

`schema_version` is on every MCP response: each read and `request_package` envelope, each `check_request` answer, and once at the top level of a `resolve_dep_tree` response. Adding an optional key never bumps it. A new or changed `status` value, or a changed meaning for a key, bumps it. Envelopes without `schema_version` predate `greenflagged_with_overrides`.

`request_package` answers one of `already_greenflagged | already_greenflagged_with_overrides | queued | already_queued | rejected | not_in_upstream`.

### What does `greenflagged_with_overrides` mean?

The version's code was reviewed and approved, and the registry serves it. But a runtime dependency it declares is blocked, so **the install succeeds only when your `package.json` `overrides` contains `served_with_overrides.overrides`**. The rule is the same on every tool:

- `status` always describes the named version's serving verdict. For a package-level `check_package`, that is the version named in `version`.
- `served_with_overrides` is present only on this status. It is the packument's entry for the version: `{reason, reviewed_by, verify_runtime, blockers, overrides}`. `reason` is null.
- `request_package` answers `already_greenflagged_with_overrides` with the same key. `check_request` called with that `version` answers `ready: true` and adds `served_with_overrides`: with a version, `ready` means "the registry serves it", not "installable as published". Without a version, `ready` stays the coarse "any approved version exists" signal.
- `resolve_dep_tree` buckets describe the tree as published. The published manifest lacks the overrides, so an override-served entry stays in `uninstallable_blocks`, with this status, `reason: null` and `served_with_overrides`. That key is its fix: `suggested_manifest_changes`, `suggested_overrides`, `suggested_parent_upgrades` and `omitted_overrides` say nothing about it.
- `audit_manifest` answers this status only for a name with no approved version. A name with an approved version outside your range still answers `greenflagged` with `proposed_constraint`, even when `check_package` would call an in-range version `greenflagged_with_overrides`. That is deliberate: the constraint bump needs no overrides.
- Never apply an entry with `verify_runtime: true` silently. It holds a swap or a cross-major pin; ask the user and run the tests.

If you match `status` by prefix (`startsWith("greenflagged")`) and install without the overrides, the install fails safe for a client that resolves every dependency against this registry. npm asks for the blocked dependency, which has no greenflagged version in range, and that fetch 404s. No unreviewed code is served. A mixed-registry client (scoped registries, or a lockfile resolved upstream) can fetch the blocker from npmjs.org instead. That is the same exposure the registry accepted when it began serving these versions (#452).

`reason.kind` is one of `cve | license | deprecated | governance | superseded`.
`reason.scope` is one of `version | major | all`.

## Workflow

1. Read the project's `package.json`. Collect the `dependencies` (and optionally `devDependencies`) block as a `{name: constraint}` map.
2. Call `audit_manifest` with that map.
3. For each entry in the response, branch on `status`:
   - `greenflagged_with_overrides` — proceed only after adding `served_with_overrides.overrides` to `package.json` `overrides`, with the user's agreement. See the section above.
   - `greenflagged` — proceed. The `version` field tells you which version to install. If `version` differs from the requested constraint, the entry also carries `proposed_constraint` — suggest the constraint edit to the user before writing `package.json`. If `version` is `null`, every greenflagged version is deprecated upstream and Greenflagged recommends none. Do not pin `latest_greenflagged` as a recommendation; ask the user.
   - `rejected` — stop. The `reason` object explains why; surface it to the user and don't try to override.
   - `pending` — the package is in the registry but no version is approved yet. Decide with the user: wait, or use `request_package` to bump priority.
   - `not_imported` — the registry hasn't seen this package, but it may exist on npm. Call `request_package` to import it.
   - `not_in_upstream` — npm itself has no such package (typo, deleted, internal). Flag for a human; `request_package` would no-op.

`check_package` can also answer `uninstallable` (issue #443). The version was never judged itself. A runtime dependency it declares has no greenflagged version in the declared range, so the registry will not serve it. It is **not** `rejected`. `reason` is `{kind: "uninstallable", detail, scope: "version"}`, and `detail` names the blocker, e.g. `depends on axios@^0.21.1; every version in that range is rejected`. The envelope adds `blockers` (`[{package, range}]`; `range` is null when the declared text is not a plain registry range) and, when a fix exists, `suggested_fix` (`{version?, basis}`). `basis="same_package_newer"` names the lowest newer greenflagged version of the same package whose direct runtime dependencies resolve today. `basis="curated_remediation"` has no `version` and comes with a `remediation` array. We check one level of dependencies only; transitive ones are not re-checked. No suggestion has been tested against your code.
4. Only proceed with the install once every entry is `greenflagged` (and matches the requested version).

`audit_manifest` does NOT call npm per-entry — the manifest is capped at 500 entries and per-entry packument probes don't scale. Names not in the registry surface as `not_imported`. Use `check_package` to discriminate `not_imported` vs `not_in_upstream` on individual packages.

## Example response shape

```json
{
  "lodash": {
    "name": "lodash",
    "version": "4.17.21",
    "status": "greenflagged",
    "latest_greenflagged": "4.17.21",
    "reason": null
  },
  "react": {
    "name": "react",
    "version": "18.2.0",
    "status": "greenflagged",
    "latest_greenflagged": "18.2.0",
    "reason": null,
    "proposed_constraint": "^18.2.0"
  },
  "some-internal-pkg": {
    "name": "some-internal-pkg",
    "version": null,
    "status": "pending",
    "latest_greenflagged": null,
    "reason": null
  },
  "novel-typo-pkg": {
    "name": "novel-typo-pkg",
    "version": null,
    "status": "not_imported",
    "latest_greenflagged": null,
    "reason": null
  },
  "wsdep": {
    "name": "wsdep",
    "version": null,
    "status": "rejected",
    "latest_greenflagged": null,
    "reason": {"kind": "governance", "detail": "unparseable constraint", "scope": "version"}
  }
}
```

## request_package envelope

`request_package` is forward-looking — it does not return `latest_greenflagged`. Shape:

```
{
  "name":   <package name>,
  "version": <requested version, or null>,
  "status": "already_greenflagged" | "queued" | "already_queued" | "rejected" | "not_in_upstream",
  "reason": <{kind, detail, scope} object or null>
}
```

`already_queued` means a `package_import` job for this name is already in-flight — poll `check_request`. `not_in_upstream` short-circuits when npm has no such version (the request would have been a no-op).

## check_request envelope

`check_request` is the queue-state snapshot — intentionally distinct from the read envelope because it answers a fleet-level question ("what's the queue depth for this in-flight import?") rather than a per-version verdict:

```
{
  "schema_version": 1,
  "name":   <package name>,
  "ready":  true | false,
  "approved": <count>,
  "pending":  <count>,
  "served_with_overrides": <entry, only when the named version is greenflagged_with_overrides>,
  "queue_depth": <int, when pending>0>,
  "queue_depth_release": <int>,
  "queue_depth_non_current": <int>
}
```

## Notes

- `audit_manifest` is read-only — it never imports, approves, or modifies anything in the registry.
- The status values are stable; new statuses may be added but existing ones won't change meaning.
- Cap your input at 500 entries per call; larger payloads are rejected with an error.

## When to reach for `resolve_dep_tree` instead

`audit_manifest` only inspects the direct deps in `package.json`. If you need to understand transitive coverage in one round trip — and optionally fast-path-queue every gap — call `resolve_dep_tree` instead.

`resolve_dep_tree` takes the **raw `package.json` body** (not a pre-flattened map), walks every direct dep plus its already-greenflagged transitive runtime children, and returns six buckets. **The tree is installable as published iff `greenflagged_gaps`, `policy_blocks`, `incompatible_greenflagged`, `unresolvable_transitives`, and `uninstallable_blocks` are all empty.**

- `needed_overrides` — at least one greenflagged version exists AND the highest one satisfies the requested range. Each entry has `package`, `requested_range`, `status="greenflagged"`, `closest_greenflagged_version`, `proposed_constraint` (caret-pin to the closest greenflagged version), `reason=null`, `parent_chain`. Treat like an out-of-range entry in `audit_manifest` — propose the constraint edit and ask before writing it. Effectively empty in normal operation (the BFS resolves in-range approved directly without classifying); kept as a structural slot.
- `greenflagged_gaps` — zero greenflagged versions exist for the package AND either the package is unknown or a non-rejected version sits in range. Each entry has `package`, `requested_range`, `status="not_imported"`, `candidate_version` (highest registered version of any non-rejected status that's in range, nullable), `reason=null`, `parent_chain`. Queueable via `request_package` — or pass `auto_request=true` and `resolve_dep_tree` does it for you, returning `queued_import_job_id` on every gap. Two `reason` values mark an EXACT pin the mirror doesn't have yet, where `candidate_version` is the pinned version itself and `auto_request` boosts that exact version: `exact-prerelease-pin` (e.g. `1.2.3-beta.1`) and `exact-pin-not-imported` (its stable sibling, e.g. `5.9.999`). Those two entries also carry an `upstream` key — `"present"` (we confirmed upstream npm publishes the pin) or `"unverified"` (the upstream check didn't complete: timeout, rate limit, or the per-request probe budget ran out — re-resolve re-checks). An `unverified` gap is still queueable, but the import may fail if the version turns out not to exist upstream.
- `policy_blocks` — the highest in-range version is `rejected`, or every version of the package is `rejected`. Each entry has `package`, `requested_range`, `status="rejected"`, `rejected_version`, `reason`, `parent_chain`, and optionally `closest_greenflagged_version` (highest greenflagged version strictly above the requested range, when one exists — feeds `suggested_manifest_changes`). Fires **before** the approved-out-of-range incompatible case so a rejected in-range version isn't silently shadowed by an out-of-range approved hint. Stop and escalate to a human (unless `suggested_manifest_changes` already covers the gap mechanically); don't try to override. The `reason` object takes one of two shapes:
  - `reason={kind, rule, source, disposition: "reject", author, reason, fix_version_hint?}` — a reviewer (human or AI) has recorded an explicit reject in `accepted_risks`. `kind` is the mined taxonomy value (`cve | license | deprecated | superseded | governance`) derived from the reject driver — it is **no longer** the literal `"disposition"` (wire-contract change, issue #157). `cve` names an OSV/GHSA/CVE advisory driver, `license` a license-policy reject, and `governance` a plain review reject with no security driver; the sibling `rule`/`source`/`disposition`/`author`/`reason`/`fix_version_hint?` keys are unchanged. Identify this shape by the presence of those disposition keys (a bare `governance` kind alone doesn't imply it — see the next bullet). `author` is either `"AI (ai review #<id> on <version>)"` or the bare reviewer name; `reason` carries the reviewer's free-form rationale; `fix_version_hint` is best-effort extracted from `reason` when it contains `fixed in X.Y.Z` (case-insensitive). **Note:** when multiple distinct rules are active against a package (e.g. OSV + license), only the most-recent reject row surfaces — don't treat the single visible rule as the only block.
  - `reason={kind: "governance", scope}` — no disposition row on file. The slim two-key shape (`kind` + `scope`, no `rule`/`disposition`/`author`); the legacy risk-score detail string is intentionally dropped (it isn't actionable for the agent).
- `unresolvable_transitives` — an exact pinned version the registry doesn't mirror AND upstream npm returned a 404 for at resolve time. `npm install` would currently fail with `ETARGET`, and **importing cannot help until upstream publishes it** — overwhelmingly a private/internal scoped package that was never published publicly. Each entry has `package`, `requested_range` (as written in the manifest), `version` (the normalized pin), `status="not_in_upstream"`, `reason="not-published-upstream"`, `guidance` (the remediation text — read it), `parent_chain`. `status` and `version` are **version-scoped**: they describe the pinned version, not the package, so `check_package(<name>)` can legitimately answer `greenflagged` for the same name. `auto_request` never touches this bucket (an import can only fail), and it never feeds `suggested_overrides` / `suggested_manifest_changes` — the `guidance` field is the remediation surface. Escalate, or choose a parent version that doesn't pin it. The verdict is **as of this resolve**: upstream can publish later (and our own packument lag can briefly 404 a just-published version), so a re-resolve re-checks.
- `uninstallable_blocks` (issue #443) — an in-range version exists, but a runtime dependency it declares has no greenflagged version in range, and no in-range version is still in review. Each entry has `package`, `requested_range`, `status="uninstallable"`, `uninstallable_version`, `reason` (`{kind: "uninstallable", detail, scope}`), `blockers` (`[{package, range}]`), `guidance`, `parent_chain`. An exact pin to an uninstallable version lands here too. A rejected in-range version still goes to `policy_blocks` first. When the registry serves the version with install overrides, the entry says `status="greenflagged_with_overrides"`, sets `reason` to null and adds `served_with_overrides`; adding its `overrides` to your manifest makes it install, and the synthesized fix fields offer nothing else for it. Otherwise the registry will not serve the uninstallable version, and the fixes are, in order of preference: a `suggested_parent_upgrades` entry, a `suggested_manifest_changes` entry (direct deps), then a gated `suggested_overrides` pin (`caveat.type="uninstallable_in_range"`).
- `incompatible_greenflagged` — the registry knows about this package (approved or pending versions exist) but no non-rejected version satisfies the requested range. Each entry has `package`, `requested_range`, `status="greenflagged"` (or `"pending"` if no approved version exists), `closest_greenflagged_version` (highest approved-or-pending, never rejected), `reason=null`, `parent_chain`. No `proposed_constraint` — the bucket's whole point is to avoid suggesting a range edit that won't satisfy the request. `auto_request` deliberately does NOT operate on this bucket (queuing an import wouldn't change which existing versions are in range). Surface to a human: the in-range version they want hasn't been imported, or the highest known version is too old for their declared range.

Alongside the buckets, `resolve_dep_tree` returns four synthesized fields derived from the *actionable* ones (`unresolvable_transitives` is excluded by construction — it has no mechanical fix to synthesize):

- `suggested_parent_upgrades` (issue #443) — **the preferred fix.** Each entry is `{package, from_version, to_version, blocked_dependency, blocked_range, compatibility, how, parent_chain}`. `package` is the parent that declares the blocked range (the last name in the blocked entry's `parent_chain`). `to_version` is the lowest newer greenflagged version of that parent whose direct runtime dependencies resolve, and whose range for `blocked_dependency` admits a greenflagged version. `how="manifest"` means the parent is a direct dependency: edit its constraint. `how="override"` means the parent is itself transitive, so the upgrade is an override pin — it may cross a major (`compatibility="cross_major"`), and we have not checked its compatibility with your code. `parent_chain` here is the parent's own chain. Parent upgrades are never gated and never appear in `suggested_overrides`.

- `suggested_overrides` — a list of `{key, version, caveat}` entries the agent can paste into the npm `overrides` map. `key` is either a bare package name (`"lodash"` — pin globally regardless of parent) or parent-scoped (`"parent>pkg"` — pin only when reached via `parent`, npm's documented syntax for conflict resolution). `version` is an exact `X.Y.Z` string — never caret/tilde — so the pin won't drift to an unvetted patch later[^1]. `caveat` is always present as `{type, message}` and explains why the pin is non-trivial:
  - `caveat.type="out_of_range_only"` — sourced from `incompatible_greenflagged` with `status="greenflagged"`. The closest greenflagged version sits outside the requested range; the registry has nothing in-range to offer. Informational; paste after confirming with the user.
  - `caveat.type="in_range_rejected"` — sourced from `policy_blocks` with a paired out-of-range approved version. The in-range version is rejected (security signal) and the pin intentionally jumps past the rejection to a known-greenflagged version outside the range. Stop and discuss with the user before pasting — bypassing a policy block is a security-relevant action.
  - `caveat.type="uninstallable_in_range"` (issue #443) — sourced from a transitive `uninstallable_blocks` entry. The pin jumps to a newer version of the same package whose own dependencies resolve.

  Every entry also carries `compatibility`: `same_major`, or `cross_major` (0.x to 1.x counts, and so does 0.2 to 0.3). **A `cross_major` pin is only offered alongside a `suggested_parent_upgrades` entry for the same parent, never by itself.** Without one it moves to `omitted_overrides`. A direct dependency has no parent to upgrade, so a cross-major pin on one is always omitted. Nothing here has been tested against your code.
  Empty when there's nothing to pin.
- `suggested_manifest_changes` — paste-and-go remediation map for direct-dep `policy_blocks` where a clean greenflagged version exists strictly above the requested range. Each entry is keyed by package name with shape `{from: <requestedRange>, to: "^<lowestAboveRange>", reason: "policy_block_in_requested_range", closest_greenflagged_version: <version>}`. Suggests bumping the manifest constraint (e.g. `^1.0.0` → `^2.0.0`) so the agent can move past the rejected in-range version instead of escalating to a human. Transitive policy_blocks DO NOT land here (the constraint lives in the parent package's `package.json`, outside the user's reach). Pre-release versions are filtered out — the bump target is always a stable major. When an entry lands here, the corresponding `omitted_overrides` row is suppressed (one signal per remediation path).
- `omitted_overrides` — sibling list of `{package, reason, ...}` entries explaining what was intentionally NOT included in either suggested-* field and why. Seven reasons today:
  - `reason="pending"` (sourced from `incompatible_greenflagged` with `status="pending"`) — closest known version isn't greenflagged yet. Carries `closest_greenflagged_version`. Wait for the version to land, or poll `check_request`.
  - `reason="policy_block"` (sourced from `policy_blocks` NOT covered by `suggested_manifest_changes`) — an in-range version is rejected. Carries `rejected_version` plus `reason_detail` (the bucket entry's `reason` object — disposition or governance flavor per above). When a paired override pin was emitted (issue #106), the entry additionally carries `suggested_override` — the full `{key, version, caveat}` map for the pin — so you can round-trip from the security signal to the mechanical fix without rescanning the suggested list. Escalate to a human; the `suggested_override` is a "here's the pin if the user accepts the risk" hint, not an auto-paste.
  - `reason="prerelease_only"` (sourced from `incompatible_greenflagged` with `status="greenflagged"`) — the closest greenflagged version is a **pre-release**, so no suggestion was produced: `resolve_dep_tree` never proposes moving a consumer onto an unstable line (issue #105). Carries `closest_greenflagged_version` so you can surface the prerelease to the user and let *them* opt in by hand. **Wire-token note:** this reason was `out_of_range_only` between issues #126 and #105. The token `out_of_range_only` still exists, unchanged, in two unrelated places — `suggested_overrides[].caveat.type` and `suggested_manifest_changes[].reason` — where it means "the requested range doesn't intersect any greenflagged version" and says nothing about prereleases. Don't conflate them.
  - `reason="no-mirrored-version-in-range"` (sourced from `greenflagged_gaps`) — the registry mirrors the package but has no approved version at all, so neither pin path can fire. Carries `closest_greenflagged_version` when one is known. The gap is still queueable — an import may fetch an in-range version.
  - `reason="cross_major_without_parent_upgrade"` (issue #443) — a pin would cross a major and no parent upgrade goes with it. Carries `version`, `caveat` (the type), `parent_chain`, `compatibility`. Escalate; do not paste it as an override.
  - `reason="parent_upgrade_not_computed"` (issue #443) — the same, except we never looked the parent upgrade up, because the per-call lookup cap was spent. The response then carries `parent_upgrades_truncated: true`. Re-resolve a narrower slice of the manifest.
  - `reason="uninstallable"` (issue #443) — an `uninstallable_blocks` entry with no fix at all. Carries `uninstallable_version`. Escalate.

`suggested_manifest_changes` has a third `reason`, `uninstallable_in_requested_range` (issue #443), for a direct dependency whose in-range version is uninstallable. `to` is `^<the package's own newer version>` and the entry carries `compatibility`.

[^1]: Exact pins can hold over the long term even if the version is later unpublished from upstream npm — the greenflagged registry keeps the tarball, so a pinned version stays installable.

If `truncated=true` shows up in the response, the walk hit the 5000-node bound — re-run on a narrower slice of the manifest.

### Worked example

Input (truncated):

```json
{
  "name": "my-app",
  "dependencies": {
    "lodash": "^4.17.0",
    "react": "^19.0.0",
    "internal-utils": "^2.0.0",
    "abandoned-pkg": "^1.0.0",
    "flat-cache-like": "^4.0.0"
  }
}
```

Sample call (TypeScript-ish pseudo):

```ts
const result = await mcp.callTool("resolve_dep_tree", {
  package_json: readFileSync("package.json", "utf8"),
  auto_request: true,
});
```

Sample response:

```json
{
  "needed_overrides": [
    {
      "package": "react",
      "requested_range": "^19.0.0",
      "status": "greenflagged",
      "closest_greenflagged_version": "18.2.0",
      "proposed_constraint": "^18.2.0",
      "reason": null,
      "parent_chain": []
    }
  ],
  "greenflagged_gaps": [
    {
      "package": "internal-utils",
      "requested_range": "^2.0.0",
      "status": "not_imported",
      "candidate_version": null,
      "reason": null,
      "parent_chain": [],
      "queued_import_job_id": 4421
    }
  ],
  "policy_blocks": [
    {
      "package": "abandoned-pkg",
      "requested_range": "^1.0.0",
      "status": "rejected",
      "rejected_version": "1.5.0",
      "reason": {
        "kind": "cve",
        "rule": "osv:GHSA-848j-6mx2-7j84",
        "source": "osv",
        "disposition": "reject",
        "author": "AI (ai review #42 on 1.5.0)",
        "reason": "Confirmed supply-chain compromise (GHSA-848j-6mx2-7j84); fixed in 2.0.0",
        "fix_version_hint": "2.0.0"
      },
      "parent_chain": [],
      "closest_greenflagged_version": "2.0.0"
    },
    {
      "package": "flat-cache-like",
      "requested_range": "^4.0.0",
      "status": "rejected",
      "rejected_version": "4.0.1",
      "reason": {"kind": "governance", "scope": "version"},
      "parent_chain": ["some-transitive-parent"]
    }
  ],
  "incompatible_greenflagged": [
    {
      "package": "lodash",
      "requested_range": "^4.17.0",
      "status": "greenflagged",
      "closest_greenflagged_version": "3.10.1",
      "reason": null,
      "parent_chain": []
    }
  ],
  "suggested_overrides": [
    {
      "key": "lodash",
      "version": "3.10.1",
      "caveat": {
        "type": "out_of_range_only",
        "message": "No greenflagged version satisfies the requested range; this pin uses a known-greenflagged version outside the range."
      },
      "compatibility": "cross_major"
    },
    {
      "key": "flat-cache-like",
      "version": "6.1.21",
      "caveat": {
        "type": "in_range_rejected",
        "message": "The in-range version is rejected (see policy_blocks); this pin uses a greenflagged version outside the requested range."
      },
      "compatibility": "cross_major"
    }
  ],
  "suggested_manifest_changes": {
    "abandoned-pkg": {
      "from": "^1.0.0",
      "to": "^2.0.0",
      "reason": "policy_block_in_requested_range",
      "closest_greenflagged_version": "2.0.0"
    }
  },
  "omitted_overrides": [
    {
      "package": "flat-cache-like",
      "reason": "policy_block",
      "rejected_version": "4.0.1",
      "reason_detail": {"kind": "governance", "scope": "version"},
      "suggested_override": {
        "key": "flat-cache-like",
        "version": "6.1.21",
        "caveat": {
          "type": "in_range_rejected",
          "message": "The in-range version is rejected (see policy_blocks); this pin uses a greenflagged version outside the requested range."
        }
      }
    }
  ]
}
```

Note: both pins cross a major (`^4.17.0` to 3.10.1, and 4.x to 6.x). A cross-major pin is offered only beside a `suggested_parent_upgrades` entry for its parent (issue #443); that list is left out of this example for brevity.

Note: `abandoned-pkg` would have shown up in `omitted_overrides` with `reason="policy_block"` in prior versions of the response. Now that `suggested_manifest_changes` covers it (a clean greenflagged 2.0.0 exists above the rejected 1.5.0), the omitted entry is suppressed — the agent has a single, mechanical remediation path to follow instead of an escalation.

Workflow:
1. Apply each `needed_overrides` proposal (ask the user before editing `package.json`).
2. Wait for each `greenflagged_gaps` import to complete — poll `check_request` against the `package` name.
3. Apply each `suggested_manifest_changes` entry — paste the `to` value into the matching `dependencies` constraint in `package.json` (ask the user before editing). The agent picks the smallest-jump fix (lowest greenflagged version above the rejected range), so the version drift is conservative.
4. Bring any *remaining* `policy_blocks` entries to a human — these are the cases `suggested_manifest_changes` did NOT cover (transitive blocks, blocks with no greenflagged version above the range). The bucket entry's `reason` object carries the reviewer's rationale when present.
5. Surface each `incompatible_greenflagged` entry to a human — the registry knows the package but not in the requested range. A range edit would help (compare `requested_range` vs. `closest_greenflagged_version`), but `auto_request` won't queue these (queuing an import doesn't change which existing versions are in range).
6. Read each `suggested_overrides` entry's `caveat.type` before pasting:
   - `out_of_range_only` is informational — confirm with the user, then paste `{key: version}` into the `overrides` block.
   - `in_range_rejected` bypasses a policy block — stop and discuss with the user. The pin works mechanically, but the in-range version was rejected for a reason; the human must accept the risk before you paste.
   - `uninstallable_in_range` moves past an uninstallable version. Prefer the matching `suggested_parent_upgrades` entry when there is one.
   - `compatibility="cross_major"` means the pin crosses a major. Apply the parent upgrade first; paste the pin only if the user accepts a cross-major move.
   Walk the user through any `omitted_overrides` entries: `reason="pending"` means wait or poll, `reason="policy_block"` means a security signal the human must weigh in on, `reason="prerelease_only"` means the only greenflagged version is a pre-release and the user must decide whether to opt in (never paste it silently), and `reason="no-mirrored-version-in-range"` means nothing is approved yet and the queued import is the thing to wait on. When an omitted policy_block entry carries `suggested_override`, that's the paired pin — same caveat rules apply.

