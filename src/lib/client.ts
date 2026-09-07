"use client";

// Tiny fetch helpers for the client components. All API routes return
// JSON; errors surface as thrown Error with the server message.

export async function apiGet<T>(path: string): Promise<T> {
  const r = await fetch(path, { cache: "no-store" });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? `GET ${path} failed (${r.status})`);
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
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? `${method} ${path} failed (${r.status})`);
  return j as T;
}
