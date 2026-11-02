import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../config';
import { researchMarkdown } from '../research/markdown';
import { researchCompany } from '../research/research';
import { LiveResearchSources } from '../research/sources';
import { parseArgs, symbolList } from './args';

// Usage: npm run research -- HIKAL [--peers DIVISLAB,LAURUSLABS]
// Writes reports/research/<SYMBOL>-<date>.md and .json. Research only: never touches trading.
const { positional, opts } = parseArgs();
const symbol = positional[0];
if (!symbol) {
  console.error('Usage: npm run research -- <NSE SYMBOL> [--peers A,B,C]');
  process.exit(1);
}

try {
  const report = await researchCompany(symbol, new LiveResearchSources(), { peers: symbolList(opts.peers) });
  const dir = join(paths.reports, 'research');
  mkdirSync(dir, { recursive: true });
  const base = join(dir, `${report.symbol}-${report.generatedAt.slice(0, 10)}`);
  writeFileSync(`${base}.md`, researchMarkdown(report));
  writeFileSync(`${base}.json`, JSON.stringify(report, null, 2));
  for (const w of report.warnings) console.warn(`Warning: ${w}`);
  console.log(`\n${report.overview.name ?? report.symbol}: report written to\n  ${base}.md\n  ${base}.json`);
} catch (e) {
  console.error(`Research failed: ${(e as Error).message}`);
  process.exit(1);
}
