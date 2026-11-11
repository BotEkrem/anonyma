import { useEffect, useState, type ComponentType, type ReactNode } from 'react';

/**
 * A piece that loads on its own (the effects need the animation library), and
 * renders directly once loaded. Unlike React.lazy + Suspense it never holds the
 * plain version for React's reveal delay after the code is already here, and a
 * piece that fails to load simply keeps showing the plain version.
 */
export function lazyPiece<P extends object>(load: () => Promise<{ default: ComponentType<P> }>) {
  let loaded: ComponentType<P> | null = null;
  let pending: Promise<ComponentType<P>> | null = null;

  const preload = (): Promise<ComponentType<P>> =>
    (pending ??= load().then((mod) => {
      loaded = mod.default;
      return mod.default;
    }));

  function Piece({ fallback, ...props }: P & { fallback: ReactNode }) {
    const [Impl, setImpl] = useState<ComponentType<P> | null>(() => loaded);
    useEffect(() => {
      if (Impl) return;
      let alive = true;
      preload()
        .then((c) => {
          if (alive) setImpl(() => c);
        })
        .catch(() => undefined);
      return () => {
        alive = false;
      };
    }, [Impl]);
    return Impl ? <Impl {...(props as P)} /> : <>{fallback}</>;
  }

  return { Piece, preload, isLoaded: () => loaded !== null };
}
