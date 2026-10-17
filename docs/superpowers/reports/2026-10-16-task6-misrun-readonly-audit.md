# Task6 validation-scope incident: read-only audit

Date: 2026-10-16, Asia/Shanghai. The user authorized read-only inspection, no deletion/restoration, and Task6 continuation after safety assessment. Paid scoring remains prohibited.

## Findings

The executor-owned PowerShell scalar-splat error caused two completed invalid runs and one partial run. All three logs were inspected. Wrapped paths were reconstructed: 4,135 file headers in each completed log, 1,411 in the interrupted log; 2,867 unique test files still exist, with no canonical path aliases. No matching leftover worker remains.

Metadata audit covered 594,487 files and 74,301 directories across seven affected D-drive roots, without following 11,918 links/reparse entries. No enumeration error occurred. The broadened window was 22:49:00–22:54:18 +08:00.

There were 261 timestamp-matching entries: 255 in this task-owned temporary root; four external temporary/test parent directories; and another repository's Git directory/index. The index refresh at 22:52:14 came from the earlier Git status triage, not a source edit. Current audit Git commands disable optional locks.

Two upstream test-directory timestamps match fresh import-boundary build probes and their finally cleanup; none remains. Two OpenCode temporary-host parent changes cannot be actor-attributed from metadata alone. The older residual crash fixture was preserved.

No other application/personal-document file had a creation/write timestamp in the window. Three examined project repositories are clean. A fourth has existing edits/untracked artifacts: its two tracked edits date to October 11, and no file there matched the incident window. Nothing was restored, staged or deleted.

Read-only inspection of 72 observed application test sources found no direct filesystem write/delete/subprocess API use in those files; inspected filesystem references were source reads. Browser/network test substitutes do not prove every transitive dependency harmless.

Full SHA256 comparisons confirmed the deployed executable, frozen models metadata and pinned Bun match their known pre-incident identities.

## Limits and bounded continuation

The USN journal is inactive and no pre-incident full-drive hash inventory exists. Historical deletion, timestamp-preserving changes, and network/credential activity during invalid runs cannot be categorically excluded. Unvisited link targets are outside this conclusion. No journal setting was changed.

Within the inspected material there is no identified source/document corruption or missing observed test input requiring recovery. This supports resuming only explicitly enumerated, canonical repository-contained Task6 verification, not an absolute claim that all external history is known.

Before further testing, prove actual OS argument vectors without executing tests; reject root/traversal/out-of-package inputs before discovery. Preserve all three incident logs and use distinct new output names. No external directory is to be cleaned or restored. Raw evidence remains local and ignored, not for remote publication.

Task6 remains incomplete until remaining package gates, one fresh review, exact isolated executable proof, commits/push and remote equality finish.

Closure (2026-10-17): the above was the audit-time status. The [final verification report](2026-10-16-opencode-coding-workflow-verification.md) records subsequent passing package/exact-binary gates and Task6closure. The original three raw incident logs and four metadata/observed-input JSON files remain local and ignored; uncertain/external files were neither deleted nor restored.
