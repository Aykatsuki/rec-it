import {
  useEffect,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ');

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
  icon?: ReactNode;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  className,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      className={cx(
        'ui-btn',
        variant !== 'secondary' && `ui-btn--${variant}`,
        size === 'sm' && 'ui-btn--sm',
        className,
      )}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required: icon-only buttons need an accessible name. Also shown as a tooltip. */
  label: string;
  size?: 'sm' | 'md';
}

export function IconButton({ label, size = 'md', className, children, ...rest }: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cx('ui-icon-btn', size === 'sm' && 'ui-icon-btn--sm', className)}
      {...rest}
    >
      {children}
    </button>
  );
}

export interface TabItem<T extends string> {
  id: T;
  label: string;
}

/** Accessible tab list with arrow-key navigation. */
export function Tabs<T extends string>({
  items,
  value,
  onChange,
  label,
  className,
}: {
  items: readonly TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  label: string;
  className?: string;
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = items.findIndex((i) => i.id === value);
    const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!delta) return;
    event.preventDefault();
    const next = items[(index + delta + items.length) % items.length];
    if (next) onChange(next.id);
  };
  return (
    <div
      role="tablist"
      aria-label={label}
      className={cx('ui-tabs', className)}
      onKeyDown={onKeyDown}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          className="ui-tab"
          aria-selected={item.id === value}
          tabIndex={item.id === value ? 0 : -1}
          onClick={() => onChange(item.id)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

export type DotState = 'ok' | 'warn' | 'error' | 'missing' | 'checking';

export function StatusDot({ state, label }: { state: DotState; label?: string }) {
  return (
    <span
      className="ui-status-dot"
      data-state={state}
      role={label ? 'img' : undefined}
      aria-label={label}
    />
  );
}

export function EmptyState({
  icon,
  title,
  children,
  action,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="ui-empty">
      {icon && <div className="ui-empty__icon">{icon}</div>}
      <p className="ui-empty__title">{title}</p>
      {children && <p className="ui-empty__body">{children}</p>}
      {action && <div className="ui-empty__action">{action}</div>}
    </div>
  );
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'accent';
}) {
  return (
    <span className={cx('ui-badge', tone === 'accent' && 'ui-badge--accent')}>{children}</span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="ui-kbd">{children}</kbd>;
}

export function TextField(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx('ui-input', props.className)} />;
}

/** Modal dialog built on the native <dialog> element (focus trapping and Esc handling for free). */
export function Dialog({
  open,
  onClose,
  title,
  children,
  closeLabel = 'Close',
  closeIcon,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  closeLabel?: string;
  closeIcon?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog ref={ref} className="ui-dialog" aria-label={title} onClose={onClose}>
      <header className="ui-dialog__header">
        <h2 className="ui-dialog__title">{title}</h2>
        <IconButton label={closeLabel} onClick={onClose}>
          {closeIcon ?? '×'}
        </IconButton>
      </header>
      <div className="ui-dialog__body">{open && children}</div>
    </dialog>
  );
}
