/**
 * Secret store interface
 */

export interface SecretStore {
  /** Get a secret value */
  get(key: string): Promise<string | null>;
  
  /** Store a secret */
  set(key: string, value: string): Promise<void>;
  
  /** Delete a secret */
  delete(key: string): Promise<boolean>;
  
  /** Check if a secret exists */
  has(key: string): Promise<boolean>;
}
