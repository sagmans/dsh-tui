import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'vitest'

const MANIFEST_URL = new URL('../../docs/parity.json', import.meta.url)
const TEST_ROOT_URL = new URL('../../', import.meta.url)
const NATIVE_PROOF_PATTERN = /-native\.test\.ts$/u
const PENDING_STATUS = 'missing'

interface Capability {
  readonly id: string
  readonly classification: 'parity' | 'terminal-alternative' | 'web-only'
  readonly automatedProof: readonly string[]
  readonly status: 'complete' | 'partial' | 'missing' | 'excluded'
}

interface Manifest {
  readonly capabilities: readonly Capability[]
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null
}

function isCapability(value: unknown): value is Capability {
  if (!isRecord(value) || !Array.isArray(value.automatedProof)) return false
  return typeof value.id === 'string'
    && (value.classification === 'parity'
      || value.classification === 'terminal-alternative'
      || value.classification === 'web-only')
    && value.automatedProof.every(proof => typeof proof === 'string')
    && (value.status === 'complete'
      || value.status === 'partial'
      || value.status === 'missing'
      || value.status === 'excluded')
}

function manifest(): Manifest {
  const value: unknown = JSON.parse(readFileSync(MANIFEST_URL, 'utf8'))
  assert.ok(isRecord(value) && Array.isArray(value.capabilities))
  assert.equal(value.capabilities.every(capability => isCapability(capability)), true)
  return { capabilities: value.capabilities.filter(capability => isCapability(capability)) }
}

test('keeps every terminal flow attached to executable and native proof', () => {
  const capabilities = manifest().capabilities.filter(capability => capability.classification !== 'web-only')

  assert.ok(capabilities.length > 0)
  for (const capability of capabilities) {
    assert.notEqual(capability.status, PENDING_STATUS, capability.id)
    assert.ok(capability.automatedProof.length > 0, `${capability.id}: automated proof`)
    for (const proof of capability.automatedProof) {
      assert.equal(existsSync(new URL(proof, TEST_ROOT_URL)), true, `${capability.id}: ${proof}`)
    }
    assert.equal(
      capability.automatedProof.some(proof => NATIVE_PROOF_PATTERN.test(proof)),
      true,
      `${capability.id}: native keyboard/mouse proof`,
    )
  }
})
