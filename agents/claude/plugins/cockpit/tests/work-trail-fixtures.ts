export const START_REVISION = 'a'.repeat(40)
export const LATER_REVISION = 'b'.repeat(40)
export const WORK_LOG = 'abc1234\tИсправить восстановление задачи\0\ndef5678\tДобавить раздел следа\0\n'
export const WORK_DIFF = 'hooks/register.tsx\0hooks/domain/work-trail.ts\0'
export const WORK_STATUS = ' M hooks/register.tsx\0?? tests/work-trail.test.ts\0'

export interface GitFixture {
  head?: string
  log?: string
  diff?: string
  status?: string
  nonGit?: boolean
  truncated?: boolean
  error?: boolean
}

export function gitReply(argv: readonly string[], fixture: GitFixture) {
  const stdout = argv.includes('rev-parse') ? fixture.head ?? START_REVISION
    : argv.includes('log') ? fixture.log ?? WORK_LOG
      : argv.includes('diff') ? fixture.diff ?? WORK_DIFF : fixture.status ?? WORK_STATUS
  return { value: { exitCode: fixture.nonGit ? 128 : fixture.error ? 1 : 0, stdout: fixture.nonGit ? '' : stdout,
    stderr: fixture.nonGit ? 'fatal: not a git repository' : '', isStdoutTruncated: fixture.truncated ?? false, isStderrTruncated: false } }
}
