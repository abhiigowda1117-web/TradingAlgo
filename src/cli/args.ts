/** Tiny `--flag` / `--key value` parser. */
export function parseArgs(argv = process.argv.slice(2)): { flags: Set<string>; opts: Record<string, string>; positional: string[] } {
  const flags = new Set<string>();
  const opts: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) positional.push(a);
    else if (a.includes('=')) {
      const [k, ...v] = a.slice(2).split('=');
      opts[k!] = v.join('=');
    } else if (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith('--')) opts[a.slice(2)] = argv[++i]!;
    else flags.add(a.slice(2));
  }
  return { flags, opts, positional };
}

export const symbolList = (s: string | undefined) =>
  s
    ?.split(',')
    .map((x) => x.trim().toUpperCase())
    .filter(Boolean);
