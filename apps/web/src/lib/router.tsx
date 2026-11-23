import { useEffect, useState, type ReactNode, type MouseEvent } from 'react';

// Hash routing (#/items, #/reports/stock?item=...) works on GitHub Pages and
// inside the desktop and mobile wrappers without server rewrites.

export type Route = { path: string; segments: string[]; query: URLSearchParams };

function readRoute(): Route {
  const raw = window.location.hash.replace(/^#/, '') || '/';
  const [path, qs = ''] = raw.split('?');
  const clean = path.startsWith('/') ? path : `/${path}`;
  return { path: clean, segments: clean.split('/').filter(Boolean), query: new URLSearchParams(qs) };
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(readRoute);
  useEffect(() => {
    const onChange = () => setRoute(readRoute());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export function navigate(to: string) {
  window.location.hash = to;
}

export function Link({ to, className, children, title }: { to: string; className?: string; children: ReactNode; title?: string }) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    navigate(to);
  };
  return (
    <a href={`#${to}`} onClick={onClick} className={className} title={title}>
      {children}
    </a>
  );
}
