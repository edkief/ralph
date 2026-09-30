export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '–';
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}

export function formatClock(time: string | number | null | undefined): string {
  if (time === null || time === undefined) return '';
  const date = new Date(time);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

export function formatDateTime(time: string | null | undefined): string {
  if (!time) return '–';
  const date = new Date(time);
  if (Number.isNaN(date.getTime())) return '–';
  return date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short', hour12: false });
}

export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined) return '–';
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** A run id (`20260930-120000`) as a readable local date and time. */
export function formatRunId(runId: string): string {
  const match = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(runId);
  if (!match) return runId;
  const [, y, mo, d, h, mi] = match;
  return `${y}-${mo}-${d} ${h}:${mi}`;
}

export type Tone = 'good' | 'warn' | 'bad' | 'live' | 'muted';

/** How a run or iteration status should read at a glance. */
export function statusTone(status: string | null | undefined): Tone {
  switch (status) {
    case 'running':
      return 'live';
    case 'complete':
    case 'progressed':
      return 'good';
    case 'blocked':
    case 'stalled':
    case 'crashed':
    case 'failed':
    case 'provider-error':
      return 'bad';
    case 'decide':
    case 'max-iterations':
    case 'timeout':
    case 'wrapped-up':
    case 'context-overflow':
    case 'stopped':
    case 'interrupted':
      return 'warn';
    default:
      return 'muted';
  }
}

export function statusLabel(status: string | null | undefined): string {
  const text = (status || 'unknown').replace(/-/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}
