# Privacy and source notes

The shared log keeps the agent's messages and actions, with personal information and embedded screenshots removed. Game assets, saves, recordings, and private machine configuration are not included.

The controller and SourcePauseTool changes are the versions used during the run. SPT is shared as a patch against public source so readers can build it without downloading the original game folder. Exact versions are in [UPSTREAM.json](../spt/UPSTREAM.json).

See the [session guide](../evidence/README.md) to browse the log.

## What was removed
- Screenshots, opaque reasoning content, host prompts, and device/session metadata.
- Original call identifiers, replaced with sequential IDs.
- Personal paths, emails, and credential patterns where encountered.
- Build output, local assistant state, and the original Git history.

The patch includes all 12 changed files, including the uncommitted change that made roll observation-only. File hashes are listed in [release-manifest.json](../release-manifest.json).
