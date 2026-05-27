// The root of the universe (the big bang). Resolved from the cowork-api
// workspace config at runtime. There is no fallback — if the cowork-api is
// unreachable, bigBang() throws and the API route surfaces the error.

const COWORK_API =
  process.env.COWORK_API_URL?.trim() || "http://localhost:5002";
const CONFIG_PATH = "/api/config/workspace";

export async function bigBang(): Promise<string> {
  const url = `${COWORK_API}${CONFIG_PATH}`;
  let res: Response;
  try {
    res = await fetch(url, { cache: "no-store" });
  } catch (e: any) {
    throw new Error(
      `cowork-api unreachable at ${url}: ${e?.message ?? String(e)}`,
    );
  }
  if (!res.ok) {
    throw new Error(
      `cowork-api ${url} returned ${res.status} ${res.statusText}`,
    );
  }
  let json: any;
  try {
    json = await res.json();
  } catch (e: any) {
    throw new Error(
      `cowork-api ${url} returned non-JSON body: ${e?.message ?? String(e)}`,
    );
  }
  const def = json?.default;
  const roots = json?.roots;
  if (
    typeof def !== "string" ||
    !roots ||
    typeof roots !== "object" ||
    typeof roots[def] !== "string"
  ) {
    throw new Error(
      `cowork-api ${url} returned unexpected shape: ${JSON.stringify(json)}`,
    );
  }
  return roots[def];
}
