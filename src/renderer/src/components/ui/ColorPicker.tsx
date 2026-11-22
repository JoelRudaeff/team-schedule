import { useEffect, useState, type ReactNode } from 'react';
import { DEFAULT_SUBJECT_COLORS, contrastText, hexToRgb, normalizeHex, rgbToHex, type Rgb } from '@shared/colors';
import { useT } from '../../i18n/useT';
import type { ColorPickerProps } from './types';

type Channel = keyof Rgb;

const CHANNELS: readonly Channel[] = ['r', 'g', 'b'];

/** RGB colour editor: presets, one slider + number box per channel, a hex box and a preview. */
export function ColorPicker({ value, onChange, presets = DEFAULT_SUBJECT_COLORS, testId }: ColorPickerProps): ReactNode {
  const { t } = useT();
  const current = normalizeHex(value) ?? '#000000';
  const rgb = hexToRgb(current);
  const [hexDraft, setHexDraft] = useState(current);

  // The hex box follows changes made with the sliders or presets.
  useEffect(() => setHexDraft(current), [current]);

  const setChannel = (channel: Channel, raw: number): void => {
    const next = { ...rgb, [channel]: Math.min(255, Math.max(0, Math.round(Number.isFinite(raw) ? raw : 0))) };
    onChange(rgbToHex(next.r, next.g, next.b));
  };

  const commitHex = (): void => {
    const parsed = normalizeHex(hexDraft);
    if (parsed) onChange(parsed);
    else setHexDraft(current);
  };

  const labels: Record<Channel, string> = { r: t('ui.colorRed'), g: t('ui.colorGreen'), b: t('ui.colorBlue') };
  const gradient = (channel: Channel): string => {
    const from = { ...rgb, [channel]: 0 };
    const to = { ...rgb, [channel]: 255 };
    return `linear-gradient(to right, ${rgbToHex(from.r, from.g, from.b)}, ${rgbToHex(to.r, to.g, to.b)})`;
  };

  return (
    <div className="ui-color" data-testid={testId}>
      <div className="ui-color__preview" style={{ background: current, color: contrastText(current) }}>
        <span>{t('ui.colorPreview')}</span>
        <span className="ltr mono">{current}</span>
      </div>

      <div className="ui-color__presets" role="listbox" aria-label={t('ui.colorPresets')}>
        {presets.map((preset) => (
          <button
            key={preset}
            type="button"
            role="option"
            aria-selected={preset === current}
            aria-label={preset}
            title={preset}
            className={`ui-color__swatch${preset === current ? ' is-selected' : ''}`}
            style={{ background: preset }}
            onClick={() => onChange(preset)}
            data-testid={testId ? `${testId}-preset-${preset.slice(1)}` : undefined}
          />
        ))}
      </div>

      {/* Sliders always run left to right: 0 on the left, 255 on the right. */}
      <div className="ui-color__channels ltr">
        {CHANNELS.map((channel) => (
          <label key={channel} className="ui-color__channel">
            <span className="ui-color__letter" title={labels[channel]}>
              {channel.toUpperCase()}
            </span>
            <input
              type="range"
              min={0}
              max={255}
              step={1}
              value={rgb[channel]}
              aria-label={labels[channel]}
              style={{ background: gradient(channel) }}
              onChange={(event) => setChannel(channel, Number(event.target.value))}
              data-testid={testId ? `${testId}-${channel}-slider` : undefined}
            />
            <input
              type="number"
              className="ui-input ui-input--number"
              min={0}
              max={255}
              step={1}
              value={rgb[channel]}
              aria-label={labels[channel]}
              onChange={(event) => setChannel(channel, Number(event.target.value))}
              data-testid={testId ? `${testId}-${channel}` : undefined}
            />
          </label>
        ))}
      </div>

      <label className="ui-color__hex">
        <span>{t('ui.colorHex')}</span>
        <input
          type="text"
          className={`ui-input ltr mono${normalizeHex(hexDraft) ? '' : ' is-invalid'}`}
          value={hexDraft}
          maxLength={7}
          spellCheck={false}
          onChange={(event) => setHexDraft(event.target.value)}
          onBlur={commitHex}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commitHex();
            }
          }}
          data-testid={testId ? `${testId}-hex` : undefined}
        />
      </label>
    </div>
  );
}
