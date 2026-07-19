import { createInterface } from 'readline';

export function prompt(q: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(q, (ans) => {
      rl.close();
      resolve(ans.trim());
    })
  );
}

export function promptPassword(q: string): Promise<string> {
  return new Promise((resolve) => {
    const stdout = process.stdout;
    const stdin = process.stdin;

    stdout.write(q);

    let password = '';

    // Use raw mode for hidden input if available (TTY on Unix/macOS, Windows Terminal)
    if (stdin.isTTY && typeof (stdin as NodeJS.ReadStream & { setRawMode?: (mode: boolean) => void }).setRawMode === 'function') {
      const rawStdin = stdin as NodeJS.ReadStream & { setRawMode: (mode: boolean) => void };
      rawStdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding('utf8');

      const onData = (ch: string) => {
        switch (ch) {
          case '\n':
          case '\r':
          case '\u0004': // Ctrl+D
            stdin.removeListener('data', onData);
            rawStdin.setRawMode(false);
            stdin.pause();
            stdout.write('\n');
            resolve(password);
            break;
          case '\u0003': // Ctrl+C
            process.exit(0);
            break;
          case '\u007f': // Backspace (DEL)
          case '\b':     // Backspace on some terminals
            if (password.length > 0) {
              password = password.slice(0, -1);
              stdout.write('\b \b');
            }
            break;
          default:
            // Only accept printable ASCII characters
            if (ch.length === 1 && ch >= ' ' && ch <= '~') {
              password += ch;
              stdout.write('*');
            }
            break;
        }
      };

      stdin.on('data', onData);
    } else {
      // Non-TTY fallback (piped input, CI, etc.)
      // Print a warning that input will be visible
      if (!stdin.isTTY) {
        stdout.write(' [input will be visible] ');
      }
      const rl = createInterface({ input: stdin, output: stdout });
      rl.question('', (ans) => {
        rl.close();
        resolve(ans.trim());
      });
    }
  });
}

export async function promptConfirm(q: string, defaultYes = true): Promise<boolean> {
  const suffix = defaultYes ? ' (Y/n): ' : ' (y/N): ';
  const answer = await prompt(q + suffix);
  if (!answer) return defaultYes;
  return answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes';
}

export async function promptDefault(q: string, defaultValue: string): Promise<string> {
  const answer = await prompt(`${q}${defaultValue ? ` [${defaultValue}]` : ''}: `);
  return answer || defaultValue;
}

export async function promptValidated(
  q: string,
  validate: (value: string) => string,
  defaultValue = ''
): Promise<string> {
  try {
    return validate(await promptDefault(q, defaultValue));
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return promptValidated(q, validate, defaultValue);
  }
}

export async function promptSelect<T extends string>(q: string, choices: { label: string; value: T }[]): Promise<T> {
  console.log();
  console.log(q);
  choices.forEach((c, i) => {
    console.log(`  ${i + 1}. ${c.label}`);
  });
  const answer = await prompt('Select: ');
  const idx = parseInt(answer, 10) - 1;
  if (idx >= 0 && idx < choices.length) {
    return choices[idx].value;
  }
  console.log('Invalid selection. Please try again.');
  return promptSelect(q, choices);
}
