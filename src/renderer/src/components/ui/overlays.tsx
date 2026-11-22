import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../../i18n/useT';
import { Button, ColorDot, IconButton } from './controls';
import { Icon } from './icons';
import type { MenuButtonProps, ModalProps, MultiSelectProps, PopoverProps } from './types';

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

function focusablesIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
}

// ───────────────────────────── Escape handling ─────────────────────────────
// Dialogs and popovers stack. Escape always belongs to the top-most one only.

interface Layer {
  onEscape: () => void;
}

const layers: Layer[] = [];
let escapeListenerInstalled = false;

function installEscapeListener(): void {
  if (escapeListenerInstalled) return;
  escapeListenerInstalled = true;
  window.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Escape' || layers.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      layers[layers.length - 1].onEscape();
    },
    true,
  );
}

function useEscapeLayer(active: boolean, onEscape: () => void): void {
  const latest = useRef(onEscape);
  latest.current = onEscape;
  useEffect(() => {
    if (!active) return;
    installEscapeListener();
    const layer: Layer = { onEscape: () => latest.current() };
    layers.push(layer);
    return () => {
      const index = layers.indexOf(layer);
      if (index >= 0) layers.splice(index, 1);
    };
  }, [active]);
}

// ───────────────────────────── Modal ─────────────────────────────

export function Modal({
  title,
  subtitle,
  icon,
  tone = 'default',
  onClose,
  children,
  footer,
  size = 'md',
  closeOnBackdrop = false,
  locked = false,
  flush = false,
  testId,
}: ModalProps): ReactNode {
  const { t } = useT();
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const pressedOnBackdrop = useRef(false);

  useEscapeLayer(true, () => {
    if (!locked) onClose();
  });

  // Move the focus in when the dialog opens and give it back when it closes.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    if (dialog) {
      const preferred = dialog.querySelector<HTMLElement>('[data-autofocus], [autofocus]');
      const body = dialog.querySelector<HTMLElement>('.ui-modal__body');
      const first = preferred ?? (body ? focusablesIn(body)[0] : undefined) ?? focusablesIn(dialog)[0] ?? dialog;
      first.focus();
    }
    return () => {
      if (previous && document.contains(previous)) previous.focus();
    };
  }, []);

  const trapFocus = (event: KeyboardEvent<HTMLDivElement>): void => {
    const dialog = dialogRef.current;
    // A popover opened from this dialog lives outside its DOM but inside its React tree: leave it alone.
    if (event.key !== 'Tab' || !dialog || !(event.target instanceof Node) || !dialog.contains(event.target)) return;
    const items = focusablesIn(dialog);
    if (items.length === 0) {
      event.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const onBackdropDown = (event: MouseEvent<HTMLDivElement>): void => {
    pressedOnBackdrop.current = event.target === event.currentTarget;
  };
  const onBackdropUp = (event: MouseEvent<HTMLDivElement>): void => {
    const onBackdrop = pressedOnBackdrop.current && event.target === event.currentTarget;
    pressedOnBackdrop.current = false;
    if (onBackdrop && closeOnBackdrop && !locked) onClose();
  };

  return createPortal(
    <div className="ui-modal-backdrop" onMouseDown={onBackdropDown} onMouseUp={onBackdropUp}>
      <div
        ref={dialogRef}
        className={cx('ui-modal', `ui-modal--${size}`)}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={trapFocus}
        data-testid={testId}
      >
        <header className="ui-modal__header">
          {icon ? (
            <span className={cx('ui-modal__icon', `ui-modal__icon--${tone}`)}>
              <Icon name={icon} size={18} />
            </span>
          ) : null}
          <div className="ui-modal__titles">
            <h2 id={titleId} className="ui-modal__title">
              {title}
            </h2>
            {subtitle ? <div className="ui-modal__subtitle">{subtitle}</div> : null}
          </div>
          {locked ? null : <IconButton icon="close" label={t('ui.close')} onClick={onClose} testId="modal-close" />}
        </header>
        <div className={cx('ui-modal__body', flush && 'ui-modal__body--flush')}>{children}</div>
        {footer ? <footer className="ui-modal__footer">{footer}</footer> : null}
      </div>
    </div>,
    document.body,
  );
}

// ───────────────────────────── Popover ─────────────────────────────

const VIEWPORT_MARGIN = 8;
const ANCHOR_GAP = 4;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

export function Popover({
  anchor,
  open,
  onClose,
  children,
  placement = 'bottom-start',
  matchWidth,
  className,
  ariaLabel,
  testId,
}: PopoverProps): ReactNode {
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number; minWidth?: number } | null>(null);
  const shown = open && anchor !== null;

  useEscapeLayer(shown, onClose);

  const place = useCallback(() => {
    const panel = panelRef.current;
    if (!panel || !anchor) return;
    const rect = anchor.getBoundingClientRect();
    const width = panel.offsetWidth;
    const height = panel.offsetHeight;
    const viewWidth = window.innerWidth;
    const viewHeight = window.innerHeight;
    const rtl = getComputedStyle(anchor).direction === 'rtl';
    const [side, align] = placement.split('-') as ['bottom' | 'top' | 'side', 'start' | 'end'];
    let left: number;
    let top: number;
    if (side === 'side') {
      // "end" is the right side in English and the left side in Hebrew.
      const toRight = (align === 'end') !== rtl;
      const rightOf = rect.right + ANCHOR_GAP;
      const leftOf = rect.left - ANCHOR_GAP - width;
      const fitsRight = rightOf + width <= viewWidth - VIEWPORT_MARGIN;
      const fitsLeft = leftOf >= VIEWPORT_MARGIN;
      left = toRight ? (fitsRight || !fitsLeft ? rightOf : leftOf) : fitsLeft || !fitsRight ? leftOf : rightOf;
      top = rect.top;
    } else {
      const fromLeftEdge = (align === 'start') !== rtl;
      left = fromLeftEdge ? rect.left : rect.right - width;
      const below = rect.bottom + ANCHOR_GAP;
      const above = rect.top - ANCHOR_GAP - height;
      const fitsBelow = below + height <= viewHeight - VIEWPORT_MARGIN;
      const fitsAbove = above >= VIEWPORT_MARGIN;
      top = side === 'bottom' ? (fitsBelow || !fitsAbove ? below : above) : fitsAbove || !fitsBelow ? above : below;
    }
    setPosition({
      left: clamp(left, VIEWPORT_MARGIN, viewWidth - VIEWPORT_MARGIN - width),
      top: clamp(top, VIEWPORT_MARGIN, viewHeight - VIEWPORT_MARGIN - height),
      minWidth: matchWidth ? rect.width : undefined,
    });
  }, [anchor, placement, matchWidth]);

  useLayoutEffect(() => {
    if (!shown) {
      setPosition(null);
      return;
    }
    place();
    const panel = panelRef.current;
    const observer = panel ? new ResizeObserver(place) : null;
    if (panel && observer) observer.observe(panel);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [shown, place]);

  useEffect(() => {
    if (!shown) return;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      // A press on the anchor is the anchor's own business (it toggles the popover).
      if (panelRef.current?.contains(target) || anchor?.contains(target)) return;
      onClose();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [shown, anchor, onClose]);

  if (!shown) return null;
  return createPortal(
    <div
      ref={panelRef}
      className={cx('ui-popover', className)}
      role="dialog"
      aria-label={ariaLabel}
      style={{
        left: position?.left ?? 0,
        top: position?.top ?? 0,
        minWidth: position?.minWidth,
        visibility: position ? 'visible' : 'hidden',
      }}
      data-testid={testId}
    >
      {children}
    </div>,
    document.body,
  );
}

// ───────────────────────────── MenuButton ─────────────────────────────

export function MenuButton({
  label,
  icon,
  iconOnly,
  items,
  variant = 'secondary',
  size = 'md',
  align = 'start',
  disabled,
  testId,
}: MenuButtonProps): ReactNode {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    anchor?.focus();
  }, [anchor]);

  useEffect(() => {
    if (open) listRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus();
  }, [open]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const list = listRef.current;
    if (!list) return;
    const options = [...list.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])')];
    const index = options.indexOf(document.activeElement as HTMLElement);
    let next = -1;
    if (event.key === 'ArrowDown') next = (index + 1) % options.length;
    else if (event.key === 'ArrowUp') next = (index - 1 + options.length) % options.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = options.length - 1;
    else if (event.key === 'Tab') {
      event.preventDefault();
      close();
      return;
    } else return;
    event.preventDefault();
    options[next]?.focus();
  };

  const button = iconOnly ? (
    <IconButton
      ref={setAnchor}
      icon={icon ?? 'more'}
      label={label}
      variant={variant === 'primary' ? 'secondary' : variant}
      size={size}
      active={open}
      disabled={disabled}
      aria-haspopup="menu"
      aria-expanded={open}
      onClick={() => setOpen((value) => !value)}
      testId={testId}
    />
  ) : (
    <Button
      ref={setAnchor}
      icon={icon}
      variant={variant}
      size={size}
      disabled={disabled}
      aria-haspopup="menu"
      aria-expanded={open}
      onClick={() => setOpen((value) => !value)}
      testId={testId}
    >
      {label}
      <Icon name="chevron-down" size={14} className="ui-btn__caret" />
    </Button>
  );

  return (
    <>
      {button}
      <Popover anchor={anchor} open={open} onClose={close} placement={align === 'end' ? 'bottom-end' : 'bottom-start'} ariaLabel={label}>
        <div ref={listRef} className="ui-menu" role="menu" onKeyDown={onKeyDown}>
          {items.map((item) => (
            <div key={item.id} role="none">
              {item.separatorBefore ? <div className="ui-menu__separator" role="separator" /> : null}
              <button
                type="button"
                role="menuitem"
                className={cx('ui-menu__item', item.danger && 'is-danger')}
                disabled={item.disabled}
                onClick={() => {
                  close();
                  item.onSelect();
                }}
                data-testid={testId ? `${testId}-${item.id}` : undefined}
              >
                {item.icon ? <Icon name={item.icon} /> : <span className="ui-menu__gap" />}
                <span className="ui-menu__label">{item.label}</span>
                {item.hint ? <span className="ui-menu__hint ltr">{item.hint}</span> : null}
              </button>
            </div>
          ))}
        </div>
      </Popover>
    </>
  );
}

// ───────────────────────────── MultiSelect ─────────────────────────────

const SEARCH_THRESHOLD = 8;

export function MultiSelect({
  label,
  icon,
  options,
  selected,
  onChange,
  emptyText,
  searchable = true,
  appearance = 'filter',
  placeholder,
  onCreate,
  createLabel,
  disabled,
  testId,
}: MultiSelectProps): ReactNode {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState('');

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    setDraft('');
  }, []);

  const chosen = useMemo(() => new Set(selected), [selected]);
  const showSearch = searchable && options.length > SEARCH_THRESHOLD;
  const needle = query.trim().toLocaleLowerCase();
  const visible = needle === '' ? options : options.filter((option) => option.name.toLocaleLowerCase().includes(needle));
  // Ids of entries that no longer exist must not count (or block "clear").
  const selectedNames = options.filter((option) => chosen.has(option.id)).map((option) => option.name);

  const toggle = (id: string): void => {
    onChange(chosen.has(id) ? selected.filter((entry) => entry !== id) : [...selected, id]);
  };

  const create = (): void => {
    const name = draft.trim();
    if (!onCreate || name === '') return;
    const id = onCreate(name);
    if (id !== '' && !chosen.has(id)) onChange([...selected, id]);
    setDraft('');
  };

  const trigger =
    appearance === 'field' ? (
      <button
        ref={setAnchor}
        type="button"
        className={cx('ui-input', 'ui-multi__field', open && 'is-open')}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((value) => !value)}
        data-testid={testId}
      >
        <span className={cx('ui-multi__value', 'truncate', selectedNames.length === 0 && 'is-placeholder')} dir="auto">
          {selectedNames.length === 0 ? placeholder ?? '' : selectedNames.join(', ')}
        </span>
        <Icon name="chevron-down" size={14} />
      </button>
    ) : (
      <button
        ref={setAnchor}
        type="button"
        className={cx('ui-btn', 'ui-btn--secondary', 'ui-multi__filter', selectedNames.length > 0 && 'is-active')}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        data-testid={testId}
      >
        {icon ? <Icon name={icon} /> : null}
        <span className="ui-btn__label">{label}</span>
        {selectedNames.length > 0 ? <span className="ui-multi__count">{selectedNames.length}</span> : null}
        <Icon name="chevron-down" size={14} className="ui-btn__caret" />
      </button>
    );

  return (
    <>
      {trigger}
      <Popover anchor={anchor} open={open} onClose={close} matchWidth ariaLabel={label} testId={testId ? `${testId}-panel` : undefined}>
        <div className="ui-multi">
          {showSearch ? (
            <div className="ui-multi__search">
              <Icon name="search" size={14} />
              <input
                type="text"
                dir="auto"
                value={query}
                placeholder={t('ui.search')}
                aria-label={t('ui.search')}
                onChange={(event) => setQuery(event.target.value)}
                data-autofocus
              />
            </div>
          ) : null}
          <div className="ui-multi__list" role="listbox" aria-multiselectable="true" aria-label={label}>
            {options.length === 0 ? (
              <div className="ui-multi__empty">{emptyText ?? t('ui.noOptions')}</div>
            ) : visible.length === 0 ? (
              <div className="ui-multi__empty">{t('ui.noResults')}</div>
            ) : (
              visible.map((option) => (
                <label key={option.id} className="ui-multi__option" role="option" aria-selected={chosen.has(option.id)}>
                  <input
                    type="checkbox"
                    checked={chosen.has(option.id)}
                    onChange={() => toggle(option.id)}
                    data-testid={testId ? `${testId}-option-${option.id}` : undefined}
                  />
                  {option.color ? <ColorDot color={option.color} /> : null}
                  <span className="truncate" dir="auto">
                    {option.name}
                  </span>
                </label>
              ))
            )}
          </div>
          {onCreate ? (
            <div className="ui-multi__create">
              <input
                type="text"
                dir="auto"
                value={draft}
                placeholder={createLabel ?? t('ui.addNew')}
                aria-label={createLabel ?? t('ui.addNew')}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    create();
                  }
                }}
                data-testid={testId ? `${testId}-create-input` : undefined}
              />
              <IconButton
                icon="plus"
                label={createLabel ?? t('ui.addNew')}
                size="sm"
                variant="secondary"
                disabled={draft.trim() === ''}
                onClick={create}
                testId={testId ? `${testId}-create` : undefined}
              />
            </div>
          ) : null}
          {selectedNames.length > 0 ? (
            <div className="ui-multi__footer">
              <Button size="sm" variant="ghost" onClick={() => onChange([])} testId={testId ? `${testId}-clear` : undefined}>
                {t('ui.clearSelection')}
              </Button>
            </div>
          ) : null}
        </div>
      </Popover>
    </>
  );
}
