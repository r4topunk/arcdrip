// ArcDrip end-to-end run on Arc testnet (chain 5042002) — PRD section 8.4.
// Idempotent, three keystores, prints every tx hash. `--dry-run` targets a local anvil instead.
// Scaffold: the real sequence (create pool, shares, deposit, withdraw, freeze, batch, cancel) lands in phase 3.
const dryRun = process.argv.includes('--dry-run');
console.log(`arcdrip e2e: not implemented yet (dryRun=${dryRun})`);
process.exit(1);
