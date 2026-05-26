# xo-landing

The new XO landing page. Cinematic, scroll-driven, agent-forward, and only ships live features.

## What's here

A single-page Next.js 16 site with nine scroll scenes:

1. **Hero**: particle-formed XO chevron mark, workspace materializing as you scroll. Clear what-we-do subhead, "Start free for 14 days" CTA goes to `https://beta.xo.builders/`.
2. **Why XO** (`#why-xo`): three value-prop cards, each with its own micro-visual: easy setup (pick → click → live ribbon), secure by default (workspace perimeter pulse), ship from minute one (all-inclusive stack sliding into place).
3. **Workspace + Platform** (`#what-is-xo`): single workspace tile multiplies into a fleet, platform dashboard slides in above. Renamed from "Cowork + Swarm" since those are internal architecture names; `Platform` and `Workspace` match `xo-room/product.mdx`.
4. **Workspace tour**: pinned scene with three cross-fading captions (Memory, Coworking, Connections).
5. **Agents** (`#agents`): OpenClaw, Claude Code, Codex, Hermes. Long-running agents only.
6. **Integrations** (`#integrations`): MCP graph. Linear / GitHub / Slack as wired tools, Claude / ChatGPT / Cursor as MCP clients of XO, Telegram / WhatsApp as agent channels. Every node has a brand icon.
7. **1-click connect** (`#connect`): auto-scrolling marquee. Same agent-launch flow extends to tool wiring; every card carries a "Connected" affordance.
8. **Pricing** (`#pricing`): six plans with an Individual/Business toggle. Sourced verbatim from `xo-room/pricing.mdx`. Starter is flagged with the 14-day free trial; Pro and Startup are the highlighted tiers.
9. **Final CTA**: chevron mark scaling in, "Start free for 14 days" goes to beta.xo.builders.

The page is **content-light by design.** Visuals lead, captions are short, motion does the explaining.

## Stack

| | |
|--|--|
| Framework | Next.js 16.2.4 (App Router) |
| UI | React 19.2 + Tailwind v4 |
| Motion | `motion` (formerly framer-motion) |
| Smooth scroll | `lenis` |
| Hero scene | HTML Canvas 2D, chevron particle attractor |
| 3D feel | CSS 3D transforms + scroll-driven SVG (no R3F dep) |
| Fonts | Inter (re-enable `next/font/google` in `layout.tsx` for prod) |

Brand tokens mirror `xo-room`/`xo-docs` (`--color-fd-primary`, etc.). Brand color `#83d63a` on `#08090a` charcoal.

## Run it

```bash
npm install
npm run dev       # http://localhost:3000
npm run build && npm run start
npm run typecheck
```

## File map

```
src/
├── app/
│   ├── globals.css                  # brand tokens + Lenis bridge
│   ├── layout.tsx                   # metadata, providers, fonts
│   └── page.tsx                     # 9 sections, in order
├── components/
│   ├── brand/
│   │   ├── xo-mark.tsx
│   │   └── brand-icon.tsx           # provider/tool logos (inline + img)
│   ├── nav.tsx
│   ├── footer.tsx
│   ├── lenis-provider.tsx
│   ├── hero/                        # hero, particles, workspace mock
│   ├── value-props/                 # easy / secure / ship
│   ├── stack/                       # workspace + platform reveal
│   ├── workspace-tour/              # pinned 3-scene tour
│   ├── runtimes/                    # 4 live agents
│   ├── integrations/                # MCP graph
│   ├── templates/                   # 1-click connect marquee
│   ├── pricing/                     # 6 plans, individual/business toggle
│   ├── cta/                         # final CTA
│   └── orbit/                       # @deprecated, see file header
└── public/
    ├── icons/                       # 13 provider/tool logos
    ├── xo-logo.svg
    ├── xo-logo-512.png
    └── favicon.ico
```

## Live-only content policy

This page surfaces nothing that isn't shipping. Notable cuts (versus the first draft):

* Removed the "Run anywhere" orbit. Docker, Vercel Sandbox, Coder, self-host are roadmap deployment targets per `product.mdx`. Today only XO Cloud (US + India regions) and Closed Boxes are live.
* Replaced the "templates" section with **1-click connect**. The story is now "launch the agent and wire your tools, same click", which is more accurate and avoids surfacing template options that aren't fully live.
* **Agents grid is long-runners only**: OpenClaw, Claude Code, Codex, Hermes. Custom agent moved to a "Bring your own long-running agent" pill below the grid linking to docs.
* **Renamed "Cowork" + "Swarm"** to "Workspace" + "Platform". The former are internal architecture names; the latter is what `product.mdx` uses for customers.
* **Trimmed integrations** to what's actually wired in `xo-swarm-api/mcp_configs.json` (Linear, GitHub, Slack) plus the MCP-client surfaces XO already plugs into (Claude, ChatGPT, Cursor).

When Phase-1 ships fully (Cowork desktop, Kimi K-2, self-host targets), reintroduce them here.

## Provider icons

Single `<BrandIcon name="..." />` component handles all 13 logos through two render modes:

* **Inline JSX** for monochrome marks that use `fill="currentColor"`: openclaw, claude-code, codex, hermes, mcp, linear. Sourced from `xo-docs/public/icons/*` (Linear was missing in both repos so it's drawn in-house).
* **`<img>` tag** for SVGs with their own brand colors (Slack 4-color, Telegram blue, WhatsApp green, Claude swirl, etc.): github, slack, telegram, whatsapp, claude, chatgpt (uses OpenAI mark), cursor.

The Claude icon is the proper Claude swirl mark from `xo-swarm/public/coder/icon/claude.svg`, not the Anthropic A-mark.

## Where the words came from

Source-of-truth: `xo-room/content/docs/{index,mission,product,technology,pricing}.mdx` and `xo-docs/content/docs/agents/*`. The framing ("infrastructure layer for AI agents", "workspaces for AI agents", "agent workforce") is xo-room's. Pricing numbers are pulled verbatim from `pricing.mdx`.

## Performance notes

* Chevron particle scene is canvas2D, not WebGL. Cheap, runs everywhere, respects `prefers-reduced-motion`.
* Lenis disabled when `prefers-reduced-motion: reduce`.
* All scroll-driven animation uses `motion`'s `useScroll` + `useTransform`, GPU-accelerated transforms.
* Workspace tour pins for 3 viewports (`height: 300vh` on a section with `position: sticky` inside).

## Style note

This codebase follows one strict copy rule: **no em dashes or en dashes anywhere**, including code comments. Use a colon, comma, period, parens, or sentence break instead. After any edit, scan for the characters at Unicode U+2014 and U+2013 across `src/` and the README.

## Next steps

* Re-enable `next/font/google` Inter in `src/app/layout.tsx` (commented block, three lines) before deploying. Builds offline currently with a system-font fallback.
* A11y pass: keyboard nav, focus rings on every CTA, alt text on the brand mark.
* Lighthouse pass on a real deployment.
* When XO Cowork desktop ships, add a "Desktop" section between agents and integrations.
* Drop `src/components/orbit/orbit-section.tsx` on the next clean repo pass.
