import { describe, expect, it } from 'vitest';
import {
  createLogger,
  envLogLevel,
  isLogLevel,
  LOG_LEVELS,
  newCorrelationId,
  replaceBigints,
  silentLogger,
  withBindings,
  withCorrelationId,
} from '../src/logger.js';

/** Collects the JSON lines a pino logger writes, without touching the filesystem. */
function capture() {
  const lines: Record<string, unknown>[] = [];
  const stream = {
    write(chunk: string) {
      lines.push(JSON.parse(chunk));
    },
  };
  return { lines, stream };
}

describe('log levels', () => {
  it('knows its own levels', () => {
    expect(LOG_LEVELS).toContain('silent');
    expect(LOG_LEVELS).toContain('info');
    expect(isLogLevel('debug')).toBe(true);
    expect(isLogLevel('verbose')).toBe(false);
    expect(isLogLevel(3)).toBe(false);
  });

  it('reads ARCDRIP_LOG_LEVEL and falls back to silent', () => {
    expect(envLogLevel({ ARCDRIP_LOG_LEVEL: 'warn' })).toBe('warn');
    expect(envLogLevel({ ARCDRIP_LOG_LEVEL: 'shout' })).toBe('silent');
    expect(envLogLevel({})).toBe('silent');
  });

  it('is silent by default, so a library never spams its host', () => {
    const { lines, stream } = capture();
    const log = createLogger({ destination: stream });
    expect(log.level).toBe('silent');
    log.info('ignored');
    log.error('ignored too');
    expect(lines).toHaveLength(0);
  });

  it('writes JSON lines once a level is set', () => {
    const { lines, stream } = capture();
    createLogger({ level: 'info', destination: stream }).info({ poolId: 1n }, 'created');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ msg: 'created', poolId: '1', name: '@arcdrip/sdk' });
  });

  it('respects the level threshold', () => {
    const { lines, stream } = capture();
    const log = createLogger({ level: 'warn', destination: stream });
    log.info('dropped');
    log.warn('kept');
    expect(lines).toHaveLength(1);
    expect(lines[0]!.msg).toBe('kept');
  });
});

describe('correlation ids', () => {
  it('binds a correlationId to every line', () => {
    const { lines, stream } = capture();
    const log = createLogger({ level: 'info', correlationId: 'corr-1', destination: stream });
    log.info('one');
    log.info('two');
    expect(lines.map((l) => l.correlationId)).toEqual(['corr-1', 'corr-1']);
  });

  it('lets a child override the correlationId without touching the parent', () => {
    const { lines, stream } = capture();
    const parent = createLogger({ level: 'info', correlationId: 'parent', destination: stream });
    withCorrelationId(parent, 'child').info('from child');
    parent.info('from parent');
    expect(lines.map((l) => l.correlationId)).toEqual(['child', 'parent']);
  });

  it('generates unique ids with a readable prefix', () => {
    const a = newCorrelationId();
    const b = newCorrelationId('pool');
    expect(a.startsWith('drip-')).toBe(true);
    expect(b.startsWith('pool-')).toBe(true);
    expect(a).not.toBe(newCorrelationId());
  });

  it('adds bindings and correlation ids to a child logger', () => {
    const base = silentLogger();
    const child = withBindings(withCorrelationId(base, 'abc'), { poolId: 7 });
    expect(child.bindings().correlationId).toBe('abc');
    expect(child.bindings().poolId).toBe(7);
  });
});

describe('bigint serialisation', () => {
  it('turns bigints into decimal strings so JSON.stringify never throws', () => {
    expect(replaceBigints(10n ** 30n)).toBe('1000000000000000000000000000000');
    expect(replaceBigints({ amount: 5n, nested: { rate: 1n } })).toEqual({
      amount: '5',
      nested: { rate: '1' },
    });
    expect(replaceBigints([1n, 2n])).toEqual(['1', '2']);
  });

  it('leaves non-bigints alone and survives a cycle', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(replaceBigints(cyclic)).toEqual({ a: 1, self: '[circular]' });
    expect(replaceBigints('x')).toBe('x');
    expect(replaceBigints(null)).toBe(null);
  });

  it('logs a bigint amount without throwing', () => {
    const log = createLogger({ level: 'silent' });
    expect(() => log.info({ amount: 123n }, 'paid')).not.toThrow();
  });
});
