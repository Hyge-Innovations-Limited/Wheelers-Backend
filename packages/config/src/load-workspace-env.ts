import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

const WORKSPACE_ENV_PATH = resolve(__dirname, '../../..', '.env');

function stripMatchingQuotes(value: string): string {
  if (value.length < 2) {
    return value;
  }

  const first = value[0];
  const last = value[value.length - 1];

  if ((first === '"' || first === '\'') && last === first) {
    return value.slice(1, -1);
  }

  return value;
}

export function parseWorkspaceEnv(content: string): Map<string, string> {
  const values = new Map<string, string>();
  const lines = content.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();

    if (trimmed.length === 0 || trimmed.startsWith('#')) {
      continue;
    }

    const separatorIndex = line.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    // Trimmed, as the scripts' loader (scripts/run-with-env.cjs) does. A stray
    // space after a value used to reach the services but not the scripts: an
    // account id with a space on the end is refused by the provider ("invalid
    // username") while `npm run sms status`, reading the same line, said all
    // was well.
    let value = line.slice(separatorIndex + 1).trim();

    if (value.startsWith('-----BEGIN ') && !value.includes('-----END ')) {
      while (index + 1 < lines.length) {
        index += 1;
        value += `\n${lines[index]}`;

        if (lines[index].startsWith('-----END ')) {
          break;
        }
      }
    }

    values.set(key, stripMatchingQuotes(value).replace(/\\n/g, '\n'));
  }

  return values;
}

export function loadWorkspaceEnv(): void {
  if (!existsSync(WORKSPACE_ENV_PATH)) {
    return;
  }

  const content = readFileSync(WORKSPACE_ENV_PATH, 'utf8');
  const values = parseWorkspaceEnv(content);

  for (const [key, value] of values.entries()) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
