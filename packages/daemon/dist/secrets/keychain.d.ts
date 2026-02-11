/**
 * Keychain secret store using keytar
 */
import type { SecretStore } from './types.js';
/**
 * Keychain-based secret store using system keyring
 *
 * Uses keytar for cross-platform keychain access:
 * - macOS: Keychain
 * - Linux: libsecret (GNOME Keyring / KDE Wallet)
 * - Windows: Credential Vault
 */
export declare class KeychainSecretStore implements SecretStore {
    private keytar;
    private loadError;
    constructor();
    private loadKeytar;
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    delete(key: string): Promise<boolean>;
    has(key: string): Promise<boolean>;
}
//# sourceMappingURL=keychain.d.ts.map