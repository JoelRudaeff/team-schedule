import { useEffect, useState, type ReactNode } from 'react';
import { nextPaletteColor } from '@shared/colors';
import { countEntityUsage, entityList, findEntityByName } from '@shared/model';
import type { EntityKind, NamedItem } from '@shared/types';
import type { MessageKey } from '../../i18n';
import { useT } from '../../i18n/useT';
import { actions, useApp } from '../../store';
import { Button, ColorPicker, EmptyState, IconButton, Modal, Popover, TextInput } from '../ui';

const NEW_PLACEHOLDER: Record<EntityKind, MessageKey> = {
  subject: 'settings.newSubject',
  location: 'settings.newLocation',
  teacher: 'settings.newTeacher',
  class: 'settings.newClass',
};

/** The colour of a subject: a swatch that opens the RGB editor. The change is applied when the editor closes. */
function ColorButton({ id, color }: { id: string; color: string }): ReactNode {
  const { t } = useT();
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(color);

  useEffect(() => {
    if (!open) setDraft(color);
  }, [color, open]);

  const close = (): void => {
    setOpen(false);
    // One undo step per colour change, not one per slider movement.
    if (draft !== color) actions.updateEntity('subject', id, { color: draft });
  };

  return (
    <>
      <button
        ref={setAnchor}
        type="button"
        className="st-swatch"
        style={{ background: open ? draft : color }}
        title={t('settings.changeColor')}
        aria-label={t('settings.changeColor')}
        onClick={() => (open ? close() : setOpen(true))}
        data-testid={`entity-color-${id}`}
      />
      <Popover anchor={anchor} open={open} onClose={close} ariaLabel={t('settings.changeColor')}>
        <ColorPicker value={draft} onChange={setDraft} testId="entity-color-picker" />
      </Popover>
    </>
  );
}

function Row({ kind, item, usage, onRemove }: { kind: EntityKind; item: NamedItem; usage: number; onRemove: () => void }): ReactNode {
  const { t, tn } = useT();
  const config = useApp((s) => s.working.config);
  const [name, setName] = useState(item.name);
  useEffect(() => setName(item.name), [item.name]);

  const trimmed = name.trim();
  const twin = findEntityByName(config, kind, trimmed);
  const duplicate = twin !== undefined && twin.id !== item.id;

  const commit = (): void => {
    if (trimmed === '' || duplicate) setName(item.name);
    else if (trimmed !== item.name) actions.updateEntity(kind, item.id, { name: trimmed });
  };

  return (
    <li className="st-row" data-testid={`entity-row-${item.id}`}>
      {kind === 'subject' && 'color' in item && typeof item.color === 'string' ? <ColorButton id={item.id} color={item.color} /> : null}
      <div className="st-row__name">
        <TextInput
          value={name}
          onChange={setName}
          onBlur={commit}
          onEnter={commit}
          invalid={duplicate}
          aria-label={t('settings.itemName')}
          maxLength={80}
          testId={`entity-name-${item.id}`}
        />
        {duplicate ? <span className="st-row__error">{t('settings.nameExists')}</span> : null}
      </div>
      <span className="st-row__usage faint">{usage > 0 ? tn('settings.usedBy', usage) : t('settings.unused')}</span>
      <IconButton icon="trash" variant="danger" label={t('settings.remove')} onClick={onRemove} testId={`entity-remove-${item.id}`} />
    </li>
  );
}

/** Add, rename and remove the entries of one list (subjects, locations, teachers or classes). */
export function EntityListEditor({ kind }: { kind: EntityKind }): ReactNode {
  const { t, tn } = useT();
  const working = useApp((s) => s.working);
  const items = entityList(working.config, kind);
  const [name, setName] = useState('');
  const [color, setColor] = useState(() => nextPaletteColor(working.config.subjects.map((subject) => subject.color)));
  const [removing, setRemoving] = useState<NamedItem | null>(null);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [picking, setPicking] = useState(false);

  const trimmed = name.trim();
  const exists = trimmed !== '' && findEntityByName(working.config, kind, trimmed) !== undefined;

  const add = (): void => {
    if (trimmed === '' || exists) return;
    actions.addEntity(kind, trimmed, kind === 'subject' ? color : undefined);
    setName('');
    setColor(nextPaletteColor([...working.config.subjects.map((subject) => subject.color), color]));
  };

  const remove = (item: NamedItem): void => {
    // Something that is in use is only removed after the consequence was confirmed.
    if (countEntityUsage(working, kind, item.id) > 0) setRemoving(item);
    else actions.removeEntity(kind, item.id);
  };

  return (
    <div className="st-list" data-testid={`entity-list-${kind}`}>
      <div className="st-add">
        {kind === 'subject' ? (
          <>
            <button
              ref={setAnchor}
              type="button"
              className="st-swatch"
              style={{ background: color }}
              title={t('settings.changeColor')}
              aria-label={t('settings.changeColor')}
              onClick={() => setPicking((value) => !value)}
              data-testid="entity-new-color"
            />
            <Popover anchor={anchor} open={picking} onClose={() => setPicking(false)} ariaLabel={t('settings.changeColor')}>
              <ColorPicker value={color} onChange={setColor} testId="entity-new-color-picker" />
            </Popover>
          </>
        ) : null}
        <div className="st-row__name">
          <TextInput value={name} onChange={setName} onEnter={add} placeholder={t(NEW_PLACEHOLDER[kind])} invalid={exists} maxLength={80} testId="entity-new-name" />
          {exists ? <span className="st-row__error">{t('settings.nameExists')}</span> : null}
        </div>
        <Button variant="primary" icon="plus" disabled={trimmed === '' || exists} onClick={add} testId="entity-add">
          {t('settings.add')}
        </Button>
      </div>

      {items.length === 0 ? (
        <EmptyState icon="inbox" title={t('settings.emptyList')} text={t('settings.emptyListHint')} />
      ) : (
        <ul className="st-rows">
          {items.map((item) => (
            <Row key={item.id} kind={kind} item={item} usage={countEntityUsage(working, kind, item.id)} onRemove={() => remove(item)} />
          ))}
        </ul>
      )}

      {removing ? (
        <Modal
          title={t('settings.removeTitle', { name: removing.name })}
          icon="warning"
          tone="danger"
          size="sm"
          onClose={() => setRemoving(null)}
          testId="entity-remove-dialog"
          footer={
            <>
              <Button onClick={() => setRemoving(null)}>{t('common.cancel')}</Button>
              <Button
                variant="danger"
                onClick={() => {
                  actions.removeEntity(kind, removing.id);
                  setRemoving(null);
                }}
                testId="entity-remove-confirm"
                data-autofocus
              >
                {t('settings.remove')}
              </Button>
            </>
          }
        >
          <p>{tn('settings.removeText', countEntityUsage(working, kind, removing.id))}</p>
        </Modal>
      ) : null}
    </div>
  );
}
