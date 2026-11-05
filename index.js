// dsh-deliver-check — DeepSeek Harness (DSH) 插件
// 工具 deliver_check：AI 交付预检闸门，退出码裁决（模型只转述，无权改判）。
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineTool } from '@deepseek-ai/dsh-tools'

const execFileAsync = promisify(execFile)
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'scripts', 'deliver-check.mjs')

export const name = 'deliver-check'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'deliver_check',
    description:
      'Deterministic deliver pre-flight gate for AI code changes. Scans the project\'s ' +
      'uncommitted git changes (or explicit files) for delivery blockers: debug leftovers ' +
      '(console.log/debugger/print), todo/fixme markers, not-implemented throws, hardcoded ' +
      'credentials, placeholder text. ' +
      'Exit-code verdict — the single source of truth, never re-interpret it: ' +
      '0 = PASS (deliverable, zero blockers); ' +
      '1 = FAIL (at least one blocker — you MUST fix EVERY reported line, then re-run this tool ' +
      'until it returns exit code 0 before delivering anything); ' +
      '2 = UNVERIFIED (cannot judge: no checkable files, or paid cloud rules not obtained) — ' +
      'NEVER treat UNVERIFIED as PASS and never deliver on it. ' +
      'If the output contains a 402 / [payment-required] section, relay the payment instructions ' +
      'to the user verbatim and do NOT bypass, simulate, or pay on the user\'s behalf.',
    parameters: {
      projectDir: { type: 'string', required: true, description: 'Absolute path of the project root to scan (the check script runs with cwd set here).' },
      paths: { type: 'array', items: { type: 'string' }, description: 'Optional explicit file paths (relative to projectDir) to scan instead of git changes.' },
      staged: { type: 'boolean', description: 'Only scan git-staged files (default false = all uncommitted changes incl. untracked).' },
      allow: { type: 'string', description: 'Optional case-insensitive regex; lines matching it are exempted (e.g. "logger\\\\.log").' },
      offline: { type: 'boolean', description: 'Offline mode: built-in free rules only, no network request for the paid cloud rule pack.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const argv = [SCRIPT]
      if (args.staged) argv.push('--staged')
      if (args.allow) argv.push('--allow', String(args.allow))
      if (args.offline) argv.push('--off')
      if (Array.isArray(args.paths) && args.paths.length > 0) argv.push(...args.paths.map(String))

      let stdout = ''
      let stderr = ''
      let code = 0
      try {
        const r = await execFileAsync(process.execPath, argv, {
          cwd: args.projectDir,
          timeout: 60_000,
          maxBuffer: 4 * 1024 * 1024,
        })
        stdout = r.stdout || ''
        stderr = r.stderr || ''
      } catch (err) {
        // 非零退出（FAIL/UNVERIFIED）、超时被杀、脚本缺失——都把原始输出与裁决码原样带回
        stdout = typeof err.stdout === 'string' ? err.stdout : ''
        stderr = typeof err.stderr === 'string' ? err.stderr : ''
        code = typeof err.code === 'number' ? err.code : 2
      }
      const text = `${stdout}${stderr ? (stdout && !stdout.endsWith('\n') ? '\n' : '') + stderr : ''}\nEXIT CODE: ${code}`
      return text
    },
  }))
}
