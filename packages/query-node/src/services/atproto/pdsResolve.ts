export async function resolvePds(did: string): Promise<string | null> {
  try {
    if (did.startsWith('did:web:')) {
      const domain = did.replace('did:web:', '')
      const res = await fetch(`https://${domain}/.well-known/did.json`, {
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) return null
      const doc = (await res.json()) as { service?: Array<{ type: string; serviceEndpoint: string }> }
      return extractAtprotoEndpoint(doc.service)
    }

    if (did.startsWith('did:plc:')) {
      const res = await fetch(`https://plc.directory/${encodeURIComponent(did)}`, {
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) return null
      const doc = (await res.json()) as { service?: Array<{ type: string; serviceEndpoint: string }> }
      return extractAtprotoEndpoint(doc.service)
    }

    return null
  } catch {
    return null
  }
}

function extractAtprotoEndpoint(
  services?: Array<{ type: string; serviceEndpoint: string }>,
): string | null {
  if (!services) return null
  const svc = services.find((s) => s.type === 'AtprotoPersonalDataServer')
  return svc?.serviceEndpoint?.replace(/\/$/, '') ?? null
}
