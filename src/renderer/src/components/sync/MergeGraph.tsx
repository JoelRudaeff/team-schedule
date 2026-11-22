import type { ReactNode } from 'react';
import type { CommitInfo } from '@shared/api';
import { useT } from '../../i18n/useT';
import { readableCommitSubject } from '../../lib/commitText';
import { formatRelative } from '../../lib/format';

const WIDTH = 760;
const HEIGHT = 132;
const MID = 66;
const TEAM_Y = 30;
const MINE_Y = 102;
const BASE_X = 160;
const RESULT_X = 690;
const LANE_FROM = 250;
const LANE_TO = 600;
const MAX_DOTS = 5;

interface MergeGraphProps {
  incoming: readonly CommitInfo[];
  mineCount: number;
  conflictCount: number;
}

/**
 * The picture of the situation: from the last shared version two lines run on — the team's
 * commits above, my unpublished changes below — and meet in the result. In Hebrew the
 * drawing is mirrored, so time still flows in reading direction.
 */
export function MergeGraph({ incoming, mineCount, conflictCount }: MergeGraphProps): ReactNode {
  const tr = useT();
  const { t, tn, lang, dir } = tr;
  const x = (value: number): number => (dir === 'rtl' ? WIDTH - value : value);
  // Oldest first: the line is a time line.
  const commits = [...incoming].reverse();
  const shown = commits.slice(-MAX_DOTS);
  const hidden = commits.length - shown.length;
  const step = (LANE_TO - LANE_FROM) / (shown.length + 1);

  const lane = (y: number): string =>
    `M ${x(BASE_X)} ${MID} C ${x(BASE_X + 50)} ${MID}, ${x(LANE_FROM - 50)} ${y}, ${x(LANE_FROM)} ${y} ` +
    `L ${x(LANE_TO)} ${y} C ${x(LANE_TO + 50)} ${y}, ${x(RESULT_X - 50)} ${MID}, ${x(RESULT_X)} ${MID}`;

  return (
    <svg className="sy-graph" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={t('sync.mergeSubtitle')} data-testid="merge-graph">
      <path className="sy-graph__lane sy-graph__lane--theirs" d={lane(TEAM_Y)} />
      <path className="sy-graph__lane sy-graph__lane--mine" d={lane(MINE_Y)} />

      {/* last shared version */}
      <circle className="sy-graph__node sy-graph__node--base" cx={x(BASE_X)} cy={MID} r={9} />
      {/* Beside the node, on its outer side, where no line runs ("end" is the outer side in both directions). */}
      <text className="sy-graph__caption" x={x(BASE_X - 18)} y={MID + 4} textAnchor="end">
        {t('sync.graphBase')}
      </text>

      {/* the team's commits */}
      <text className="sy-graph__label sy-graph__label--theirs" x={x(LANE_FROM - 14)} y={TEAM_Y - 12} textAnchor={dir === 'rtl' ? 'start' : 'end'}>
        {t('sync.graphTeam')}
      </text>
      {shown.map((commit, index) => {
        const cx = x(LANE_FROM + step * (index + 1));
        return (
          <g key={commit.sha}>
            <title>{`${commit.authorName} · ${formatRelative(commit.time, lang)}\n${readableCommitSubject(commit.subject, tr)}`}</title>
            <circle className="sy-graph__node sy-graph__node--theirs" cx={cx} cy={TEAM_Y} r={7} />
            <text className="sy-graph__author" x={cx} y={TEAM_Y + 22} textAnchor="middle">
              {commit.authorName.length > 14 ? `${commit.authorName.slice(0, 13)}…` : commit.authorName}
            </text>
          </g>
        );
      })}
      <text className="sy-graph__count sy-graph__count--theirs" x={x(LANE_TO + 6)} y={TEAM_Y - 12} textAnchor={dir === 'rtl' ? 'end' : 'start'}>
        {tn('sync.graphTeamCommits', commits.length)}
        {hidden > 0 ? ` (+${hidden})` : ''}
      </text>

      {/* my changes */}
      <text className="sy-graph__label sy-graph__label--mine" x={x(LANE_FROM - 14)} y={MINE_Y + 20} textAnchor={dir === 'rtl' ? 'start' : 'end'}>
        {t('sync.graphYou')}
      </text>
      <circle className="sy-graph__node sy-graph__node--mine" cx={x((LANE_FROM + LANE_TO) / 2)} cy={MINE_Y} r={7} />
      <text className="sy-graph__count sy-graph__count--mine" x={x((LANE_FROM + LANE_TO) / 2)} y={MINE_Y + 22} textAnchor="middle">
        {tn('sync.graphYourChanges', mineCount)}
      </text>

      {/* the result */}
      <circle className={`sy-graph__node sy-graph__node--result${conflictCount > 0 ? ' is-conflict' : ''}`} cx={x(RESULT_X)} cy={MID} r={13} />
      {conflictCount > 0 ? (
        <text className="sy-graph__mark" x={x(RESULT_X)} y={MID + 5} textAnchor="middle">
          !
        </text>
      ) : (
        <path className="sy-graph__check" d={`M ${x(RESULT_X) - 5} ${MID} l 4 4 l 7 -8`} />
      )}
      <text className={`sy-graph__caption${conflictCount > 0 ? ' is-conflict' : ' is-ok'}`} x={x(RESULT_X)} y={MID + 34} textAnchor="middle">
        {conflictCount > 0 ? tn('sync.graphCollisions', conflictCount) : t('sync.graphNoCollisions')}
      </text>
    </svg>
  );
}
