// CLI option helpers.
//
// Commander drops a subcommand option from the parsed opts when an option of the
// same name also exists on the parent program (e.g. the top-level `--profile`
// for `publish` shadows the `--profile` on the hidden `deploy`/`setup`/`destroy`
// subcommands). `readRawOption` re-reads the value straight from argv so callers
// can recover it; `getCommandOptions` layers that recovery over commander's opts.

export function readRawOption(
  name: string,
  argv: string[] = process.argv.slice(2)
): string | boolean | undefined {
  const flagName = name.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
  const longFlag = `--${flagName}`;

  for (let i = argv.length - 1; i >= 0; i--) {
    const arg = argv[i];
    if (arg === longFlag) {
      const next = argv[i + 1];
      if (!next || next.startsWith('-')) return true;
      return next;
    }
    if (arg.startsWith(`${longFlag}=`)) {
      return arg.slice(longFlag.length + 1);
    }
  }

  return undefined;
}

export function getCommandOptions(
  args: any[],
  fallbackKeys: string[] = [],
  argv?: string[]
): Record<string, any> {
  const maybeCommand = args[args.length - 1];
  let options: Record<string, any> = {};
  if (maybeCommand && typeof maybeCommand.opts === 'function') {
    options = maybeCommand.opts();
  } else if (maybeCommand && typeof maybeCommand === 'object') {
    options = maybeCommand;
  }

  for (const key of fallbackKeys) {
    if (options[key] !== undefined) continue;
    const rawValue = readRawOption(key, argv);
    if (rawValue !== undefined) {
      options[key] = rawValue;
    }
  }

  return options;
}
