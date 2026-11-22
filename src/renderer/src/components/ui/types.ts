/**
 * Props of the shared UI kit (`components/ui`).
 *
 * CONTRACT FILE — feature components are written against these props; the UI-kit build
 * task implements the components. Do not change without updating both sides.
 *
 * General rules for the kit:
 *  - Works in both directions: uses logical CSS properties only; `start` / `end` in prop
 *    names are logical (start = right edge in Hebrew).
 *  - Text typed by users (names, titles, notes) is rendered with `dir="auto"`.
 *  - Every interactive element is reachable and operable by keyboard and has an
 *    accessible name.
 *  - `testId` props are written to `data-testid` on the main interactive element.
 */
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, Ref, TextareaHTMLAttributes } from 'react';
import type { IsoDate, Minutes } from '@shared/types';

export type IconName =
  | 'plus'
  | 'minus'
  | 'edit'
  | 'trash'
  | 'copy'
  | 'check'
  | 'close'
  | 'search'
  | 'filter'
  | 'more'
  | 'settings'
  | 'calendar'
  | 'clock'
  | 'location'
  | 'user'
  | 'users'
  | 'tag'
  | 'palette'
  | 'notes'
  /** Points towards the start of the line (left in English, right in Hebrew) when `flipRtl` is set. */
  | 'chevron-start'
  /** Points towards the end of the line when `flipRtl` is set. */
  | 'chevron-end'
  | 'chevron-down'
  | 'chevron-up'
  | 'arrow-up'
  | 'arrow-down'
  | 'download'
  | 'upload'
  | 'refresh'
  | 'undo'
  | 'redo'
  | 'repeat'
  | 'folder'
  | 'file'
  | 'external'
  | 'language'
  | 'info'
  | 'warning'
  | 'error'
  | 'success'
  | 'lock'
  | 'history'
  /** Sync states */
  | 'cloud-check'
  | 'cloud-up'
  | 'cloud-down'
  | 'cloud-off'
  | 'git-merge'
  | 'git-branch'
  | 'inbox';

export interface IconProps {
  name: IconName;
  /** Pixel size (width = height). Default 16. */
  size?: number;
  className?: string;
  /** Mirror horizontally in right-to-left layouts (use for chevrons, arrows, undo/redo). */
  flipRtl?: boolean;
  /** Accessible label; without it the icon is decorative (aria-hidden). */
  title?: string;
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Default 'secondary'. */
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  /** Default 'md' (32px high); 'sm' is 26px. */
  size?: 'sm' | 'md';
  /** Icon before the label. */
  icon?: IconName;
  iconFlipRtl?: boolean;
  /** Shows a spinner instead of the icon and disables the button. */
  busy?: boolean;
  /** Full width. */
  block?: boolean;
  /** The underlying button element, e.g. `ref={setAnchor}` to attach a Popover to it. */
  ref?: Ref<HTMLButtonElement>;
  testId?: string;
}

/** A square button that shows only an icon. `label` is its accessible name and tooltip. */
export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: IconName;
  label: string;
  size?: 'sm' | 'md';
  variant?: 'ghost' | 'secondary' | 'danger';
  /** Pressed / toggled-on look. */
  active?: boolean;
  flipRtl?: boolean;
  /** The underlying button element, e.g. `ref={setAnchor}` to attach a Popover to it. */
  ref?: Ref<HTMLButtonElement>;
  testId?: string;
}

/**
 * Modal dialog rendered in a portal on top of everything, with a dimmed backdrop, focus
 * trap, focus restore, Esc to close and `role="dialog"`. The body scrolls when the content
 * is taller than the window; header and footer stay visible.
 */
export interface ModalProps {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Icon shown before the title. */
  icon?: IconName;
  /** Colours the header icon. Default 'default'. */
  tone?: 'default' | 'info' | 'warning' | 'danger';
  onClose: () => void;
  children: ReactNode;
  /** Button row at the bottom. Put the primary action last (it ends up at the inline end). */
  footer?: ReactNode;
  /** Max width: sm 420px, md 560px (default), lg 760px, xl 1040px. */
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** Close when the backdrop is clicked. Default false (forms must not close by accident). */
  closeOnBackdrop?: boolean;
  /** Hides the X button and ignores Esc / backdrop — while an operation is running. */
  locked?: boolean;
  /** Removes the body padding (for dialogs that manage their own layout, e.g. tabs). */
  flush?: boolean;
  testId?: string;
}

/**
 * Floating panel attached to an element (menus, dropdowns, event details). Rendered in a
 * portal, kept inside the window, closed by an outside click or Esc.
 */
export interface PopoverProps {
  /** Element the panel is attached to; nothing is rendered while it is null. */
  anchor: HTMLElement | null;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  /**
   * Preferred position; flips to the opposite side when there is no room.
   * `bottom-start`: below, aligned with the anchor's start edge (default).
   * `side-end` / `side-start`: beside the anchor, towards the end / start of the line.
   */
  placement?: 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end' | 'side-end' | 'side-start';
  /** Make the panel at least as wide as the anchor. */
  matchWidth?: boolean;
  className?: string;
  /** Accessible name of the panel. */
  ariaLabel?: string;
  testId?: string;
}

export interface MenuItem {
  id: string;
  label: string;
  icon?: IconName;
  /** Secondary text at the inline end (e.g. a keyboard shortcut). */
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  /** Draw a divider line above this item. */
  separatorBefore?: boolean;
  onSelect: () => void;
}

/** A button that opens a menu of actions (arrow keys + Enter work). */
export interface MenuButtonProps {
  /** Button text; also the accessible name when `iconOnly` is set. */
  label: string;
  icon?: IconName;
  /** Show only the icon on the button. */
  iconOnly?: boolean;
  items: MenuItem[];
  variant?: 'secondary' | 'ghost' | 'primary';
  size?: 'sm' | 'md';
  /** Which anchor edge the menu aligns with. Default 'start'. */
  align?: 'start' | 'end';
  disabled?: boolean;
  testId?: string;
}

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

/** Styled native `<select>`. */
export interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  id?: string;
  disabled?: boolean;
  invalid?: boolean;
  ariaLabel?: string;
  className?: string;
  testId?: string;
}

export interface PickOption {
  id: string;
  name: string;
  /** Shows a colour dot before the name (subjects). */
  color?: string;
}

/**
 * Dropdown with check boxes for choosing any number of entries (filters, teachers,
 * classes). The button shows `label` and, when something is selected, a count badge.
 */
export interface MultiSelectProps {
  label: string;
  icon?: IconName;
  options: PickOption[];
  selected: string[];
  onChange: (ids: string[]) => void;
  /** Shown inside the dropdown when `options` is empty. */
  emptyText?: string;
  /** Show a search box when there are more than 8 options. Default true. */
  searchable?: boolean;
  /**
   * `filter` (default): compact toolbar button with a count badge.
   * `field`: full-width form control that lists the selected names.
   */
  appearance?: 'filter' | 'field';
  /** `field` appearance: text when nothing is selected. */
  placeholder?: string;
  /**
   * When given, the dropdown ends with an "add new" row: the user types a name and this is
   * called; return the id of the new (or already existing) entry and it gets selected.
   */
  onCreate?: (name: string) => string;
  /** Label of that row, e.g. "Add teacher". */
  createLabel?: string;
  disabled?: boolean;
  testId?: string;
}

/** Label + control + optional hint / error text, stacked. */
export interface FieldProps {
  label: ReactNode;
  /** id of the control, for the `<label for>`. */
  htmlFor?: string;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  children: ReactNode;
  className?: string;
}

export interface TextInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value' | 'size'> {
  value: string;
  onChange: (value: string) => void;
  invalid?: boolean;
  /**
   * Force a direction (URLs, e-mail, paths → 'ltr'). Default: the direction of the typed
   * text, and the interface's while the box is empty.
   */
  dir?: 'auto' | 'ltr' | 'rtl';
  /** Called when Enter is pressed. */
  onEnter?: () => void;
  testId?: string;
}

export interface TextAreaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'onChange' | 'value'> {
  value: string;
  onChange: (value: string) => void;
  invalid?: boolean;
  testId?: string;
}

/** Whole-number input; emits null while the box is empty or not a number. */
/**
 * A box for a whole number. `onChange` gets the number, or null while the box is empty or
 * holds something unusable (not a whole number, outside min…max). What was typed always
 * stays in the box — an unusable entry is marked, never erased; `onTextChange` reports it.
 */
export interface NumberInputProps {
  value: number | null;
  onChange: (value: number | null) => void;
  /** The text in the box after every key stroke, usable or not. */
  onTextChange?: (text: string) => void;
  min?: number;
  max?: number;
  step?: number;
  id?: string;
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  ariaLabel?: string;
  className?: string;
  onEnter?: () => void;
  testId?: string;
}

/**
 * Time of day as a native select of "HH:MM" entries from `min` to `max` (inclusive, default
 * 00:00–24:00) every `step` minutes (default 15). When `value` is not on that grid it is
 * added as an extra entry so existing data is never changed silently.
 */
export interface TimeSelectProps {
  value: Minutes;
  onChange: (value: Minutes) => void;
  min?: Minutes;
  max?: Minutes;
  step?: number;
  id?: string;
  disabled?: boolean;
  invalid?: boolean;
  ariaLabel?: string;
  testId?: string;
}

/** Native date picker. Emits null when cleared. */
export interface DateInputProps {
  value: IsoDate | null;
  onChange: (value: IsoDate | null) => void;
  min?: IsoDate;
  max?: IsoDate;
  id?: string;
  disabled?: boolean;
  invalid?: boolean;
  ariaLabel?: string;
  testId?: string;
}

export interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  /** Smaller explanatory text under the label. */
  hint?: ReactNode;
  disabled?: boolean;
  testId?: string;
}

export interface RadioOption<T extends string> {
  value: T;
  label: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
}

export interface RadioGroupProps<T extends string> {
  /** Accessible name of the group. */
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: RadioOption<T>[];
  /** Default 'column'. */
  direction?: 'row' | 'column';
  testId?: string;
}

/**
 * RGB colour editor: preset swatches, three sliders (R, G, B, 0–255) each with a number
 * box, a hex box (#RRGGBB) and a live preview. All parts stay in sync; `onChange` always
 * receives an upper-case `#RRGGBB`.
 */
export interface ColorPickerProps {
  value: string;
  onChange: (hex: string) => void;
  /** Default: DEFAULT_SUBJECT_COLORS from @shared/colors. */
  presets?: readonly string[];
  testId?: string;
}

/** Small filled circle in the given colour. */
export interface ColorDotProps {
  color: string;
  /** Diameter in px. Default 10. */
  size?: number;
  className?: string;
  title?: string;
}

export interface TabItem<T extends string> {
  id: T;
  label: string;
  icon?: IconName;
  /** Small marker after the label (e.g. a count). */
  badge?: ReactNode;
  /**
   * A caption shown above this tab: it starts a group. The groups are ONE list for the
   * keyboard: one tab stop, and the arrow keys run through all tabs across the captions.
   */
  group?: string;
}

export interface TabsProps<T extends string> {
  tabs: TabItem<T>[];
  active: T;
  onChange: (id: T) => void;
  /** Default 'horizontal'. 'vertical' is a side list (settings). */
  orientation?: 'horizontal' | 'vertical';
  ariaLabel?: string;
  testId?: string;
}

export interface BadgeProps {
  /** Default 'neutral'. `mine` / `theirs` / `conflict` / `aside` use the sync colours. */
  tone?: 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'mine' | 'theirs' | 'conflict' | 'aside';
  icon?: IconName;
  children: ReactNode;
  title?: string;
  className?: string;
  testId?: string;
}

export interface SpinnerProps {
  /** Pixel size. Default 16. */
  size?: number;
  className?: string;
}

/** Centered placeholder for empty lists / empty states. */
export interface EmptyStateProps {
  icon?: IconName;
  title: string;
  text?: ReactNode;
  /** e.g. a Button. */
  action?: ReactNode;
}

/** Highlighted message box. */
export interface CalloutProps {
  tone: 'info' | 'success' | 'warning' | 'danger';
  title?: ReactNode;
  children?: ReactNode;
  /** Default: the icon that matches the tone. */
  icon?: IconName;
  /** Buttons shown at the inline end / below the text. */
  actions?: ReactNode;
  testId?: string;
}

/** Collapsible box for technical text (git output): monospace, left-to-right, selectable. */
export interface DetailsBoxProps {
  /** Default: t('common.details'). */
  summary?: string;
  text: string;
  defaultOpen?: boolean;
}
