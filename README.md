# observe

A folder as a universe. Each top-level file or directory is a particle; each git commit is a snapshot you can scrub through.

## Run

```bash
cd xo/observe
rm -rf node_modules .npm-cache   # only if a prior partial install left these behind
npm install
npm run dev
```

Open http://localhost:3000, paste a folder path, press observe. If the folder is in a git repo, a scrubber appears at the bottom; drag or click to walk through history. Particles morph between snapshots.

## How it works

`app/api/scan/route.ts` reads the top-level entries of a folder. With no `ref`, it walks the filesystem and sums bytes recursively per entry. With a `ref` (a commit SHA), it reads the same view from `git ls-tree` at that commit; sizes come from git's stored blob sizes.

`app/api/snapshots/route.ts` returns up to 200 commits that touched the folder (`git log -- .`).

`components/Universe.tsx` is a canvas particle system. d3-hierarchy's pack layout decides each particle's resting position and radius from sibling sizes; particles drift on top of that with a per-particle sine offset. On snapshot change, surviving entries lerp to new positions, removed ones fade out, new ones fade in from the center.

`components/Timeline.tsx` is the scrubber: oldest commit on the left, newest on the right, click or drag a tick to load it. Non-git folders show a single "live" tick.

## Notes

Hidden files are off by default; toggle in the input bar. Symlinks are not followed. Server walks are capped at 5000 entries per directory. There is no auth on the API routes: keep this dev-only.
