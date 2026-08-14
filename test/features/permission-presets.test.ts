import assert from 'node:assert/strict'
import { test } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import { projectConfiguration } from '../../src/features/settings/projection.js'

// Static fixture identity crosses only the Harness brand boundary.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const SESSION_ID = 'permission-session' as SessionId

test('labels current and future permission lifetimes independently', () => {
  const projected = projectConfiguration({
    data: {
      credentials: undefined,
      discoveredModels: new Map(),
      extensions: undefined,
      models: undefined,
      plugins: undefined,
      presetContents: new Map(),
      presets: undefined,
      providers: undefined,
      settings: {
        hasDocument: false,
        namespaces: [{
          applies: 'live',
          ns: 'permission',
          revision: 2,
          schema: {},
          secrets: [],
          value: { defaultPreset: 'workspace-write' },
        }],
        writable: true,
      },
    },
    list: {
      current: SESSION_ID,
      byId: {
        [SESSION_ID]: {
          blank: false,
          projectionValues: {
            permissions: {
              currentValue: 'read-only',
              options: [
                { name: 'Read Only', value: 'read-only' },
                { name: 'Workspace Write', value: 'workspace-write' },
              ],
            },
          },
        },
      },
    },
    section: 'access',
  })

  assert.equal(projected.rows.find(row => row.id === 'access:read-only')?.summary, 'current session')
  assert.equal(projected.rows.find(row => row.id === 'access-default:workspace-write')?.summary, 'default · new sessions')
  assert.deepEqual(
    projected.rows.find(row => row.id === 'access-default:read-only')?.actions.map(action => action.id),
    ['access.default'],
  )
})
