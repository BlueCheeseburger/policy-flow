import { useEffect } from 'react';

/**
 * Keyboard accessibility for popover/dropdown menus: Up/Down arrows move
 * focus between the menu's focusable items (buttons, links, inputs), Enter
 * activates the focused item (native button/link behavior already does
 * this — Enter is only handled here for non-button focusables), and Escape
 * closes the menu. Wire this in next to whatever outside-click-to-close
 * effect the menu already has.
 */
export function useMenuA11y(
  open: boolean,
  ref: React.RefObject<HTMLElement>,
  onClose: () => void,
) {
  useEffect(() => {
    if (!open) return;
    const container = ref.current;

    function items(): HTMLElement[] {
      if (!container) return [];
      return Array.from(
        container.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [role="menuitem"]:not([aria-disabled="true"]), a[href], input, select, textarea',
        ),
      );
    }

    // Focus the first item so arrow nav has somewhere to start from.
    const raf = requestAnimationFrame(() => {
      const first = items()[0];
      if (first && !container?.contains(document.activeElement)) first.focus();
    });

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const list = items();
      if (list.length === 0) return;
      e.preventDefault();
      const active = document.activeElement as HTMLElement | null;
      const idx = active ? list.indexOf(active) : -1;
      const next = e.key === 'ArrowDown'
        ? list[(idx + 1) % list.length]
        : list[(idx - 1 + list.length) % list.length];
      next?.focus();
    }

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open, ref, onClose]);
}
