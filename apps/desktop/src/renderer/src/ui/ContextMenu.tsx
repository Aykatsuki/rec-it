import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronRight, Check } from 'lucide-react';
import { create } from 'zustand';

export type MenuEntry =
  | {
      label: string;
      onSelect?: () => void;
      shortcut?: string;
      icon?: ReactNode;
      disabled?: boolean;
      danger?: boolean;
      /** Shows a tick; the item is a toggle. */
      checked?: boolean;
      submenu?: MenuEntry[];
    }
  | { separator: true }
  | null
  | false
  | undefined;

interface MenuState {
  open: { x: number; y: number; entries: MenuEntry[] } | null;
}
const useMenu = create<MenuState>(() => ({ open: null }));

/** Opens a context menu at the pointer. Falsy entries are skipped, so menus can use `cond && {...}`. */
export function openContextMenu(
  e: { clientX: number; clientY: number; preventDefault(): void; stopPropagation?(): void },
  entries: MenuEntry[],
): void {
  e.preventDefault();
  e.stopPropagation?.();
  useMenu.setState({ open: { x: e.clientX, y: e.clientY, entries } });
}

export function closeContextMenu(): void {
  useMenu.setState({ open: null });
}

type Item = Exclude<MenuEntry, null | false | undefined | { separator: true }>;
const isItem = (e: MenuEntry): e is Item => !!e && !('separator' in e);

/** Removes leading, trailing and doubled separators left over after conditional entries. */
function tidy(entries: MenuEntry[]): Exclude<MenuEntry, null | false | undefined>[] {
  const out: Exclude<MenuEntry, null | false | undefined>[] = [];
  for (const e of entries) {
    if (!e) continue;
    if ('separator' in e && (!out.length || 'separator' in out.at(-1)!)) continue;
    out.push(e);
  }
  while (out.length && 'separator' in out.at(-1)!) out.pop();
  return out;
}

function MenuList({
  entries,
  x,
  y,
  level,
}: {
  entries: MenuEntry[];
  x: number;
  y: number;
  level: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [active, setActive] = useState(-1);
  const [sub, setSub] = useState<{ index: number; x: number; y: number } | null>(null);
  const list = tidy(entries);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const nx =
      x + r.width > window.innerWidth - 4
        ? Math.max(4, level ? x - r.width - 180 : x - r.width)
        : x;
    const ny =
      y + r.height > window.innerHeight - 4 ? Math.max(4, window.innerHeight - r.height - 4) : y;
    setPos({ x: nx, y: ny });
    if (level === 0) el.focus();
  }, [x, y, level]);

  const choose = (item: Item) => {
    if (item.disabled || item.submenu) return;
    closeContextMenu();
    item.onSelect?.();
  };

  const openSub = (index: number, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setSub({ index, x: r.right - 2, y: r.top - 4 });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const enabled = list
      .map((entry, i) => (isItem(entry) && !entry.disabled ? i : -1))
      .filter((i) => i >= 0);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const at = enabled.indexOf(active);
      const next =
        e.key === 'ArrowDown'
          ? enabled[(at + 1) % enabled.length]
          : enabled[(at - 1 + enabled.length) % enabled.length];
      setActive(next ?? -1);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const item = list[active];
      if (item && isItem(item)) {
        if (item.submenu) {
          const el = ref.current?.children[active] as HTMLElement | undefined;
          if (el) openSub(active, el);
        } else choose(item);
      }
    } else if (e.key === 'ArrowRight') {
      const item = list[active];
      const el = ref.current?.children[active] as HTMLElement | undefined;
      if (item && isItem(item) && item.submenu && el) openSub(active, el);
    } else if (e.key === 'Escape' || (e.key === 'ArrowLeft' && level > 0)) {
      e.preventDefault();
      e.stopPropagation();
      closeContextMenu();
    }
  };

  const subEntry = sub ? list[sub.index] : undefined;
  return (
    <>
      <div
        ref={ref}
        className="ctx"
        role="menu"
        tabIndex={-1}
        data-testid={level === 0 ? 'context-menu' : 'context-submenu'}
        style={{ left: pos.x, top: pos.y }}
        onKeyDown={onKeyDown}
        onContextMenu={(e) => e.preventDefault()}
      >
        {list.map((entry, i) => {
          if (!isItem(entry)) return <div key={i} className="ctx__sep" role="separator" />;
          return (
            <button
              key={i}
              type="button"
              role={entry.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'}
              aria-checked={entry.checked}
              aria-haspopup={entry.submenu ? 'menu' : undefined}
              aria-label={entry.label}
              className={`ctx__item${entry.danger ? ' ctx__item--danger' : ''}${active === i ? ' is-active' : ''}`}
              disabled={entry.disabled}
              onMouseEnter={(e) => {
                setActive(i);
                if (entry.submenu) openSub(i, e.currentTarget);
                else setSub(null);
              }}
              onClick={(e) => (entry.submenu ? openSub(i, e.currentTarget) : choose(entry))}
            >
              <span className="ctx__icon">{entry.checked ? <Check size={13} /> : entry.icon}</span>
              <span className="ctx__label">{entry.label}</span>
              {entry.shortcut && <kbd className="ctx__kbd">{entry.shortcut}</kbd>}
              {entry.submenu && <ChevronRight size={13} className="ctx__more" />}
            </button>
          );
        })}
      </div>
      {sub && subEntry && isItem(subEntry) && subEntry.submenu && (
        <MenuList entries={subEntry.submenu} x={sub.x} y={sub.y} level={level + 1} />
      )}
    </>
  );
}

export function ContextMenuHost() {
  const open = useMenu((s) => s.open);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e.target instanceof Node && (e.target as Element).closest?.('.ctx')) return;
      closeContextMenu();
    };
    const closeNow = () => closeContextMenu();
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('wheel', close, true);
    window.addEventListener('resize', closeNow);
    window.addEventListener('blur', closeNow);
    return () => {
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('wheel', close, true);
      window.removeEventListener('resize', closeNow);
      window.removeEventListener('blur', closeNow);
    };
  }, [open]);
  if (!open) return null;
  return (
    <div className="ctx-layer">
      <MenuList
        key={`${open.x},${open.y}`}
        entries={open.entries}
        x={open.x}
        y={open.y}
        level={0}
      />
    </div>
  );
}
