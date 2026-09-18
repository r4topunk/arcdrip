// Every error the app can hit, mapped to one plain sentence in the active language: DripPool custom errors
// (PRD 4.4), USDC revert strings, wallet rejection, RPC failures and the SDK's own errors.
//
// The SDK already decodes reverts for us. A refused write comes back as `{ ok: false, error: DecodedRevert }`
// rather than as an exception, so both paths land here: `revertMessage` for the value, `errorMessage` for a throw.
import {
  ArcDripError,
  ContractRevertError,
  type DecodedRevert,
  type DripErrorName,
  decodeRevert,
  InvalidInputError,
} from '@arcdrip/sdk';
import {
  BaseError,
  ChainMismatchError,
  HttpRequestError,
  InsufficientFundsError,
  TimeoutError,
  UserRejectedRequestError,
} from 'viem';
import { config } from './config';
import { type Locale, type MessageKey, translate, type Vars } from './i18n';

/** Every custom error the DripPool ABI can revert with, with its message key. A new ABI error fails typecheck here. */
export const CONTRACT_ERROR_KEYS: Record<DripErrorName, MessageKey> = {
  PoolNotFound: 'error.contract.PoolNotFound',
  NotOwner: 'error.contract.NotOwner',
  NotPendingOwner: 'error.contract.NotPendingOwner',
  PoolCancelled: 'error.contract.PoolCancelled',
  ZeroAddress: 'error.contract.ZeroAddress',
  ZeroAmount: 'error.contract.ZeroAmount',
  BadRate: 'error.contract.BadRate',
  BadShares: 'error.contract.BadShares',
  BadStartTime: 'error.contract.BadStartTime',
  BadPayout: 'error.contract.BadPayout',
  NoOp: 'error.contract.NoOp',
  NothingToWithdraw: 'error.contract.NothingToWithdraw',
  InsufficientUnstreamed: 'error.contract.InsufficientUnstreamed',
  LengthMismatch: 'error.contract.LengthMismatch',
  TooManyItems: 'error.contract.TooManyItems',
  ReentrancyGuardReentrantCall: 'error.contract.ReentrancyGuardReentrantCall',
  SafeERC20FailedOperation: 'error.contract.SafeERC20FailedOperation',
};

export interface ErrorDescription {
  key: MessageKey;
  vars?: Vars;
}

/** FiatToken (USDC) revert strings to messages. */
function describeRevertString(reason: string): ErrorDescription {
  const r = reason.toLowerCase();
  if (r.includes('blacklisted') || r.includes('blocklisted')) return { key: 'error.usdc.blocklisted' };
  if (r.includes('allowance')) return { key: 'error.usdc.allowance' };
  if (r.includes('exceeds balance') || r.includes('insufficient balance'))
    return { key: 'error.usdc.balance' };
  if (r.includes('paused')) return { key: 'error.usdc.paused' };
  return { key: 'error.revertReason', vars: { reason } };
}

/** A revert the SDK already decoded (the `{ ok: false }` branch of every write). */
export function describeRevert(revert: DecodedRevert): ErrorDescription {
  const key = CONTRACT_ERROR_KEYS[revert.name as DripErrorName];
  if (key) return { key };
  if (revert.name === 'Error') return describeRevertString(String(revert.args?.[0] ?? revert.message));
  if (revert.name === 'Panic') return { key: 'error.panic', vars: { code: String(revert.args?.[0] ?? '?') } };
  if (revert.kind === 'token') return describeRevertString(revert.message);
  return { key: 'error.unknownRevert' };
}

/** One sentence for a refused write. */
export function revertMessage(revert: DecodedRevert, locale: Locale): string {
  const d = describeRevert(revert);
  return translate(locale, d.key, d.vars);
}

const REJECTED = /user rejected|user denied|rejected the request|request rejected|denied transaction/i;
const UNREACHABLE = /http request failed|fetch failed|failed to fetch|networkerror|timed? ?out|load failed/i;

/** Classifies any thrown value. */
export function describeError(err: unknown): ErrorDescription {
  if (err instanceof InvalidInputError)
    return { key: 'error.invalidInput', vars: { details: err.issues.join('; ') } };
  if (err instanceof ContractRevertError) return describeRevert(err.reason);
  if (err instanceof ArcDripError) {
    switch (err.code) {
      case 'WALLET_REQUIRED':
        return { key: 'error.wallet.notConnected' };
      case 'POOL_NOT_FOUND':
        return { key: 'error.noDrip' };
      case 'TX_REVERTED':
        return { key: 'error.txReverted' };
      case 'EVENT_NOT_FOUND':
        return { key: 'error.eventNotFound' };
      default:
        return { key: 'error.generic', vars: { message: err.message } };
    }
  }
  if (err instanceof BaseError) {
    if (err.walk((x) => x instanceof UserRejectedRequestError)) return { key: 'error.wallet.rejected' };
    if (err.walk((x) => x instanceof InsufficientFundsError))
      return { key: 'error.wallet.insufficientFunds' };
    if (err.walk((x) => x instanceof ChainMismatchError))
      return { key: 'error.wallet.wrongChain', vars: { chain: config.chainLabel, chainId: config.chainId } };
    if (err.walk((x) => x instanceof HttpRequestError || x instanceof TimeoutError))
      return { key: 'error.rpc.unreachable' };
    const decoded = decodeRevert(err);
    if (decoded.name !== 'Unknown') return describeRevert(decoded);
    const msg = `${err.shortMessage} ${err.message}`;
    if (REJECTED.test(msg)) return { key: 'error.wallet.rejected' };
    if (UNREACHABLE.test(msg)) return { key: 'error.rpc.unreachable' };
    return { key: 'error.generic', vars: { message: err.shortMessage || err.message } };
  }
  // wagmi throws its own BaseError (not viem's) for connector state.
  if (err instanceof Error && /^Connector(NotConnected|AccountNotFound)Error$/.test(err.name))
    return { key: 'error.wallet.notConnected' };
  // A raw EIP-1193 error object from an injected wallet.
  if (typeof err === 'object' && err !== null && 'code' in err && (err as { code: unknown }).code === 4001)
    return { key: 'error.wallet.rejected' };
  if (err instanceof Error) {
    if (REJECTED.test(err.message)) return { key: 'error.wallet.rejected' };
    if (err.name === 'ProviderNotFoundError' || /provider not found/i.test(err.message))
      return { key: 'wallet.noProvider' };
    if (UNREACHABLE.test(err.message)) return { key: 'error.rpc.unreachable' };
    return { key: 'error.generic', vars: { message: err.message } };
  }
  return { key: 'error.generic', vars: { message: String(err) } };
}

/** One sentence for `err` in `locale`. */
export function errorMessage(err: unknown, locale: Locale): string {
  const d = describeError(err);
  return translate(locale, d.key, d.vars);
}
