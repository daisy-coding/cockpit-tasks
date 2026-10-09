export interface FileStamp {
  kind: 'file' | 'dir' | 'other'
  size: number
  mtimeMs: number
  realPath?: string
}

export type StampResult = { kind: 'known'; stamp: FileStamp } | { kind: 'missing' } | { kind: 'unknown' }

export function isStaleRead(read: FileStamp | undefined, current: StampResult): boolean {
  if (!read || current.kind === 'unknown') return false
  if (current.kind === 'missing') return true
  return read.kind !== current.stamp.kind || read.size !== current.stamp.size || read.mtimeMs !== current.stamp.mtimeMs
    || (read.realPath !== undefined && current.stamp.realPath !== undefined && read.realPath !== current.stamp.realPath)
}
