import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { kadDHT } from '@libp2p/kad-dht'
import { identify } from '@libp2p/identify'
import { bootstrap } from '@libp2p/bootstrap'
import { CID } from 'multiformats/cid'
import * as raw from 'multiformats/codecs/raw'
import { create as digestCreate } from 'multiformats/hashes/digest'
import { hashDescriptorKey } from '@atsearch/common'
import type { Libp2p } from 'libp2p'

export type DhtNode = Libp2p

const SHA2_256_CODE = 0x12

function descriptorToCid(descriptorKey: string): CID {
  const hex = hashDescriptorKey(descriptorKey)
  const bytes = Uint8Array.from(Buffer.from(hex, 'hex'))
  const mh = digestCreate(SHA2_256_CODE, bytes)
  return CID.createV1(raw.code, mh)
}

export async function createDhtNode(opts: {
  listenPort?: number
  bootstrapPeers?: string[]
}): Promise<DhtNode> {
  const bootstrapList = opts.bootstrapPeers ?? []

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const services: any = {
    identify: identify(),
    dht: kadDHT({
      protocol: '/atsearch/kad/1.0.0',
      clientMode: true,
    }),
  }

  if (bootstrapList.length > 0) {
    services.bootstrap = bootstrap({ list: bootstrapList })
  }

  const listenHost = process.env.ATSEARCH_LIBP2P_LISTEN_HOST ?? '127.0.0.1'
  const listenPort = opts.listenPort ?? 0
  const node = await createLibp2p({
    addresses: { listen: [`/ip4/${listenHost}/tcp/${listenPort}`] },
    transports: [tcp()],
    connectionEncryption: [noise()],
    streamMuxers: [yamux()],
    services,
  })

  await node.start()
  return node
}

export async function findProviders(node: DhtNode, descriptorKey: string): Promise<string[]> {
  const cid = descriptorToCid(descriptorKey)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dht = (node.services as any).dht
  if (!dht?.findProviders) return []

  const providers: string[] = []
  try {
    for await (const event of dht.findProviders(cid) as AsyncIterable<unknown>) {
      const e = event as { id?: { toString(): string } }
      if (e.id) providers.push(e.id.toString())
    }
  } catch {
    // no providers found is expected
  }
  return providers
}

export function getNodePeerId(node: DhtNode): string {
  return node.peerId.toString()
}

export async function stopDhtNode(node: DhtNode): Promise<void> {
  await node.stop()
}
