# PostHog on Next.js App Router: end-to-end integration playbook

Hand this to another Claude session to add PostHog to a Next.js App Router app the same way we added it to **xo-swarm**. It is derived from the last 12 commits of this repo (between `e1b842a5` and `20938680`, May 15-21, 2026). Every step here is something we actually shipped, with the lessons we learned from each follow-up commit folded back in.

The implementation covers, in order:

1. SDK install + env wiring
2. Server-side OTel log shipping to PostHog
3. Reverse proxy through Next so ad-blockers do not nuke analytics
4. Client `PostHogProvider` wrapping the root layout
5. Clerk user identification
6. Server-side event capture from Server Actions
7. Feature flags (client hook + server SDK)
8. Surveys / web scripts (notification bar)
9. Bug-report / feedback capture
10. Production hardening (debug gate, Docker runtime env, Clerk SSR fix)

Treat sections as runnable steps, not a survey.

---

## 0. Prereqs

- Next.js App Router (we are on Next 16, React 19, but everything here works on Next 14+ App Router).
- A PostHog project (cloud or self-hosted). Grab the project token (starts with `phc_`) and the host (`https://us.i.posthog.com` for US cloud, `https://eu.i.posthog.com` for EU cloud).
- An auth provider for `identify()`. We use Clerk; substitute your own.
- A package manager. xo-swarm uses Yarn classic.

If the project ships in Docker with runtime env injection (xo-swarm does), section 11 is mandatory or `NEXT_PUBLIC_*` placeholders will be baked into the bundle at build time and never get the real values.

---

## 1. Install packages

```bash
yarn add posthog-js posthog-node
# OpenTelemetry log shipping (optional but recommended; see §3)
yarn add @vercel/otel \
         @opentelemetry/api-logs \
         @opentelemetry/exporter-logs-otlp-http \
         @opentelemetry/instrumentation \
         @opentelemetry/resources \
         @opentelemetry/sdk-logs
```

The OTel packages are pinned at `^0.218.0` / `^2.x` in our `package.json`. Match versions; OTel breaks across minor versions.

We also have `@posthog/wizard` as a devDep because we initially ran the wizard, but it is not required at runtime. Delete after install if you do not want it sitting in the lockfile.

---

## 2. Environment variables

`.example.env`:

```
NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN=your_posthog_project_token
NEXT_PUBLIC_POSTHOG_HOST=https://us.i.posthog.com
```

Both keys are `NEXT_PUBLIC_*` because the browser bundle needs them. The project token is a write-only public key (safe to expose). Do **not** put a personal API key here.

If your app reads env at runtime through `process.env.ENVIRONMENT` for things like the debug gate (see §10), set that too in whichever container/host runs the app.

---

## 3. Server-side OTel log shipping to PostHog (`instrumentation.ts`)

Next.js auto-loads `instrumentation.ts` at the project root on server start. We use it to send `console.log/warn/error` calls to PostHog as structured logs via OTLP. PostHog accepts OTLP logs at `${host}/i/v1/logs`.

`instrumentation.ts`:

```ts
import { registerOTel } from "@vercel/otel";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";

let processor: BatchLogRecordProcessor | undefined;

export function flushLogs() {
	return processor?.forceFlush() ?? Promise.resolve();
}

export function register() {
	processor = new BatchLogRecordProcessor(
		new OTLPLogExporter({
			url: `${process.env.NEXT_PUBLIC_POSTHOG_HOST}/i/v1/logs`,
			headers: {
				Authorization: `Bearer ${process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN}`,
			},
		}),
	);

	registerOTel({
		serviceName: "your-app-name",
		logRecordProcessors: [processor],
	});

	if (process.env.NEXT_RUNTIME === "nodejs") {
		patchConsole();
	}
}

function patchConsole() {
	const logger = logs.getLogger("your-app-name");

	const format = (args: unknown[]) =>
		args
			.map((a) =>
				typeof a === "object" ? JSON.stringify(a, null, 2) : String(a),
			)
			.join(" ");

	const original = {
		log: console.log.bind(console),
		warn: console.warn.bind(console),
		error: console.error.bind(console),
	};

	console.log = (...args) => {
		original.log(...args);
		logger.emit({ body: format(args), severityNumber: SeverityNumber.INFO });
	};
	console.warn = (...args) => {
		original.warn(...args);
		logger.emit({ body: format(args), severityNumber: SeverityNumber.WARN });
	};
	console.error = (...args) => {
		original.error(...args);
		logger.emit({ body: format(args), severityNumber: SeverityNumber.ERROR });
	};
}
```

Why patch console rather than asking devs to use a custom logger? Existing code already calls `console.*` everywhere. Patching gives free coverage on day one. The `NEXT_RUNTIME === "nodejs"` guard skips the patch on edge/middleware where the console binding behaves differently.

Skip this entire file if you do not want server logs in PostHog; nothing else depends on it.

---

## 4. Reverse proxy so ad-blockers do not eat events

uBlock, Brave, Safari ITP, and corporate proxies block requests to `*.i.posthog.com`. Proxy through your own origin instead.

`next.config.ts`:

```ts
const nextConfig: NextConfig = {
	// ...
	skipTrailingSlashRedirect: true,
	async rewrites() {
		return [
			{
				source: "/ingest/static/:path*",
				destination: "https://us-assets.i.posthog.com/static/:path*",
			},
			{
				source: "/ingest/array/:path*",
				destination: "https://us-assets.i.posthog.com/array/:path*",
			},
			{
				source: "/ingest/:path*",
				destination: "https://us.i.posthog.com/:path*",
			},
		];
	},
};
```

Three rules in **this order**:
- `/ingest/static/*` → assets host (snippet JS, web scripts).
- `/ingest/array/*` → assets host (feature flag arrays, surveys payloads). **We missed this initially**; the wizard PR added it. Without it, web scripts / surveys silently 404.
- `/ingest/*` → ingest host (events, decide, capture).

Lessons from the follow-up commits:
- `skipTrailingSlashRedirect: true` is required, otherwise Next adds a trailing slash and the rewrite never matches.
- **Hard-code the destinations.** We initially used `${process.env.NEXT_PUBLIC_POSTHOG_HOST}` in the rewrite and the production build (`output: "standalone"`) inlined whatever value existed at build time, which is wrong in Docker runtime-injection setups. Commit `beb9f068` fixes this by hard-coding `https://us.i.posthog.com`. Use `eu.i.posthog.com` if EU.

If you use middleware with route matching (Clerk does in xo-swarm), allow-list `/ingest(.*)`:

`proxy.ts` (Clerk middleware lives here; it is `middleware.ts` in most apps):

```ts
const isPublicRoute = createRouteMatcher([
	"/sign-in(.*)",
	// ...
	"/ingest(.*)",
]);
```

Otherwise Clerk runs auth on every analytics request and breaks ingestion.

---

## 5. Client-side PostHog provider

The wizard's default of `instrumentation-client.ts` works, but **we replaced it** (commit `380640a0`) with a `PHProvider` component for two reasons:
1. `PostHogProvider` from `posthog-js/react` gives child components `usePostHog()` and `useFeatureFlagEnabled()` hooks.
2. We can gate init on `NODE_ENV` so dev runs do not pollute prod analytics.

`components/posthog-provider.tsx`:

```tsx
"use client";
import posthog from "posthog-js";
import { PostHogProvider } from "posthog-js/react";

if (typeof window !== "undefined" && process.env.NODE_ENV !== "development") {
	posthog.init(process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN!, {
		api_host: "/ingest",
		ui_host: process.env.NEXT_PUBLIC_POSTHOG_HOST?.replace(".i.", "."),
		defaults: "2026-01-30",
		capture_exceptions: true,
		debug: process.env.ENVIRONMENT === "development" ? true : false,
		opt_in_site_apps: true,
	});
}

export function PHProvider({ children }: { children: React.ReactNode }) {
	return <PostHogProvider client={posthog}>{children}</PostHogProvider>;
}
```

Key bits:
- `api_host: "/ingest"` routes through the rewrite (§4). Never point client init at `*.i.posthog.com` directly.
- `ui_host` strips the `.i.` so the SDK constructs correct dashboard links (e.g. for session replay). `us.i.posthog.com` → `us.posthog.com`.
- `defaults: "2026-01-30"` opts into the latest sensible defaults bundle (PostHog ships dated default sets so behavior is reproducible).
- `capture_exceptions: true` ships uncaught client errors automatically.
- `debug` is **gated** on `ENVIRONMENT === "development"`. Commit `bb112244` fixed our debug-everywhere mistake. Verbose console spew in production breaks customers' devtools workflows.
- `opt_in_site_apps: true` lets PostHog Web Scripts (surveys, banners, etc.) execute on your site. Needed for the notification bar in §9.

The `if (typeof window !== "undefined" && NODE_ENV !== "development")` guard means: only init in the browser, never during SSR, never in `next dev`.

Wire it into the root layout `app/layout.tsx`:

```tsx
import { PHProvider } from "@/components/posthog-provider";

export default function RootLayout({ children }) {
	return (
		<html lang="en">
			<body>
				<ThemeProvider>
					<ClerkThemeProvider>
						<PHProvider>
							{/* the rest of your tree */}
							{children}
						</PHProvider>
					</ClerkThemeProvider>
				</ThemeProvider>
			</body>
		</html>
	);
}
```

`PHProvider` must wrap anything that calls `usePostHog()` or `useFeatureFlagEnabled()`.

**Why we deleted `instrumentation-client.ts`:** Next.js loads it before React is mounted, so `posthog-js/react`'s `usePostHog()` cannot find the provider context. You can still init from `instrumentation-client.ts` and just rely on the global `posthog` import everywhere, but you give up hooks. We prefer hooks; pick one or the other, not both.

---

## 6. Identify users (tie events to your auth provider)

Once Clerk (or your auth provider) reports a logged-in user, call `posthog.identify(userId, traits)`. We do this in `components/conditional-layout.tsx`, the first client component that has access to the Clerk user:

```tsx
"use client";
import { useUser } from "@clerk/nextjs";
import { useEffect } from "react";
import posthog from "posthog-js";

export function ConditionalLayout({ children }) {
	const { isLoaded, user } = useUser();

	useEffect(() => {
		if (isLoaded && user) {
			posthog.identify(user.id, {
				email: user.primaryEmailAddress?.emailAddress,
				name: user.fullName ?? undefined,
				username: user.username ?? undefined,
			});
		}
	}, [isLoaded, user]);

	// ... rest of layout
}
```

Notes:
- Use **your auth system's user ID** as `distinctId`, not the email. IDs are stable; emails change.
- Pass only traits you actually need for segmentation. Adding noise here makes PostHog person-properties unwieldy.
- The same `userId` is what you pass to `posthog-node` on the server (§7) so events from both sides aggregate to the same person.

If you support a "sign out" flow, call `posthog.reset()` in the sign-out handler so the next anonymous visitor does not inherit the previous user's identity.

---

## 7. Server-side event capture (Server Actions / Route Handlers)

Server-side gives you events that the browser cannot fake (project creation, billing, internal admin actions). Use `posthog-node` via a singleton.

`lib/posthog-server.ts`:

```ts
import { PostHog } from "posthog-node";

let posthogClient: PostHog | null = null;

export function getPostHogClient() {
	if (!posthogClient) {
		posthogClient = new PostHog(
			process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN!,
			{
				host: process.env.NEXT_PUBLIC_POSTHOG_HOST,
				flushAt: 1,
				flushInterval: 0,
			},
		);
	}
	return posthogClient;
}
```

- **Singleton.** Server Actions on Vercel/Fluid Compute share warm function instances; recreating the client per request leaks memory and rate-limits you.
- `flushAt: 1, flushInterval: 0` flushes after every event. Without this, events buffered in a serverless function get lost when the instance suspends. The tradeoff is one extra outbound request per event; that is fine.
- The server client hits `*.i.posthog.com` **directly**, not `/ingest`. The reverse proxy is only for the browser.

Usage in a Server Action (`app/actions/projects.ts`):

```ts
import { getPostHogClient } from "@/lib/posthog-server";

export async function createOpenClawProjectCore(/* ... */) {
	// ... create the project ...
	await addProjectToUser(userId, newProject.id);

	const posthog = getPostHogClient();
	posthog.capture({
		distinctId: userId,
		event: "project_created",
		properties: {
			project_id: newProject.id,
			project_name: name,
			project_type: "openclaw",
		},
	});

	revalidatePath("/");
	return newProject;
}
```

Conventions we settled on:
- Snake_case event names (`project_created`, `subscription_checkout_initiated`, `project_access_revoked`). Pick one casing and enforce it; mixing reads badly in the PostHog UI.
- Always include `distinctId` and at minimum the resource ID. Add a `type` discriminator (`project_type` here) when the same event covers multiple variants; it makes funnel and breakdown queries trivial.
- Do not `await posthog.shutdown()` in a Server Action; let the singleton outlive the request. (Do call `shutdown()` from a `process.on("SIGTERM")` if you run long-lived Node servers.)

Server vs. client capture, pick by ownership:
- Conversion / business events (created project, started trial, revoked access) → **server**. Tamper-proof, not blocked.
- UX / page interaction events (viewed pricing, clicked button) → **client**. Has full URL/referrer/UTM context.

We do both for the subscription funnel: `pricing_page_viewed` (client), `subscription_checkout_initiated` (client), `subscription_success_viewed` (client). All from `posthog-js` because they need browser context.

---

## 8. Feature flags

PostHog's `evaluateFlags` API on the server is the cheaper, deterministic way to gate things.

**Server-side gate** (`app/api/coder/builds/[buildId]/logs-stream/route.ts`):

```ts
import { auth } from "@clerk/nextjs/server";
import { getPostHogClient } from "@/lib/posthog-server";

export async function GET(/* ... */) {
	const { userId } = await auth();
	if (!userId) return new Response("Unauthorized", { status: 401 });

	const flags = await getPostHogClient().evaluateFlags(userId);
	if (!flags.isEnabled("show_build_logs")) {
		return new Response("Build logs are not available", { status: 403 });
	}
	// ... protected logic ...
}
```

We initially called `isFeatureEnabled("flag", userId)` per-call (commit `3244f38e`), then switched to `evaluateFlags(userId)` (commit `20938680`) so multiple flag checks in one request hit PostHog once. **Always prefer `evaluateFlags()` if you check ≥2 flags per request.**

**Client-side gate** (`components/chat/tabs/CoderWorkspace/index.tsx`):

```tsx
import { useFeatureFlagEnabled } from "posthog-js/react";

export const CoderWorkspace = (/* ... */) => {
	const showBuildLogs = useFeatureFlagEnabled("show_build_logs") !== false;

	const buildLogs = useBuildLogs({
		buildId,
		sessionToken,
		enabled: showBuildLogs && !!buildId && !!sessionToken,
	});
	// ...
};
```

Note the `!== false` defaulting: `useFeatureFlagEnabled` returns `undefined` while flags are still loading. Treating undefined-as-enabled means UI does not flicker dark → light → dark while flags load. Choose the default that matches the *less destructive* outcome (here, briefly fetching logs that may turn out to be hidden is fine).

Gate **both** sides for security-relevant flags. Client gate keeps the UI clean; server gate is the actual enforcement. The build-logs flag does exactly this.

---

## 9. Surveys / web scripts (the notification bar)

PostHog Web Scripts let you inject UI from the dashboard without a redeploy. They require `opt_in_site_apps: true` in the init config (§5). We use one to power a top-of-app notification bar.

`components/posthog/notification-bar.tsx`:

```tsx
"use client";
import { useState, useEffect } from "react";

export function NotificationBar() {
	const [content, setContent] = useState<string | null>(null);

	useEffect(() => {
		// Script may have already fired before this component mounted
		if ((window as any).__phNotification) {
			setContent((window as any).__phNotification);
		}
		const handler = (e: Event) => {
			setContent((e as CustomEvent<{ content: string }>).detail.content);
		};
		window.addEventListener("ph-notification", handler);
		return () => window.removeEventListener("ph-notification", handler);
	}, []);

	if (!content) return null;
	return (
		<div className="w-full bg-primary text-primary-foreground ...">
			<span dangerouslySetInnerHTML={{ __html: content }} />
			{/* close button */}
		</div>
	);
}
```

Then in your dashboard PostHog Web Script you do something like:

```js
window.__phNotification = "<strong>Heads up:</strong> scheduled maintenance at 22:00 UTC.";
window.dispatchEvent(new CustomEvent("ph-notification", { detail: { content: window.__phNotification } }));
```

Two-channel design: the script sets a window global **and** fires an event. The React component reads the global on mount (in case the script ran before React hydrated) and listens for the event (in case the script runs later, e.g. after a flag fetch). That double-handshake is the only way to avoid race conditions when the script load order is non-deterministic.

Mount the component once at the top of the authenticated layout (we put it in `ConditionalLayout` right above the header).

`dangerouslySetInnerHTML` is intentional here: the operator controls the script content from PostHog, so XSS surface = "anyone with PostHog access can XSS our site". That tradeoff is acceptable for internal-comms banners; it would not be acceptable for user-submitted content.

---

## 10. Custom event capture from UI (bug report dialog)

Use `usePostHog()` from `posthog-js/react` inside a client component:

`components/feedback-button.tsx`:

```tsx
"use client";
import { useState } from "react";
import { usePostHog } from "posthog-js/react";

export function FeedbackButton() {
	const posthog = usePostHog();
	const [description, setDescription] = useState("");

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!description.trim()) return;

		posthog?.capture("Bug Reported", {
			description,
			$current_url: window.location.href,
		});
		// ... show success UI
	};

	// ... dialog markup
}
```

History worth knowing: we first tried PostHog's `posthog.conversations.sendMessage()` Support API (commit `3244f38e`), then dropped it (commit `20938680`) in favor of a plain `capture("Bug Reported", …)`. Reasons:
- The Support API is in beta; the surface kept moving.
- Capturing as a regular event lets us pipe bug reports into a PostHog dashboard and Slack via Webhook, which is what we actually wanted.
- We removed the email field too: PostHog already knows who the user is via `identify()` (§6), so attaching email per-event was redundant.

Lesson: prefer the lowest-common-denominator API (`capture`) over feature-specific APIs unless you need the feature-specific behavior. Less surface to mock, less to break.

The `$current_url` property is a PostHog convention; properties starting with `$` show up first-class in the dashboard.

---

## 11. Docker / runtime env injection

If you ship as a Docker image and inject env at container start (xo-swarm does), `NEXT_PUBLIC_*` vars get baked into the build and **never read your runtime env**. The trick: build with placeholders, swap them at container start.

`Dockerfile` (additions):

```dockerfile
ENV NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN=__NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN__
ENV NEXT_PUBLIC_POSTHOG_HOST=__NEXT_PUBLIC_POSTHOG_HOST__
```

`entrypoint.sh` (excerpt; full file does this for every `NEXT_PUBLIC_*` var):

```sh
SEDSCRIPT=$(mktemp)
trap 'rm -f "$SEDSCRIPT"' EXIT

add_replacement() {
  local placeholder="$1"
  local value="$2"
  [ -n "$value" ] || return 0
  local escaped=$(printf '%s' "$value" | sed 's/[\\&|]/\\&/g')
  printf 's|%s|%s|g\n' "$placeholder" "$escaped" >> "$SEDSCRIPT"
}

add_replacement "__NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN__" "$NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN"
add_replacement "__NEXT_PUBLIC_POSTHOG_HOST__" "$NEXT_PUBLIC_POSTHOG_HOST"
# ... other vars ...

if [ -s "$SEDSCRIPT" ]; then
  find /app/.next -type f \( -name "*.js" -o -name "*.html" \) -exec sed -i -f "$SEDSCRIPT" {} +
  find /app -maxdepth 1 -name "server.js" -exec sed -i -f "$SEDSCRIPT" {} +
fi

exec "$@"
```

Why one sed script instead of one `find … -exec sed` per var? `find` traversal dominates the cost; running it once with a multi-rule sed script is dramatically faster on a built `.next/`. Commit `f6691a49` made this consolidation.

Reverse-proxy destinations (§4) must be **hard-coded literals**, not `process.env.NEXT_PUBLIC_POSTHOG_HOST`, because rewrites are evaluated at build time and the standalone output bakes them in. The runtime-injection trick does not reach into `next.config.ts`-derived routing.

---

## 12. Verification checklist before declaring done

Run each of these and look at PostHog Live Events to confirm:

1. **Anonymous pageview**: open the app in an incognito window, navigate, see a `$pageview` event for an anonymous distinct ID.
2. **Identify**: sign in. Watch the same anonymous ID get aliased to your user ID, with `email`, `name`, `username` set.
3. **Reverse proxy**: DevTools, Network tab. Confirm calls go to `https://your-app.com/ingest/...`, not `*.i.posthog.com`. Status 200, response body looks normal.
4. **Server event**: trigger one of your server-action events. Confirm it lands in PostHog within ~5s (because of `flushAt: 1`).
5. **Feature flag**: flip a flag in PostHog UI. Confirm both the client-gated UI and server-gated route handler respect it within 60s (default flag cache TTL on the server SDK).
6. **OTel logs (if used)**: write a `console.error("test")` from a Server Component or API route. PostHog Logs (or your OTel backend) should show it.
7. **Exception capture**: throw an error from a client component. Confirm an `$exception` event lands with stack trace.
8. **Web script**: fire your notification web script from the PostHog dashboard at a single test user. Confirm the bar appears in their session and not in others.
9. **Docker runtime injection (if used)**: build the image, run with `-e NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN=...`, confirm the built JS contains the real token (`grep` the running container's `/app/.next/static/chunks` for the token prefix).

If any step fails, stop and fix before moving on. Failures compound.

---

## 13. Suggested event taxonomy

Stolen directly from what we instrumented:

| Event | Where | Captured by | Properties |
|---|---|---|---|
| `project_created` | Server Action | `posthog-node` | `project_id`, `project_name`, `project_type` |
| `project_shared` | Server Action | `posthog-node` | `project_id`, `shared_with_user_id` |
| `project_access_revoked` | Server Action | `posthog-node` | `project_id`, `revoked_user_id` |
| `pricing_page_viewed` | Client page | `posthog-js` | (none; `$current_url` auto-attached) |
| `subscription_checkout_initiated` | Client button | `posthog-js` | `plan_id`, `plan_name`, `billing_cycle` |
| `subscription_trial_started` | Client response | `posthog-js` | `plan_id`, `plan_name`, `subscription_id` |
| `subscription_success_viewed` | Client page | `posthog-js` | `session_id` |
| `Bug Reported` | Client dialog | `posthog-js` | `description`, `$current_url` |

Use this skeleton as a starting point. Three rules from our experience:
1. Pick **one casing convention** (we used snake_case for our own events; PostHog's built-ins use `$camelCase` or `$snake_case` with `$` prefix).
2. Capture from the side that owns the truth: business outcomes server-side, user behavior client-side.
3. When in doubt, add the property. Removing a property later in PostHog is harmless; adding it retroactively is impossible.

---

## 14. Things that will bite you (lessons from the 12 commits)

These are mistakes we shipped and then had to fix. Avoid them.

1. **Debug-everywhere.** `debug: true` in `posthog.init` floods console in prod. Gate it on `ENVIRONMENT === "development"`. (Commit `bb112244`.)
2. **Missing `/ingest/array/*` rewrite.** Web scripts and surveys silently fail. Always add all three rewrites. (Wizard PR `c52b0556`.)
3. **Templated rewrite destination.** `${process.env.NEXT_PUBLIC_POSTHOG_HOST}` in `next.config.ts` does not work with Docker runtime injection. Use string literals. (Commit `beb9f068`.)
4. **`instrumentation-client.ts` + `usePostHog()`.** They do not compose. Pick one init site: the provider component (recommended) or `instrumentation-client.ts`. (Commit `380640a0`.)
5. **`isFeatureEnabled` per flag.** N flag checks = N PostHog round-trips. Use `evaluateFlags(userId)` once. (Commit `20938680`.)
6. **`flushAt > 1` on serverless.** Events buffer in the function instance and disappear when it suspends. Use `flushAt: 1, flushInterval: 0`. (Initial setup, `posthog-server.ts`.)
7. **Forgetting the middleware allowlist.** Auth middleware will challenge requests to `/ingest/*` and kill ingestion. Allowlist `/ingest(.*)`. (Commit `2aa94cbb`.)
8. **Forgetting Clerk's domain-in-key SSR quirk.** Unrelated to PostHog, but relevant if you copied our `entrypoint.sh` pattern: Clerk bakes the domain from the publishable key into prerendered HTML. If you swap the key at runtime, also swap the domain. (Commit `3157eae6`.)
9. **`identify()` with email as distinct ID.** Use the auth-provider user ID. Emails change; IDs do not.
10. **PostHog Support API.** It is in beta and moves. For ad-hoc bug reports, plain `capture()` plus a dashboard is more durable. (Commit `20938680`.)

---

## 15. File-by-file delta you will be adding

```
.example.env                                   # +2 lines (POSTHOG token + host)
Dockerfile                                     # +2 lines (NEXT_PUBLIC_POSTHOG_* placeholders)
entrypoint.sh                                  # +N lines (sed replacement entries), only if Docker runtime injection
next.config.ts                                 # +rewrites (3 rules) + skipTrailingSlashRedirect
proxy.ts (or middleware.ts)                    # +"/ingest(.*)" to public routes
package.json                                   # +posthog-js, +posthog-node, [+ otel deps if §3]
app/layout.tsx                                 # wrap children in <PHProvider>
components/posthog-provider.tsx                # NEW: client init + provider
components/conditional-layout.tsx              # add posthog.identify() in useEffect
components/posthog/notification-bar.tsx        # NEW (optional)
components/feedback-button.tsx                 # NEW (optional)
lib/posthog-server.ts                          # NEW: server singleton
instrumentation.ts                             # NEW (optional): OTel log shipping
app/actions/*.ts                               # call getPostHogClient().capture(...)
app/api/.../route.ts                           # call evaluateFlags() to gate routes
```

Order of operations when adding from scratch:
1. Install (§1), env vars (§2).
2. `next.config.ts` rewrites + middleware allowlist (§4).
3. `lib/posthog-server.ts` and `components/posthog-provider.tsx` (§5, §7).
4. Wire `PHProvider` in `app/layout.tsx`.
5. `identify()` wherever the user becomes known (§6).
6. Capture events incrementally from each Server Action / button (§7, §10).
7. Feature flags last, once you have something worth gating (§8).
8. Surveys/scripts and OTel logs are independent optionals (§3, §9).
9. Docker entrypoint last, after you confirm everything works in `next dev` (§11).
10. Run the verification checklist (§12).

That is the whole integration. Hand this file to the next agent.
