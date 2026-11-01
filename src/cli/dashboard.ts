import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from '../config';
import { researchCompany } from '../research/research';
import { LiveResearchSources } from '../research/sources';
import { createDashboardServer } from '../web/server';

// Usage: npm run dashboard   then open http://localhost:3000
// Listens on this computer only (127.0.0.1). Research only: it cannot place orders.
const port = Number(process.env.DASHBOARD_PORT ?? 3000);
const sources = new LiveResearchSources();
const html = readFileSync(resolve(ROOT, 'src/web/public/index.html'), 'utf8');
const chartJs = readFileSync(resolve(ROOT, 'node_modules/chart.js/dist/chart.umd.js'), 'utf8');
createDashboardServer({
  html,
  assets: { '/vendor/chart.umd.js': { body: chartJs, type: 'text/javascript; charset=utf-8' } },
  research: (symbol, peers) => researchCompany(symbol, sources, { peers }),
})
  .listen(port, '127.0.0.1', () => console.log(`Research dashboard: http://localhost:${port}  (Ctrl+C to stop)`))
  .on('error', (e) => {
    console.error(`Could not start the dashboard on port ${port}: ${e.message}. Try: set DASHBOARD_PORT=3001 && npm run dashboard`);
    process.exit(1);
  });
