import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getLogger } from '../utils/logger';

/**
 * Resolves template variables and secrets from various sources
 */
export class SecretResolver {
  private envVars: Map<string, string> = new Map();
  private logger = getLogger();

  constructor() {
    this.loadEnvironmentVariables();
  }

  /**
   * Load environment variables from process.env
   */
  private loadEnvironmentVariables(): void {
    for (const [key, value] of Object.entries(process.env)) {
      if (value) {
        this.envVars.set(key, value);
      }
    }
  }

  /**
   * Load variables from a .env file
   */
  loadEnvFile(filePath: string): void {
    if (!fs.existsSync(filePath)) {
      this.logger.debug(`Env file not found: ${filePath}`);
      return;
    }

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      this.parseEnvContent(content);
      this.logger.info(`Loaded env file: ${filePath}`);
    } catch (error) {
      this.logger.error(`Failed to load env file: ${filePath}`, error);
    }
  }

  /**
   * Parse .env file content
   */
  private parseEnvContent(content: string): void {
    const lines = content.split('\n');
    
    for (const line of lines) {
      // Skip comments and empty lines
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }

      // Parse KEY=VALUE format
      const match = trimmed.match(/^([^=]+)=(.*)$/);
      if (match) {
        const key = match[1].trim();
        let value = match[2].trim();
        
        // Remove surrounding quotes if present
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        
        this.envVars.set(key, value);
      }
    }
  }

  /**
   * Load env files from standard locations
   */
  loadStandardEnvFiles(workspacePath?: string): void {
    const locations = [
      // Global Continue location
      path.join(os.homedir(), '.continue', '.env'),
      // Global Open LLM location
      path.join(os.homedir(), '.openllm', '.env'),
    ];

    // Workspace-specific locations
    if (workspacePath) {
      locations.push(
        path.join(workspacePath, '.continue', '.env'),
        path.join(workspacePath, '.openllm', '.env'),
        path.join(workspacePath, '.env')
      );
    }

    for (const location of locations) {
      this.loadEnvFile(location);
    }
  }

  /**
   * Resolve a template variable or return the value as-is
   * 
   * Supports formats:
   * - ${{ secrets.NAME }}
   * - ${{ inputs.NAME }}
   * - ${NAME}
   * - $NAME
   */
  resolve(template: string | undefined): string | undefined {
    if (!template) {
      return undefined;
    }

    // Check for ${{ secrets.NAME }} or ${{ inputs.NAME }} format
    const secretMatch = template.match(/\$\{\{\s*(?:secrets|inputs)\.(\w+)\s*\}\}/);
    if (secretMatch) {
      const secretName = secretMatch[1];
      const value = this.envVars.get(secretName);
      if (value) {
        this.logger.debug(`Resolved secret: ${secretName}`);
        return value;
      }
      this.logger.warn(`Secret not found: ${secretName}`);
      return undefined;
    }

    // Check for ${NAME} format
    const bracketMatch = template.match(/^\$\{(\w+)\}$/);
    if (bracketMatch) {
      const varName = bracketMatch[1];
      return this.envVars.get(varName);
    }

    // Check for $NAME format (only if starts with $)
    if (template.startsWith('$') && !template.includes(' ')) {
      const varName = template.substring(1);
      const value = this.envVars.get(varName);
      if (value) {
        return value;
      }
    }

    // Not a template, return as-is
    return template;
  }

  /**
   * Check if a value looks like an unresolved template
   */
  isUnresolvedTemplate(value: string | undefined): boolean {
    if (!value) {
      return false;
    }
    return /\$\{\{.*\}\}/.test(value) || /^\$\{?\w+\}?$/.test(value);
  }

  /**
   * Get a secret by name directly
   */
  get(name: string): string | undefined {
    return this.envVars.get(name);
  }

  /**
   * Set a secret value
   */
  set(name: string, value: string): void {
    this.envVars.set(name, value);
  }

  /**
   * Clear all loaded secrets
   */
  clear(): void {
    this.envVars.clear();
    this.loadEnvironmentVariables();
  }
}
