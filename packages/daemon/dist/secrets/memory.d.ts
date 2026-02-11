/**
 * In-memory secret store (for testing)
 */
import type { SecretStore } from './types.js';
export declare class MemorySecretStore implements SecretStore {
    private store;
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    delete(key: string): Promise<boolean>;
    has(key: string): Promise<boolean>;
}
//# sourceMappingURL=memory.d.ts.map