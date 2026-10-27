# SymbioChain infrastructure

This directory uses Railway's TypeScript Infrastructure as Code SDK, pinned in its own package/lockfile so the backend runtime gains no infrastructure dependency. The configuration describes one PostgreSQL database, the API and the worker, with LIVE trading disabled.

Install the authoring dependencies with `npm ci --prefix .railway`. Link the intended project/environment explicitly before planning. Source deployment uses `railway up` from the repository root for each service; no GitHub repository is assumed.

Initial provisioning needs fresh `SYMBIO_ADMIN_TOKEN`, `SYMBIO_READ_TOKEN` and `SYMBIO_EVIDENCE_ENCRYPTION_KEY` in the CLI process environment. Generate cryptographically random values; the evidence key must be 32 bytes encoded as 64 hexadecimal characters. Keep a private backup outside source control. Subsequent plans preserve remote values when these inputs are omitted. Do not rotate the evidence key over an existing database without migrating its encrypted evidence.

Run `railway config plan --out .data/railway-plan.json`, review its additions/changes/deletions, then request approval of that exact plan before applying it. The saved plan can contain secrets and must remain private. A successful plan does not prove provisioning, image upload, migration or runtime health.

Pinned plans normally use the committed `.railway` tree. Before an initial commit exists, stage the reviewed configuration, obtain its tree with `git rev-parse "$(git write-tree):.railway"`, and pass that ID using `--source-tree`. The prepared local plan uses this staged-tree identity. Commit the matching reviewed source or regenerate a plan from your checkout before applying it. Never use a different tree just to bypass stale-plan rejection.

The API retains `npm run db:migrate` as its pre-deploy step and `/readyz` as its health check. The worker has its own start command and no HTTP health check. Database references and application secrets are shared by reference. This source does not manage custom domains, unrelated projects, billing plans, spending limits or funded wallets.

No legacy Config as Code service was found in the selected empty project, so no remote cutover or rollback is needed for those files. The old local TOML settings have been replaced by this single source after plan and semantic checks. Local rollback copies remain under `.data/railway-legacy/`. Existing deployments elsewhere need Railway's `config migrate cutover`/`undo` workflow and a reviewed plan; do not clear their config paths implicitly.
