"use client";

// Tiny fetch helpers for the client components. All API routes return
// JSON; errors surface as thrown Error with the server message.

export async function apiGet<T>(path: string): Promise<T> {
  const r = await fetch(path, { cache: "no-store" });
  const j = await readJson(r);
  if (!r.ok) throw new Error(typeof j.error === "string" ? j.error : `GET ${path} failed (${r.status})`);
  return j as T;
}

export async function apiSend<T>(
  path: string,
  method: "POST" | "PATCH",
  body?: unknown,
): Promise<T> {
  const r = await fetch(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await readJson(r);
  if (!r.ok) throw new Error(typeof j.error === "string" ? j.error : `${method} ${path} failed (${r.status})`);
  return j as T;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { error: text.slice(0, 300) || `Request failed (${response.status})` };
  }
}
