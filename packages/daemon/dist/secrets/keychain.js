/**
 * Keychain secret store using keytar
 */
const SERVICE_NAME = 'openllm';
/**
 * Keychain-based secret store using system keyring
 *
 * Uses keytar for cross-platform keychain access:
 * - macOS: Keychain
 * - Linux: libsecret (GNOME Keyring / KDE Wallet)
 * - Windows: Credential Vault
 */
export class KeychainSecretStore {
    keytar = null;
    loadError = null;
    constructor() {
        // Load keytar lazily since it's a native module
        this.loadKeytar();
    }
    async loadKeytar() {
        if (this.keytar)
            return this.keytar;
        if (this.loadError)
            return null;
        try {
            this.keytar = await import('keytar');
            return this.keytar;
        }
        catch (error) {
            this.loadError = error.message;
            console.warn(`[Secrets] keytar not available: ${error.message}. Keychain storage disabled.`);
            return null;
        }
    }
    async get(key) {
        const kt = await this.loadKeytar();
        if (!kt)
            return null;
        try {
            return await kt.getPassword(SERVICE_NAME, key);
        }
        catch (error) {
            console.error(`[Secrets] Failed to get key '${key}':`, error.message);
            return null;
        }
    }
    async set(key, value) {
        const kt = await this.loadKeytar();
        if (!kt) {
            throw new Error('Keychain storage not available');
        }
        try {
            await kt.setPassword(SERVICE_NAME, key, value);
        }
        catch (error) {
            throw new Error(`Failed to store key '${key}': ${error.message}`);
        }
    }
    async delete(key) {
        const kt = await this.loadKeytar();
        if (!kt)
            return false;
        try {
            return await kt.deletePassword(SERVICE_NAME, key);
        }
        catch (error) {
            console.error(`[Secrets] Failed to delete key '${key}':`, error.message);
            return false;
        }
    }
    async has(key) {
        const value = await this.get(key);
        return value !== null && value.length > 0;
    }
}
//# sourceMappingURL=keychain.js.map