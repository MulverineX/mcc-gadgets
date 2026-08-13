# CDX audit log (`cdx-audit.log`)

Every Wayback CDX query the test resolver makes appends a line to `.temp/test-articles/cdx/cdx-audit.log` via `local-cache.ts`'s `fetchCdx`. Each line shows: hash, query URL, cache hit/miss/network-response/error, status, body length, body preview.

## Each test run clears the log

The corpus describe-block in `tests/changelog.test.ts` rotates the previous log to `cdx-audit.<timestamp>.log` and then deletes it. Post-run inspection: read the most recent timestamped backup.

## Backup before auditing

The CDX audit log is the primary evidence when debugging resolution failures. **Before** any code that mutates or clears the log, copy it to a sibling directory:

```bash
cp .temp/test-articles/cdx/cdx-audit.log .temp/audit-$(date +%s).log
```

Or use the automatic rotation (the test handles this on each run). If the rotation has already happened, find the most recent timestamped backup:

```bash
ls -t .temp/test-articles/cdx/cdx-audit.*.log | head -1
```

## What to look for

- `cache MISS (offline)` + no `network fetch START` line → code isn't reaching the network (logic gate is short-circuiting earlier)
- `network response: <status>` non-200 → Wayback throttling or service issue
- `network response: 200` + `body length: 0` → correct "no captures" but file written as `.empty.txt`
- `network response: 200` + non-zero body → real captures, body preview should show the timestamp + original URL

## CDX cache pruning

`.temp/cdx-gc.ts` enumerates URLs the current resolver queries for the corpus, hashes them, and deletes stale `.empty.txt` files (real `.txt` captures are kept as-is since they're expensive to re-fetch). Always dry-run before `--apply`.
