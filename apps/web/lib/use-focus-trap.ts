import { useEffect, useRef } from 'react';

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])';

/**
 * Pure Tab-wrap core. Given the focusable count, the current index, and whether
 * Shift is held, returns the index to focus when the trap must wrap around, or
 * null when no wrap is needed (let the browser move focus normally).
 */
export function wrapTabIndex(count: number, currentIndex: number, shiftKey: boolean): number | null {
  if (count === 0) return null;
  if (shiftKey && currentIndex <= 0) return count - 1;
  if (!shiftKey && currentIndex === count - 1) return 0;
  return null;
}

export function useFocusTrap(active: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!active) return;
    const container = ref.current;
    if (!container) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const focusables = () => Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE));
    (focusables()[0] ?? container).focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Tab') return;
      const items = focusables();
      const currentIndex = items.indexOf(document.activeElement as HTMLElement);
      const target = wrapTabIndex(items.length, currentIndex, e.shiftKey);
      if (target !== null) {
        e.preventDefault();
        items[target]!.focus();
      }
    }

    container.addEventListener('keydown', onKeyDown);
    return () => {
      container.removeEventListener('keydown', onKeyDown);
      previouslyFocused?.focus?.();
    };
  }, [active]);
  return ref;
}
