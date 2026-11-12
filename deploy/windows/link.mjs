// Prints this computer's public AlgoTrade link (Tailscale Funnel) and puts a shortcut to it on the Desktop.
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const candidates = ['tailscale', join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Tailscale', 'tailscale.exe')];
let status;
for (const exe of candidates) {
  try {
    status = JSON.parse(execFileSync(exe, ['status', '--json'], { encoding: 'utf8', windowsHide: true }));
    break;
  } catch {
    /* try the next location */
  }
}
const name = status?.Self?.DNSName?.replace(/\.$/, '');
if (!name) {
  console.log('Could not read the Tailscale name of this computer. Is Tailscale running and signed in?');
  process.exit(1);
}
const url = `https://${name}`;
const desktops = [join(homedir(), 'OneDrive', 'Desktop'), join(homedir(), 'Desktop')].filter((d) => existsSync(d));
for (const d of desktops.slice(0, 1)) writeFileSync(join(d, 'AlgoTrade link.url'), `[InternetShortcut]\r\nURL=${url}\r\n`);
writeFileSync(join(process.cwd(), 'MY-ALGOTRADE-LINK.txt'), `${url}\r\n`);
console.log(url);
