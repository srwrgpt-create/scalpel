# Host Capture Fork Maintenance

This fork carries the Scalpel host support required by PoE2 Currency Router's
Stage 2 OCR presence lifecycle. The supported branch is
`codex/stage2-host-capture`.

The branch is intentionally kept separate from the official Scalpel `main`.
Do not open an upstream pull request, create a release, or create a tag as part
of the maintenance workflow.

## Repository layout

- `origin`: the personal fork used to preserve and update this patch.
- `upstream`: `https://github.com/scalpelpoe/scalpel.git`.
- local `main`: a fast-forward-only mirror of `upstream/main`.
- `codex/stage2-host-capture`: the maintained host-capture patch.

The initial patch is based on upstream commit
`adfcde88fa6a24ea81dba0af7c566dc4f0941605`.

## Patch invariants

Keep these properties when resolving upstream conflicts:

1. `captureGameWindowStreamFrame()` is host-owned. Its persistent
   `MediaStream` lives in a hidden renderer with a unique in-memory Electron
   partition, not in a plugin renderer.
2. A heavy stream failure destroys the renderer and partition and permits one
   bounded recovery in a fresh session. The second heavy failure opens the
   breaker until an explicit reset.
3. `source-unresolved` is a cheap bounded cooldown and does not consume the
   heavy-failure budget.
4. Plugins hold capture leases. Release, renderer unload, lease expiry, and app
   shutdown stop the stream.
5. The host must not silently fall back to repeated
   `captureGameWindow()` full-display snapshots. That path caused confirmed
   periodic game stalls.
6. The multi-title overlay path requires the matching
   `electron-overlay-window` `4.1.0` wrapper and native fork at
   `db989812d62d6e988e915e25d772fc5c34aebdbb`.
7. Packaging must fail when the overlay wrapper and native addon disagree.
8. Tray and Settings startup must remain available even when overlay startup
   throws synchronously.

## Updating from upstream

Start only from a clean worktree.

```powershell
git status --short
git fetch upstream --prune
git fetch origin --prune

git switch main
git merge --ff-only upstream/main
git push origin main

git branch "backup/host-capture-$(Get-Date -Format yyyyMMdd-HHmmss)" codex/stage2-host-capture
git switch codex/stage2-host-capture
git rebase upstream/main
```

Resolve conflicts by preserving the invariants above, then continue the rebase:

```powershell
git add <resolved-files>
git rebase --continue
```

Review the resulting patch before validation:

```powershell
git status -sb
git diff upstream/main...HEAD --stat
git diff upstream/main...HEAD --check
```

The branch is rebased deliberately so the host patch stays reviewable. After
all checks and installation acceptance pass, update the fork with:

```powershell
git push --force-with-lease origin codex/stage2-host-capture
```

Never use an unconditional force push.

## Dependencies and validation

Use Node 22 (`.nvmrc`). A clean Windows dependency install requires the
node-gyp prerequisites used by the official `windows-2022` CI image, including
Visual Studio C++ Build Tools and Python setuptools.

```powershell
npm ci
npm run validate:premium-mods -- --require-verified
npm run lint
npm run format:check
npm run typecheck
npm test
npm run build
git diff --check
```

The focused capture checks may be run first while resolving conflicts:

```powershell
npx vitest run `
  scripts/afterPack.test.mjs `
  src/main/screen-capture/stream-broker.test.ts `
  src/shared/game-capture-stream.test.ts
```

The full gates remain mandatory before packaging.

## Build and installation

The canonical Windows package command is:

```powershell
npm run dist:win
```

`scripts/afterPack.js` must report a verified
`electron-overlay-window 4.1.0` native addon. Do not install a package that
bypasses or fails this check.

If the local Windows account cannot create the Darwin symlinks contained in
electron-builder's signing-tools archive, the already prepared native
dependencies can be packaged without executable metadata editing:

```powershell
npm run build
npx electron-builder --win --x64 `
  --config.npmRebuild=false `
  --config.win.signAndEditExecutable=false
```

That override is a local packaging workaround, not a reason to skip dependency
or `afterPack` validation.

Before installation:

1. Fully quit the installed Scalpel process tree.
2. Record SHA-256 for `dist\Scalpel-Setup.exe` and packaged `app.asar`.
3. Install the local NSIS package into the existing Scalpel location.
4. Verify the installed `app.asar`, overlay version, and native addon hash.
5. Start Scalpel normally and verify tray, Settings, close-to-tray, Router,
   Diagnostics, and clean Quit.
6. With PoE focused, verify repeated Router captures report
   `host-isolated-session`, one stable source, no open failures, and no source
   resolve misses.
7. Complete the real PoE acceptance: reward-book close/reopen/focus lifecycle,
   several minutes without periodic microfreezes, and one full Scalpel restart.

Do not treat a successful compile or synthetic capture probe as a substitute
for the installed lifecycle checks.

## Installed and reproduced baseline recorded on 2026-07-26

- accepted installer size: `86754445` bytes
- accepted installer SHA-256:
  `6F23D1275CA0E5CD22FAE3F183B1F84548E2AA02A8C2D7EE997D2E235F0D997B`
- installer rebuilt from the committed branch: `86754433` bytes
- rebuilt installer SHA-256:
  `386912F824764DD089ABC2E29A76611AC4DECA85CECB4FB742CC17FC0080E585`
- rebuilt and installed `app.asar` SHA-256:
  `C4EF3D9731BA8E0DDA05717CBB4A3325831E18BAA8655BBA86E11ED69D400A66`
- rebuilt and installed overlay native SHA-256:
  `D4B54F605C6B8ABF5C4468EE1D2BB1D522C6AD0DAB21D76B5F4E6E078752F088`

The NSIS envelope is not byte-for-byte deterministic across repeated local
packaging because build metadata can change. Reproducibility is established by
the identical packaged/installed `app.asar`, identical verified native addon,
and a passing `afterPack` compatibility gate. A future upstream update is
expected to produce different payload hashes; record the new values only after
the complete validation and installed acceptance sequence above.
