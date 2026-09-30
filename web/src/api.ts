import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { LiveEvents, LogLine, StatusView, TranscriptEntry } from '../../src/ui/types.js';

export type * from '../../src/ui/types.js';

/** Log lines kept in the browser for the live run. */
const MAX_LOG_LINES = 5000;

export async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, signal ? { signal } : {});
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

/**
 * Fetch `path` (nothing when null), again whenever `path` or `refresh`
 * changes. Keeps the previous data while reloading, so views do not flash.
 */
export function useJson<T>(path: string | null, refresh: unknown = null) {
  const [state, setState] = useState<{ data: T | null; error: string | null; path: string | null }>({
    data: null,
    error: null,
    path: null,
  });

  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    getJson<T>(path, controller.signal)
      .then((data) => setState({ data, error: null, path }))
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setState((prev) => ({ data: prev.path === path ? prev.data : null, error: (cause as Error).message, path }));
      });
    return () => controller.abort();
  }, [path, refresh]);

  const current = state.path === path;
  return { data: current ? state.data : null, error: current ? state.error : null };
}

export interface LiveState {
  connected: boolean;
  status: StatusView | null;
  log: { runId: string; lines: LogLine[] } | null;
  transcript: { runId: string; iteration: number; entries: TranscriptEntry[] } | null;
}

type LiveAction =
  | { type: 'connected'; value: boolean }
  | { type: 'status'; data: LiveEvents['status'] }
  | { type: 'log'; data: LiveEvents['log'] }
  | { type: 'transcript'; data: LiveEvents['transcript'] };

function reduce(state: LiveState, action: LiveAction): LiveState {
  switch (action.type) {
    case 'connected':
      return { ...state, connected: action.value };
    case 'status':
      return { ...state, status: action.data };
    case 'log': {
      const { runId, reset, lines } = action.data;
      const previous = !reset && state.log?.runId === runId ? state.log.lines : [];
      return { ...state, log: { runId, lines: [...previous, ...lines].slice(-MAX_LOG_LINES) } };
    }
    case 'transcript': {
      const { runId, iteration, reset, entries } = action.data;
      const same = !reset && state.transcript?.runId === runId && state.transcript.iteration === iteration;
      const next = same ? [...state.transcript!.entries] : [];
      const index = new Map(next.map((entry, position) => [entry.id, position]));
      for (const entry of entries) {
        const at = index.get(entry.id);
        if (at === undefined) {
          index.set(entry.id, next.length);
          next.push(entry);
        } else {
          next[at] = entry;
        }
      }
      return { ...state, transcript: { runId, iteration, entries: next } };
    }
  }
}

/**
 * Follow `/api/live`: the status, the latest run's log and the transcript of
 * its iteration in progress. EventSource reconnects on its own, and the
 * server starts every connection with a full snapshot.
 */
export function useLive(): LiveState {
  const [state, dispatch] = useReducer(reduce, { connected: false, status: null, log: null, transcript: null });

  useEffect(() => {
    const source = new EventSource('/api/live');
    source.onopen = () => dispatch({ type: 'connected', value: true });
    source.onerror = () => dispatch({ type: 'connected', value: false });
    for (const name of ['status', 'log', 'transcript'] as const) {
      source.addEventListener(name, (event) => {
        dispatch({ type: name, data: JSON.parse((event as MessageEvent<string>).data) } as LiveAction);
      });
    }
    return () => source.close();
  }, []);

  return state;
}

/** The current time, updated every `ms`, for elapsed-time displays. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

/**
 * Keep a scrolled list pinned to its end while the reader is there, and let
 * them scroll back without being yanked down by new content.
 */
export function useStickToBottom<T extends HTMLElement>(dependency: unknown) {
  const ref = useRef<T>(null);
  const [stuck, setStuck] = useState(true);
  const stuckRef = useRef(true);

  const onScroll = useCallback(() => {
    const element = ref.current;
    if (!element) return;
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
    stuckRef.current = atBottom;
    setStuck(atBottom);
  }, []);

  const jump = useCallback(() => {
    const element = ref.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    stuckRef.current = true;
    setStuck(true);
  }, []);

  useEffect(() => {
    const element = ref.current;
    if (element && stuckRef.current) element.scrollTop = element.scrollHeight;
  }, [dependency]);

  return { ref, stuck, onScroll, jump };
}
