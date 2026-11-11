import { safeStorage } from 'electron';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SECRET_NAMES, secretNameSchema, type SecretName } from '@rec-it/ipc-contract';

interface SecretsFile {
  version: 1;
  entries: Partial<Record<SecretName, string>>;
}

/**
 * Secrets are encrypted with Electron safeStorage (Windows DPAPI, macOS Keychain, libsecret)
 * and kept in a small file in the user-data folder. Values are only ever decrypted in main
 * and handed to the backend in memory; the renderer can only ask whether one is set.
 */
export class SecretStore {
  private readonly file: string;

  constructor(userDataDir: string) {
    this.file = join(userDataDir, 'secrets.json');
  }

  encryptionAvailable(): Promise<boolean> {
    return safeStorage.isAsyncEncryptionAvailable();
  }

  async set(name: SecretName, value: string): Promise<void> {
    secretNameSchema.parse(name);
    if (!(await this.encryptionAvailable())) {
      throw new Error(
        'Secure storage is not available on this system, so the secret was not saved.',
      );
    }
    const encrypted = await safeStorage.encryptStringAsync(value);
    const data = this.read();
    data.entries[name] = encrypted.toString('base64');
    this.write(data);
  }

  clear(name: SecretName): void {
    const data = this.read();
    delete data.entries[name];
    this.write(data);
  }

  status(): Record<SecretName, { set: boolean }> {
    const data = this.read();
    return Object.fromEntries(
      SECRET_NAMES.map((n) => [n, { set: Boolean(data.entries[n]) }]),
    ) as Record<SecretName, { set: boolean }>;
  }

  /** Decrypts every stored secret. Entries that fail to decrypt (e.g. copied from another PC) are skipped. */
  async readAll(): Promise<Partial<Record<SecretName, string>>> {
    if (!(await this.encryptionAvailable())) return {};
    const out: Partial<Record<SecretName, string>> = {};
    for (const [name, blob] of Object.entries(this.read().entries)) {
      if (!blob || !secretNameSchema.safeParse(name).success) continue;
      try {
        const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(
          Buffer.from(blob, 'base64'),
        );
        out[name as SecretName] = result;
        // The OS rotated its key: store the value again under the new key.
        if (shouldReEncrypt) await this.set(name as SecretName, result);
      } catch {
        console.warn(`[main] could not decrypt secret "${name}"; it will need to be entered again`);
      }
    }
    return out;
  }

  private read(): SecretsFile {
    if (!existsSync(this.file)) return { version: 1, entries: {} };
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as SecretsFile;
      return parsed.version === 1 && parsed.entries ? parsed : { version: 1, entries: {} };
    } catch {
      return { version: 1, entries: {} };
    }
  }

  private write(data: SecretsFile): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
