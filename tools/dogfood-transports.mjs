/** Native supplements own availability and reporting so portable assertions cannot silently stand in for another transport. */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ENABLED = '1'
const DEADLINE_MS = 15 * 60 * 1000
const PROBE_DEADLINE_MS = 10_000
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024
const EVIDENCE = /evidence (\S+)/u
const TMUX_SCENARIO = 'tmux-compatibility'
const PAID_REASON = 'Paid verification runs only the explicitly selected scenario.'

/** Exit status and independently serialized cleanup must agree before another transport adds evidence. */
function collect(result, label) {
  process.stdout.write(result.stdout ?? '')
  process.stderr.write(result.stderr ?? '')
  const path = EVIDENCE.exec(result.stdout ?? '')?.[1]
  if (path === undefined) throw new Error('dogfood: ' + label + ' evidence path missing')
  const report = JSON.parse(readFileSync(join(path, 'report.json'), 'utf8'))
  if (result.error || result.status !== 0 || report.cleanup !== 'verified') throw new Error('dogfood: ' + label + ' gate failed; evidence ' + path)
  return { ...report, status: 'passed', evidence: path }
}

/** Only free, available supplements run automatically; selected cases and paid authorization keep their existing bounds. */
export function runFreeTransports({ root, paid, portableFailed, scenario, launcher }) {
  const reports = {
    herdr: { status: 'environment-not-run', reason: 'Requires HERDR_ENV=1 and the installed Herdr CLI.' },
    tmux: { status: 'environment-not-run', reason: 'Requires an installed tmux CLI.' },
  }
  if (paid || portableFailed) {
    for (const name of Object.keys(reports)) reports[name] = { status: paid ? 'paid-not-run' : 'not-run', reason: paid ? PAID_REASON : 'Portable profile verification failed first.' }
    return reports
  }
  if (process.env.HERDR_ENV === ENABLED) {
    try {
      const runner = join(root, 'tools/dogfood-herdr.mjs')
      const list = spawnSync(process.execPath, [runner, '--list'], { encoding: 'utf8', timeout: DEADLINE_MS, maxBuffer: MAX_OUTPUT_BYTES })
      if (list.error || list.status !== 0) throw new Error('dogfood: Herdr scenario discovery failed')
      if (scenario === undefined || list.stdout.trim().split('\n').includes(scenario)) {
        const args = [runner]
        if (scenario !== undefined) args.push('--scenario', scenario)
        if (launcher !== undefined) args.push('--launcher', launcher)
        reports.herdr = collect(spawnSync(process.execPath, args, { encoding: 'utf8', timeout: DEADLINE_MS, maxBuffer: MAX_OUTPUT_BYTES }), 'Herdr')
      } else reports.herdr = { status: 'not-selected-on-herdr', reason: 'Selected scenario belongs to the portable transport.' }
    } catch (error) { reports.herdr = { status: 'failed', error: error.message }; process.exitCode = 1 }
  }
  const probe = spawnSync('tmux', ['-V'], { encoding: 'utf8', timeout: PROBE_DEADLINE_MS })
  if (probe.error?.code !== 'ENOENT') {
    try {
      if (probe.error || probe.status !== 0) throw new Error('dogfood: installed tmux version probe failed')
      if (scenario === undefined || scenario === TMUX_SCENARIO) {
        const args = [join(root, 'tools/dogfood-tmux.mjs')]
        if (launcher !== undefined) args.push('--launcher', launcher)
        reports.tmux = collect(spawnSync(process.execPath, args, { encoding: 'utf8', timeout: DEADLINE_MS, maxBuffer: MAX_OUTPUT_BYTES }), 'tmux')
      } else reports.tmux = { status: 'not-selected-on-tmux', reason: 'Selected scenario belongs to the portable transport.' }
    } catch (error) { reports.tmux = { status: 'failed', error: error.message }; process.exitCode = 1 }
  }
  return reports
}
