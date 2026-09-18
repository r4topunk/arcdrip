// Signers from Foundry encrypted keystores (~/.foundry/keystores). `cast wallet private-key` decrypts the keystore
// in a child process and hands the key to this process over a pipe: it never appears on a command line, in the
// environment, on disk or in any output. The password comes from a password file, or cast prompts for it on the
// terminal. Raw keys are never accepted as arguments, and only keystore NAMES come from env.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { Hex, PrivateKeyAccount } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export interface KeystoreOptions {
  /** Password file for this keystore. Without one, cast prompts on the terminal (needs a TTY). */
  passwordFile?: string | undefined;
  /** Directory holding the keystore file. Default: Foundry's ~/.foundry/keystores (cast --account). */
  keystoreDir?: string | undefined;
}

/** Decrypts keystore `name` with cast and returns a viem local account. Errors never contain key material. */
export async function keystoreAccount(
  name: string,
  options: KeystoreOptions = {},
): Promise<PrivateKeyAccount> {
  if (!/^[\w.-]+$/.test(name)) throw new Error(`invalid keystore name ${JSON.stringify(name)}`);
  const args = ['wallet', 'private-key'];
  if (options.keystoreDir) args.push('--keystore', join(options.keystoreDir, name));
  else args.push('--account', name);
  if (options.passwordFile) args.push('--password-file', options.passwordFile);

  // stdin and stderr stay on the terminal so cast's password prompt and its errors reach the operator.
  const child = spawn('cast', args, { stdio: ['inherit', 'pipe', 'inherit'] });
  const chunks: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  const key = Buffer.concat(chunks).toString('utf8').trim();
  chunks.length = 0;
  if (code !== 0 || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error(
      `could not decrypt keystore "${name}" with cast (exit ${code}); check the name (cast wallet list) and the password`,
    );
  }
  return privateKeyToAccount(key as Hex);
}

/** Memoizes a loader per key, so each keystore is decrypted (and its password asked) at most once per run. */
export function lazy<K, V>(load: (key: K) => Promise<V>): (key: K) => Promise<V> {
  const cache = new Map<K, Promise<V>>();
  return (key) => {
    let value = cache.get(key);
    if (!value) {
      value = load(key);
      cache.set(key, value);
      value.catch(() => cache.delete(key));
    }
    return value;
  };
}
