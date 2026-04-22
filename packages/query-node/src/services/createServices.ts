import { readMicrocosmEnv, type MicrocosmEnv } from './env.js'
import { RecordService } from './atproto/RecordService.js'
import { IdentityService } from './atproto/IdentityService.js'
import { BacklinkService } from './graph/BacklinkService.js'

export interface AppServices {
  env: MicrocosmEnv
  record: RecordService
  identity: IdentityService
  backlinks: BacklinkService
}

export function createServices(): AppServices {
  const env = readMicrocosmEnv()
  const record = new RecordService(env)
  const identity = new IdentityService(env)
  const backlinks = new BacklinkService(env, record)
  return { env, record, identity, backlinks }
}
