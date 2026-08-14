import type {
  ConfigurationActionView,
  ConfigurationExtensionRow,
  ConfigurationPluginEntry,
  ConfigurationRowState,
  ConfigurationRowView,
} from './contracts.js'
import {
  CONFIGURATION_ACTIONS,
  type ConfigurationProjectionContext,
} from './projection-types.js'
import { sanitizeConversationText } from '../conversation/projection.js'
import { sanitizeText } from '../sessions/projection.js'

function pluginState(plugin: ConfigurationPluginEntry): ConfigurationRowState {
  if (!plugin.enabled) return 'warning'
  switch (plugin.fiberPhase) {
    case 'active': return 'success'
    case 'failed': return 'error'
    case 'loading':
    case 'pending':
    case 'unloading': return 'running'
    case null: return 'idle'
    default: {
      const exhaustive: never = plugin.fiberPhase
      return exhaustive
    }
  }
}

export function pluginRows(context: ConfigurationProjectionContext): readonly ConfigurationRowView[] {
  return (context.data.plugins ?? []).map((plugin): ConfigurationRowView => {
    const id = `plugin:${plugin.entryId}`
    context.targets.set(id, { kind: 'plugin' })
    return {
      actions: [],
      details: `entry ${sanitizeText(plugin.entryId)}\nmodule ${sanitizeText(plugin.moduleName)}`,
      id,
      state: pluginState(plugin),
      summary: `${plugin.enabled ? 'enabled' : 'disabled'} · ${plugin.fiberPhase ?? 'inactive'}`,
      title: sanitizeText(plugin.entryId),
    }
  })
}

function extensionState(plugin: ConfigurationExtensionRow, packageId: string): ConfigurationRowState {
  if (plugin.latestRun?.packageId !== packageId) return plugin.currentPackageId === packageId ? 'success' : 'idle'
  switch (plugin.latestRun.status) {
    case 'running': return 'success'
    case 'awaiting-approval':
    case 'starting-host':
    case 'client-pending':
    case 'waiting': return 'running'
    case 'failed': return 'error'
    case 'rejected':
    case 'cancelled':
    case 'stopped': return 'warning'
    default: {
      const exhaustive: never = plugin.latestRun.status
      return exhaustive
    }
  }
}

export function extensionRows(context: ConfigurationProjectionContext): readonly ConfigurationRowView[] {
  return (context.data.extensions ?? []).flatMap(plugin => plugin.packages.map((pkg): ConfigurationRowView => {
    const id = `extension:${plugin.pluginId}:${pkg.packageId}`
    const owned = context.current !== undefined && plugin.agentId === context.current
    const mode = plugin.currentPackageId !== undefined && plugin.currentPackageId !== pkg.packageId ? 'update' : 'run'
    context.targets.set(id, { kind: 'extension', mode, owned, package: pkg, plugin })
    const actions: ConfigurationActionView[] = []
    const transition = plugin.latestRun?.status === 'awaiting-approval'
      || plugin.latestRun?.status === 'starting-host'
      || plugin.latestRun?.status === 'client-pending'
    if (owned && pkg.hasHostHalf && !pkg.hasClientHalf && !transition) actions.push(CONFIGURATION_ACTIONS.extensionRun)
    if (owned && plugin.activeRun !== undefined) actions.push(CONFIGURATION_ACTIONS.extensionStop)
    if (owned) actions.push(CONFIGURATION_ACTIONS.extensionRemove)
    return {
      actions,
      details: sanitizeConversationText([
        pkg.purpose,
        `owner ${plugin.agentId}`,
        `package ${pkg.packageId}`,
        `host half ${pkg.hasHostHalf ? 'present' : 'absent'}`,
        pkg.hasClientHalf
          ? 'Browser client half is unsupported in this terminal.'
          : 'No browser client half.',
        plugin.latestRun?.packageId === pkg.packageId ? `latest ${plugin.latestRun.status}` : undefined,
        plugin.latestRun?.packageId === pkg.packageId ? plugin.latestRun.error?.message : undefined,
      ].filter(part => part !== undefined).join('\n')),
      id,
      state: extensionState(plugin, pkg.packageId),
      summary: `${owned ? 'current session' : 'other session'} · ${pkg.hasClientHalf ? 'browser required' : 'host only'}`,
      title: sanitizeConversationText(pkg.name),
    }
  }))
}
