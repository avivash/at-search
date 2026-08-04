import { readMicrocosmEnv, type MicrocosmEnv } from './env.js'
import { RecordService } from './atproto/RecordService.js'
import { IdentityService } from './atproto/IdentityService.js'
import { BacklinkService } from './graph/BacklinkService.js'
import { LexiconPlanCache } from './lexiconPlans.js'

export interface AppServices {
  env: MicrocosmEnv
  record: RecordService
  identity: IdentityService
  backlinks: BacklinkService
  plans: LexiconPlanCache
}

export function createServices(): AppServices {
  const env = readMicrocosmEnv()
  const plans = new LexiconPlanCache(env.indexerUrls, {
    onRefresh: (n) => console.log(`[plans] mirrored ${n} extraction plans`),
  })
  const record = new RecordService(env, plans.lookup)
  const identity = new IdentityService(env)
  const backlinks = new BacklinkService(env, record)
  return { env, record, identity, backlinks, plans }
}
