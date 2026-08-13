import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-api-gateway/types'
import '@deepseek-ai/dsh-host-apiproxy'
import { mountClientPlane } from '../client/context.js'

export const name = 'tui-client'
export const inject: readonly string[] = ['apiProxy', 'typertGateway']

export async function apply(ctx: Context): Promise<void> {
  await mountClientPlane(ctx, ctx.apiProxy)
}
