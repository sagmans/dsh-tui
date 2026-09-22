import { join } from 'node:path'
import { builtinThemesDir, loadThemes, type ThemeLibrary } from '@/theme-files.ts'

/**
 * The themes the package ships, and no reader's own.
 *
 * A spec that wants a directory of its own builds one; one that only needs the
 * shipped names should not have to create and clean up a directory to say so,
 * and the home here is deliberately a path nothing is ever written to.
 */
export function builtinLibrary(): ThemeLibrary {
  const builtins = builtinThemesDir()
  return loadThemes(join(builtins, '.no-reader-themes'), builtins)
}
