import { describe, expect, it } from 'vitest';
import { clockOffset } from '@/components/queries';
import { parseConfig } from '@/lib/config';

describe('build configuration', () => {
  it('defaults to Arc mainnet with no DripPool and native USDC', () => {
    const c = parseConfig({});
    expect(c.chainId).toBe(5042);
    expect(c.rpcUrl).toBe('https://rpc.mainnet.arc.io');
    expect(c.drip).toBeNull();
    expect(c.usdc).toBe('0x3600000000000000000000000000000000000000');
    expect(c.problems).toEqual([]);
  });

  it('treats a placeholder or zero address as "not configured"', () => {
    expect(parseConfig({ NEXT_PUBLIC_DRIP_ADDRESS: '[ADDRESS]' }).drip).toBeNull();
    expect(
      parseConfig({ NEXT_PUBLIC_DRIP_ADDRESS: '0x0000000000000000000000000000000000000000' }).drip,
    ).toBeNull();
  });

  it('checksums a configured address and warns about a missing deploy block', () => {
    const c = parseConfig({
      NEXT_PUBLIC_CHAIN_ID: '5042002',
      NEXT_PUBLIC_DRIP_ADDRESS: '0x1111111111111111111111111111111111111111',
    });
    expect(c.chainId).toBe(5042002);
    expect(c.drip).toBe('0x1111111111111111111111111111111111111111');
    expect(c.problems.join(' ')).toMatch(/DEPLOY_BLOCK/);
  });

  it('accepts a local anvil with a mock USDC and no deploy-block warning', () => {
    const c = parseConfig({
      NEXT_PUBLIC_CHAIN_ID: '31337',
      NEXT_PUBLIC_DRIP_ADDRESS: '0x2222222222222222222222222222222222222222',
      NEXT_PUBLIC_USDC_ADDRESS: '0x3333333333333333333333333333333333333333',
    });
    expect(c.chainLabel).toBe('Local anvil');
    expect(c.explorerUrl).toBeNull();
    expect(c.usdc).toBe('0x3333333333333333333333333333333333333333');
    expect(c.problems).toEqual([]);
  });

  it('reports an unsupported chain id instead of silently using it', () => {
    expect(parseConfig({ NEXT_PUBLIC_CHAIN_ID: '1' }).problems.join(' ')).toMatch(/not supported/);
  });

  it('trims trailing slashes from urls so links never double up', () => {
    const c = parseConfig({
      NEXT_PUBLIC_SITE_URL: 'https://example.com/',
      NEXT_PUBLIC_BASE_PATH: '/sharedarc/',
    });
    expect(c.siteUrl).toBe('https://example.com');
    expect(c.basePath).toBe('/sharedarc');
  });
});

describe('chain clock', () => {
  it('ignores sub-10-second disagreement (latency, not drift) and applies the rest', () => {
    expect(clockOffset(1_000, 1_000)).toBe(0);
    expect(clockOffset(1_009, 1_000)).toBe(0);
    expect(clockOffset(1_030, 1_000)).toBe(30);
    expect(clockOffset(1_000, 1_030)).toBe(-30);
  });
});
