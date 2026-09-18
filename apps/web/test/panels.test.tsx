import type { AccrualPool, MemberRow } from '@sharedarc/sdk';
import { toRatePerSecond } from '@sharedarc/sdk';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/components/i18n';
import { MemberTable } from '@/components/pool/member-table';
import { StatusChip } from '@/components/status-chip';
import { isOwner, isPendingOwner, ownerActionsDisabled } from '@/lib/pool';

const A = '0x1111111111111111111111111111111111111111' as const;
const B = '0x2222222222222222222222222222222222222222' as const;
const ZERO = '0x0000000000000000000000000000000000000000' as const;

const pool: AccrualPool = {
  startTime: 0n,
  lastAccrual: 0n,
  cancelled: false,
  ratePerSecond: toRatePerSecond({ amount: '3', per: 'day' }),
  totalShares: 4n,
  balance: 1_000_000n,
  owed: 0n,
  accIndex: 0n,
};

const row = (address: string, over: Partial<MemberRow> = {}): MemberRow =>
  ({
    address,
    shares: 1n,
    index: 0n,
    pending: 0n,
    payout: ZERO,
    formerMember: false,
    claimable: 1_000n,
    shareFraction: 0.25,
    ...over,
  }) as MemberRow;

const wrap = (ui: React.ReactElement) => render(<I18nProvider>{ui}</I18nProvider>);

describe('member table gating', () => {
  it('offers Withdraw on the connected wallet row and Pay on the others', () => {
    wrap(
      <MemberTable
        pool={pool}
        rows={[row(A), row(B)]}
        account={A}
        onWithdraw={() => {}}
        onWithdrawFor={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: 'Withdraw' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Pay' })).toBeEnabled();
    expect(screen.getByText('you')).toBeInTheDocument();
  });

  it('shows no Withdraw button at all without a connected wallet', () => {
    wrap(<MemberTable pool={pool} rows={[row(A)]} onWithdrawFor={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Withdraw' })).toBeNull();
  });

  it('disables a payout that the contract would refuse with NothingToWithdraw', () => {
    const onWithdrawFor = vi.fn();
    wrap(<MemberTable pool={pool} rows={[row(B, { claimable: 0n })]} onWithdrawFor={onWithdrawFor} />);
    const button = screen.getByRole('button', { name: 'Pay' });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onWithdrawFor).not.toHaveBeenCalled();
  });

  it('marks a member who left but still has funds waiting', () => {
    wrap(<MemberTable pool={pool} rows={[row(B, { shares: 0n, formerMember: true })]} />);
    expect(screen.getByText('left')).toBeInTheDocument();
  });

  it('says so instead of rendering an empty table', () => {
    wrap(<MemberTable pool={pool} rows={[]} />);
    expect(screen.getByText(/no members yet/i)).toBeInTheDocument();
  });

  it('names a payout address that is not the member’s own', () => {
    wrap(<MemberTable pool={pool} rows={[row(A, { payout: B })]} />);
    expect(screen.getByText(/paid to 0x2222…2222/)).toBeInTheDocument();
  });
});

describe('owner and pending-owner gating', () => {
  it('only the owner passes the owner-panel gate', () => {
    const state = { owner: A, pendingOwner: ZERO };
    expect(isOwner(state, A)).toBe(true);
    expect(isOwner(state, B)).toBe(false);
  });

  it('only the pending owner passes the accept gate', () => {
    const state = { owner: A, pendingOwner: B };
    expect(isPendingOwner(state, B)).toBe(true);
    expect(isPendingOwner(state, A)).toBe(false);
  });

  it('disables every owner action once the pool is cancelled', () => {
    expect(ownerActionsDisabled({ cancelled: true })).toBe(true);
    expect(ownerActionsDisabled({ cancelled: false })).toBe(false);
    expect(ownerActionsDisabled(undefined)).toBe(false);
  });
});

describe('status chip', () => {
  it('labels the status and explains it to a screen reader', () => {
    wrap(<StatusChip status="frozen" />);
    expect(screen.getByText('Frozen')).toBeInTheDocument();
    expect(screen.getByText(/ran out of funds/i)).toBeInTheDocument();
  });

  it('translates with the locale', () => {
    render(
      <I18nProvider initialLocale="pt-BR">
        <StatusChip status="streaming" />
      </I18nProvider>,
    );
    expect(screen.getByText('Fluindo')).toBeInTheDocument();
  });
});
