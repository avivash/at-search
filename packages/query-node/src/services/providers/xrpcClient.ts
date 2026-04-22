export async function xrpcGet<T>(
  baseUrl: string,
  method: string,
  query: Record<string, string | number | boolean | undefined>,
  userAgent: string,
  timeoutMs = 12_000,
): Promise<T> {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue
    q.set(k, String(v))
  }
  const url = `${baseUrl.replace(/\/$/, '')}/xrpc/${method}?${q.toString()}`
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': userAgent },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`XRPC ${method} HTTP ${res.status}: ${text.slice(0, 200)}`)
  }
  return res.json() as Promise<T>
}
