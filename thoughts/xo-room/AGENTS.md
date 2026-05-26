# Agent rules for xo-room

Conventions any human or AI agent must follow when adding or editing content in this repo. Keep this file short. Each rule should pay rent.

## Page icons

**Every page in `content/docs/` must declare a non-empty `icon:` field in its frontmatter.** No exceptions, including new pages. The icon is what shows up in the sidebar, breadcrumbs, and page tree — pages without one render with empty space where the glyph should be, which looks broken.

The icon value must be a key from the `ICON_CLASSES` allowlist in [`src/lib/source.ts`](./src/lib/source.ts). The fumadocs source loader silently drops unrecognized icon names (renders nothing), so a typo or unlisted name fails *quietly* — the page builds, the icon just disappears. Always pick from the list below or extend the allowlist before referencing a new name.

### Current allowlist

```
Archive · Blocks · BookOpen · Bot · Building2 · Chart · ChartLine ·
CircleHelp · Compass · Cpu · CreditCard · CurrencyDollar · FileText ·
Flag · Globe · HardDrive · Handshake · Info · LayoutTemplate · Lightbulb ·
Lock · Manage · Monitor · Network · Package · Plug2 · Presentation ·
Puzzle · Rocket · Scale · Settings · Share2 · Shield · Target · Terminal ·
TrendUp · Trophy · UserPlus · Users · Wallet · Warning · Workflow · Zap
```

Brand icons: `XO` (renders `public/icons/xo.svg` via `BrandIcon`).

### Adding a new icon

If none of the above fits, add a new entry to `ICON_CLASSES` in `src/lib/source.ts`:

```ts
NewIconName: "icon-[ph--phosphor-icon-name-fill]",
```

Constraints:

- **Use Phosphor (`ph--*-fill`) where possible** to keep the room visually consistent. Mingcute is allowed only when Phosphor lacks an equivalent (e.g., `Bot` uses Mingcute).
- **The class string must appear verbatim in source** — Tailwind v4 scans literals to emit CSS, so dynamic concatenation (`` `icon-[ph--${name}-fill]` ``) won't work.
- Keep the map alphabetical so it stays scannable.
- After adding, the icon is immediately usable as `icon: NewIconName` in any page's frontmatter.

### Frontmatter shape

Every new MDX page in `content/docs/` should look like this:

```mdx
---
title: Page Title
description: One-line description for sidebar tooltips and SEO.
icon: ChosenIconName
---

import { Callout } from 'fumadocs-ui/components/callout';

# Page Title

Body content...
```

`title`, `description`, and `icon` are all required. Skipping any of them produces a broken or unstyled page in the sidebar.

## Monthly plan pages

Pages in `content/docs/plan/` named `<month>-<year>.mdx` are part of the execution-plan breakdown. They share a structure so a reader gets the same shape of information month over month. Every monthly page must include:

### 1. ICP block inside Focus

Each monthly page has a `## Focus` section. Inside it, immediately after the focus statement, include a sub-block that names **who the primary audience and targets are this month** — the Ideal Customer Profile we're optimizing for. Use this exact format:

```mdx
**ICP this month.** [One-paragraph description of the primary audience and target segments. Be specific: roles, company sizes, channels we're reaching them through. List 2–4 concrete persona/segment bullets if useful.]
```

Why: every month's GTM motion is shaped by who we're aiming at. Without ICP up front, the rest of the page reads like activity without direction.

### 2. Simplified infra section (3 datapoints only)

The infrastructure section on monthly pages is **for external readers** — investors, partners, prospects. It must show only three numbers, in this exact format:

```mdx
## Infrastructure

| Metric | Value |
|---|---|
| Cost per workspace | $X |
| Total infra cost | $Y / mo |
| Total workspaces | Z |
```

No node counts, no per-region tables, no commitment-discount details. If you need to capture richer infra data, put it in an internal-only doc, not the public room. Cost-per-workspace can be a Medium-tier number for community-facing months and a blended number once Standard (B2B) workspaces dominate the mix.

### 3. Token Flow KPI row

Every monthly page's KPI table must include a row tracking **monthly token flow through the platform**. Tokens passing through XO infrastructure is the most direct signal of platform utility — workspaces growing without token flow growing means agents aren't working; token flow growing faster than workspaces means each workspace is doing more.

Add this row to the KPI table:

```mdx
| Token flow through platform | <target> | Platform utility — agents actually working |
```

Suggested target progression (refine once we have actual data):
- Apr 2026 — track baseline, ~100M tokens
- May 2026 — ~1B tokens
- Jun 2026 — ~1.5B tokens
- Jul 2026 — ~2B tokens (B2B workloads heavier)
- Aug 2026 — ~3B tokens (partner volume)
- Sep 2026 — ~5–10B tokens (5,000 workspaces)

These are placeholders until we have real telemetry. Update them once we do.
