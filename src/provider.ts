/** Connector and credential resolution shared by the two host plugins. */
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef, isCredentialRefName, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { resolveCredentialName, resolveEndpoint, type Config, type JevProvider } from './config.js'

export interface ProviderConnection {
  readonly provider: JevProvider
  readonly endpoint: string
  readonly origin: string
  readonly model: string
  readonly keyRef: CredentialRef
  readonly apiKey?: string
}

export function providerConnection(config: Pick<Config, 'provider' | 'endpoint' | 'model' | 'apiKeyEnv' | 'apiKey'>): ProviderConnection {
  const keyName = resolveCredentialName(config)
  if (!isCredentialRefName(keyName)) throw new Error('凭据引用必须是有效的环境变量名。')
  const { endpoint, model } = resolveEndpoint(config)
  return {
    provider: config.provider ?? 'typesafe',
    endpoint,
    model,
    origin: new URL(endpoint).origin,
    keyRef: credentialRef(keyName),
    apiKey: config.apiKey?.trim() || undefined,
  }
}

export type KeySource = 'config' | 'credentials' | 'env' | 'none'

export async function providerCredential(ctx: Context, connection: ProviderConnection): Promise<{ key?: string; source: KeySource }> {
  if (connection.apiKey !== undefined) return { key: connection.apiKey, source: 'config' }
  const credentials = ctx.get('credentials')
  if (credentials !== undefined) {
    // The credential service owns the full lookup when present, including its environment layers.
    const result = await credentials.resolve(connection.keyRef)
    if (!result?.value) return { source: 'none' }
    const source = result.source === 'env' || result.source.endsWith('-env') ? 'env' : 'credentials'
    return { key: result.value, source }
  }
  const key = launchEnvironmentOf(ctx).get(connection.keyRef)?.value
  return key ? { key, source: 'env' } : { source: 'none' }
}
