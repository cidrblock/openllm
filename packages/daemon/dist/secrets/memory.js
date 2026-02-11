/**
 * In-memory secret store (for testing)
 */
export class MemorySecretStore {
    store = new Map();
    async get(key) {
        return this.store.get(key) ?? null;
    }
    async set(key, value) {
        this.store.set(key, value);
    }
    async delete(key) {
        return this.store.delete(key);
    }
    async has(key) {
        return this.store.has(key);
    }
}
//# sourceMappingURL=memory.js.map