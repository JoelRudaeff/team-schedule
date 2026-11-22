import { Fragment, useEffect, useId, useState, type KeyboardEvent, type ReactNode } from 'react';
import { isValidIsoDate, minutesToHHMM, timeOptions } from '@shared/dates';
import { useT } from '../../i18n/useT';
import { formatDate } from '../../lib/format';
import { parseWholeNumber, textDirection } from '../../lib/inputs';
import { Icon } from './icons';
import type {
  BadgeProps,
  ButtonProps,
  CalloutProps,
  CheckboxProps,
  ColorDotProps,
  DateInputProps,
  DetailsBoxProps,
  EmptyStateProps,
  FieldProps,
  IconButtonProps,
  IconName,
  NumberInputProps,
  RadioGroupProps,
  SelectProps,
  SpinnerProps,
  TabsProps,
  TextAreaProps,
  TextInputProps,
  TimeSelectProps,
} from './types';

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

export function Spinner({ size = 16, className }: SpinnerProps): ReactNode {
  return <span className={cx('ui-spinner', className)} style={{ width: size, height: size }} role="progressbar" />;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  iconFlipRtl,
  busy,
  block,
  testId,
  className,
  children,
  disabled,
  type,
  ...rest
}: ButtonProps): ReactNode {
  return (
    <button
      {...rest}
      type={type ?? 'button'}
      className={cx('ui-btn', `ui-btn--${variant}`, size === 'sm' && 'ui-btn--sm', block && 'ui-btn--block', className)}
      disabled={disabled || busy}
      data-testid={testId}
    >
      {busy ? <Spinner size={14} /> : icon ? <Icon name={icon} flipRtl={iconFlipRtl} /> : null}
      {children !== undefined && children !== null ? <span className="ui-btn__label">{children}</span> : null}
    </button>
  );
}

export function IconButton({
  icon,
  label,
  size = 'md',
  variant = 'ghost',
  active,
  flipRtl,
  testId,
  className,
  type,
  ...rest
}: IconButtonProps): ReactNode {
  return (
    <button
      {...rest}
      type={type ?? 'button'}
      className={cx(
        'ui-btn',
        'ui-btn--icon',
        `ui-btn--${variant}`,
        size === 'sm' && 'ui-btn--sm',
        active && 'is-active',
        className,
      )}
      aria-label={label}
      aria-pressed={active === undefined ? undefined : active}
      title={label}
      data-testid={testId}
    >
      <Icon name={icon} flipRtl={flipRtl} />
    </button>
  );
}

export function Badge({ tone = 'neutral', icon, children, title, className, testId }: BadgeProps): ReactNode {
  return (
    <span className={cx('ui-badge', `ui-badge--${tone}`, className)} title={title} data-testid={testId}>
      {icon ? <Icon name={icon} size={12} /> : null}
      {children}
    </span>
  );
}

export function ColorDot({ color, size = 10, className, title }: ColorDotProps): ReactNode {
  return (
    <span
      className={cx('ui-dot', className)}
      style={{ width: size, height: size, background: color }}
      title={title}
      aria-hidden={title ? undefined : true}
    />
  );
}

export function Field({ label, htmlFor, hint, error, required, children, className }: FieldProps): ReactNode {
  return (
    <div className={cx('ui-field', className)}>
      <label className="ui-field__label" htmlFor={htmlFor}>
        {label}
        {required ? <span className="ui-field__required" aria-hidden="true"> *</span> : null}
      </label>
      {children}
      {error ? (
        <div className="ui-field__error" role="alert">
          {error}
        </div>
      ) : hint ? (
        <div className="ui-field__hint">{hint}</div>
      ) : null}
    </div>
  );
}

function enterHandler(onEnter: (() => void) | undefined, next?: (e: KeyboardEvent<HTMLInputElement>) => void) {
  return (event: KeyboardEvent<HTMLInputElement>): void => {
    next?.(event);
    if (onEnter && event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      onEnter();
    }
  };
}

export function TextInput({
  value,
  onChange,
  invalid,
  dir,
  onEnter,
  testId,
  className,
  onKeyDown,
  type,
  ...rest
}: TextInputProps): ReactNode {
  return (
    <input
      {...rest}
      type={type ?? 'text'}
      dir={dir ?? textDirection(value)}
      className={cx('ui-input', invalid && 'is-invalid', className)}
      value={value}
      aria-invalid={invalid || undefined}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={enterHandler(onEnter, onKeyDown)}
      data-testid={testId}
    />
  );
}

export function TextArea({ value, onChange, invalid, testId, className, rows, ...rest }: TextAreaProps): ReactNode {
  return (
    <textarea
      {...rest}
      dir={textDirection(value)}
      rows={rows ?? 3}
      className={cx('ui-input', 'ui-textarea', invalid && 'is-invalid', className)}
      value={value}
      aria-invalid={invalid || undefined}
      onChange={(event) => onChange(event.target.value)}
      data-testid={testId}
    />
  );
}

export function NumberInput({
  value,
  onChange,
  onTextChange,
  min,
  max,
  step,
  id,
  placeholder,
  disabled,
  invalid,
  ariaLabel,
  className,
  onEnter,
  testId,
}: NumberInputProps): ReactNode {
  // What is in the box is kept here, so an entry that cannot be used (too large, not a whole
  // number) stays visible and is marked instead of vanishing while it is being typed.
  const [text, setText] = useState(value === null ? '' : String(value));
  useEffect(() => {
    setText((current) => {
      const shown = parseWholeNumber(current, min, max);
      if (value === null) return shown === null ? current : '';
      return shown === value ? current : String(value);
    });
  }, [value, min, max]);
  const unusable = text.trim() !== '' && parseWholeNumber(text, min, max) === null;

  return (
    <input
      id={id}
      type="number"
      inputMode="numeric"
      className={cx('ui-input', 'ui-input--number', 'ltr', (invalid || unusable) && 'is-invalid', className)}
      value={text}
      min={min}
      max={max}
      step={step ?? 1}
      placeholder={placeholder}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-invalid={invalid || unusable || undefined}
      onChange={(event) => {
        const next = event.target.value;
        setText(next);
        onTextChange?.(next);
        onChange(parseWholeNumber(next, min, max));
      }}
      onKeyDown={enterHandler(onEnter)}
      data-testid={testId}
    />
  );
}

export function Select({ value, onChange, options, id, disabled, invalid, ariaLabel, className, testId }: SelectProps): ReactNode {
  return (
    <select
      id={id}
      className={cx('ui-input', 'ui-select', invalid && 'is-invalid', className)}
      value={value}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-invalid={invalid || undefined}
      onChange={(event) => onChange(event.target.value)}
      data-testid={testId}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value} disabled={option.disabled}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

export function TimeSelect({
  value,
  onChange,
  min = 0,
  max = 1440,
  step = 15,
  id,
  disabled,
  invalid,
  ariaLabel,
  testId,
}: TimeSelectProps): ReactNode {
  const grid = timeOptions(min, max, step);
  // A time that is not on the grid (hand-edited data) stays selectable instead of being changed silently.
  const all = grid.includes(value) ? grid : [...grid, value].sort((a, b) => a - b);
  return (
    <select
      id={id}
      className={cx('ui-input', 'ui-select', 'ui-select--time', 'ltr', invalid && 'is-invalid')}
      value={String(value)}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-invalid={invalid || undefined}
      onChange={(event) => onChange(Number(event.target.value))}
      data-testid={testId}
    >
      {all.map((minutes) => (
        <option key={minutes} value={String(minutes)}>
          {minutesToHHMM(minutes)}
        </option>
      ))}
    </select>
  );
}

const EARLIEST_DATE = '1900-01-01';
const LATEST_DATE = '2999-12-31';

export function DateInput({ value, onChange, min, max, id, disabled, invalid, ariaLabel, testId }: DateInputProps): ReactNode {
  const { lang } = useT();
  // While a year is being typed the browser reports dates such as 0002-11-22. Those stay in
  // the box as a draft and are never passed on: only complete, real dates leave this control.
  const [draft, setDraft] = useState(value ?? '');
  useEffect(() => setDraft(value ?? ''), [value]);
  const draftInvalid = draft !== '' && !isValidIsoDate(draft);

  return (
    <span className="ui-date">
      <input
        id={id}
        type="date"
        className={cx('ui-input', 'ui-input--date', (invalid || draftInvalid) && 'is-invalid')}
        value={draft}
        min={min ?? EARLIEST_DATE}
        max={max ?? LATEST_DATE}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-invalid={invalid || draftInvalid || undefined}
        onChange={(event) => {
          const text = event.target.value;
          setDraft(text);
          if (text === '') onChange(null);
          else if (isValidIsoDate(text)) onChange(text);
        }}
        onBlur={() => {
          if (draftInvalid) setDraft(value ?? '');
        }}
        data-testid={testId}
      />
      {/* The date again in words: the box itself follows the Windows date format, which may be month-first. */}
      {value ? <span className="ui-date__words">{formatDate(value, lang)}</span> : null}
    </span>
  );
}

export function Checkbox({ checked, onChange, label, hint, disabled, testId }: CheckboxProps): ReactNode {
  return (
    <label className={cx('ui-check', disabled && 'is-disabled')}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        data-testid={testId}
      />
      <span className="ui-check__text">
        <span>{label}</span>
        {hint ? <span className="ui-check__hint">{hint}</span> : null}
      </span>
    </label>
  );
}

export function RadioGroup<T extends string>({
  label,
  value,
  onChange,
  options,
  direction = 'column',
  testId,
}: RadioGroupProps<T>): ReactNode {
  const name = useId();
  return (
    <div className={cx('ui-radio', direction === 'row' && 'ui-radio--row')} role="radiogroup" aria-label={label} data-testid={testId}>
      {options.map((option) => (
        <label key={option.value} className={cx('ui-check', option.disabled && 'is-disabled')}>
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={option.value === value}
            disabled={option.disabled}
            onChange={() => onChange(option.value)}
            data-testid={testId ? `${testId}-${option.value}` : undefined}
          />
          <span className="ui-check__text">
            <span>{option.label}</span>
            {option.hint ? <span className="ui-check__hint">{option.hint}</span> : null}
          </span>
        </label>
      ))}
    </div>
  );
}

const TONE_ICON: Record<CalloutProps['tone'], IconName> = {
  info: 'info',
  success: 'success',
  warning: 'warning',
  danger: 'error',
};

export function Callout({ tone, title, children, icon, actions, testId }: CalloutProps): ReactNode {
  return (
    <div className={cx('ui-callout', `ui-callout--${tone}`)} role={tone === 'danger' ? 'alert' : 'note'} data-testid={testId}>
      <Icon name={icon ?? TONE_ICON[tone]} size={18} className="ui-callout__icon" />
      <div className="ui-callout__body">
        {title ? <div className="ui-callout__title">{title}</div> : null}
        {children ? <div className="ui-callout__text">{children}</div> : null}
      </div>
      {actions ? <div className="ui-callout__actions">{actions}</div> : null}
    </div>
  );
}

export function DetailsBox({ summary, text, defaultOpen }: DetailsBoxProps): ReactNode {
  const { t } = useT();
  return (
    <details className="ui-details" open={defaultOpen}>
      <summary>{summary ?? t('common.details')}</summary>
      <pre className="mono ltr selectable">{text}</pre>
    </details>
  );
}

export function EmptyState({ icon, title, text, action }: EmptyStateProps): ReactNode {
  return (
    <div className="ui-empty">
      {icon ? <Icon name={icon} size={28} className="ui-empty__icon" /> : null}
      <div className="ui-empty__title">{title}</div>
      {text ? <div className="ui-empty__text">{text}</div> : null}
      {action ? <div className="ui-empty__action">{action}</div> : null}
    </div>
  );
}

export function Tabs<T extends string>({ tabs, active, onChange, orientation = 'horizontal', ariaLabel, testId }: TabsProps<T>): ReactNode {
  const move = (event: KeyboardEvent<HTMLDivElement>): void => {
    const vertical = orientation === 'vertical';
    const rtl = getComputedStyle(event.currentTarget).direction === 'rtl';
    const forward = vertical ? 'ArrowDown' : rtl ? 'ArrowLeft' : 'ArrowRight';
    const backward = vertical ? 'ArrowUp' : rtl ? 'ArrowRight' : 'ArrowLeft';
    const index = tabs.findIndex((tab) => tab.id === active);
    let next = index;
    if (event.key === forward) next = (index + 1) % tabs.length;
    else if (event.key === backward) next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else return;
    event.preventDefault();
    onChange(tabs[next].id);
    const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    buttons[next]?.focus();
  };
  return (
    <div
      className={cx('ui-tabs', orientation === 'vertical' && 'ui-tabs--vertical')}
      role="tablist"
      aria-label={ariaLabel}
      aria-orientation={orientation}
      onKeyDown={move}
      data-testid={testId}
    >
      {tabs.map((tab) => (
        <Fragment key={tab.id}>
          {tab.group ? (
            <div className="ui-tabs__group" role="presentation">
              {tab.group}
            </div>
          ) : null}
          <button
            type="button"
            role="tab"
            className={cx('ui-tab', tab.id === active && 'is-active')}
            aria-selected={tab.id === active}
            tabIndex={tab.id === active ? 0 : -1}
            onClick={() => onChange(tab.id)}
            data-testid={testId ? `${testId}-${tab.id}` : undefined}
          >
            {tab.icon ? <Icon name={tab.icon} /> : null}
            <span className="ui-tab__label">{tab.label}</span>
            {tab.badge !== undefined && tab.badge !== null ? <span className="ui-tab__badge">{tab.badge}</span> : null}
          </button>
        </Fragment>
      ))}
    </div>
  );
}
