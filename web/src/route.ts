import { useEffect, useState } from 'react';

export const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'transcript', label: 'Transcript' },
  { id: 'logs', label: 'Logs' },
  { id: 'files', label: 'Files' },
] as const;

export type TabId = (typeof TABS)[number]['id'];

/** `#/files/.ralph/prd/PRD.md` → tab `files`, rest `.ralph/prd/PRD.md`. */
function parseHash(hash: string): { tab: TabId; rest: string } {
  const [tab = '', ...rest] = hash.replace(/^#\/?/, '').split('/');
  const known = TABS.some((entry) => entry.id === tab);
  return { tab: known ? (tab as TabId) : 'overview', rest: known ? rest.map(decodeURIComponent).join('/') : '' };
}

export function href(tab: TabId, rest = ''): string {
  return `#/${tab}${rest ? `/${rest.split('/').map(encodeURIComponent).join('/')}` : ''}`;
}

/** The view picked in the URL's hash, so views can be linked and survive a reload. */
export function useRoute() {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}
