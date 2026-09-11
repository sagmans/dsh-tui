import { describe, expect, it, vi } from 'vitest'
import { createRestoreRegistry } from '@/terminal/restore.ts'

describe('createRestoreRegistry', () => {
  it('runs hooks once, in reverse order', () => {
    const registry = createRestoreRegistry()
    const order: string[] = []
    registry.add(() => order.push('first'))
    registry.add(() => order.push('second'))
    registry.restore()
    registry.restore()
    expect(order).toEqual(['second', 'first'])
  })

  it('keeps running hooks when one throws', () => {
    const registry = createRestoreRegistry()
    const survivor = vi.fn()
    registry.add(survivor)
    registry.add(() => {
      throw new Error('broken hook')
    })
    expect(() => registry.restore()).not.toThrow()
    expect(survivor).toHaveBeenCalledOnce()
  })

  it('drops a hook that was explicitly removed', () => {
    const registry = createRestoreRegistry()
    const hook = vi.fn()
    const remove = registry.add(hook)
    remove()
    expect(registry.size).toBe(0)
    registry.restore()
    expect(hook).not.toHaveBeenCalled()
  })

  it('runs a hook registered after release immediately', () => {
    const registry = createRestoreRegistry()
    registry.restore()
    const late = vi.fn()
    registry.add(late)
    expect(late).toHaveBeenCalledOnce()
  })
})
