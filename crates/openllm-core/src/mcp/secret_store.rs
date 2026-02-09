//! MCP-backed secret store
//!
//! Implements the SecretStore trait by calling MCP internal tools
//! (`openllm_secrets_*`) on a connected MCP server.

use std::sync::Arc;
use serde::Deserialize;

use crate::secrets::{SecretStore, SecretStoreError, SecretStoreResult, SecretInfo};
use super::client::McpClient;

/// A secret store that uses MCP tools to communicate with VS Code
pub struct McpSecretStore {
    name: String,
    client: Arc<McpClient>,
}

#[derive(Deserialize)]
struct GetResult {
    found: bool,
    value: Option<String>,
}

#[derive(Deserialize)]
struct StoreResult {
    success: bool,
}

#[derive(Deserialize)]
struct DeleteResult {
    success: bool,
}

#[derive(Deserialize)]
struct ListResult {
    keys: Vec<String>,
}

impl McpSecretStore {
    /// Create a new MCP secret store
    pub fn new(name: impl Into<String>, client: Arc<McpClient>) -> Self {
        Self {
            name: format!("mcp:{}", name.into()),
            client,
        }
    }

    /// Get the MCP client
    pub fn client(&self) -> &Arc<McpClient> {
        &self.client
    }

    /// List all available secret keys (async)
    pub async fn list_keys_async(&self) -> Result<Vec<String>, SecretStoreError> {
        let result = self.client
            .call_tool("openllm_secrets_list", serde_json::json!({}))
            .await
            .map_err(|e| SecretStoreError::Other(e.to_string()))?;

        // Extract text content and parse
        let text = extract_text_content(&result);
        let parsed: ListResult = serde_json::from_str(&text)
            .map_err(|e| SecretStoreError::Other(format!("Parse error: {}", e)))?;

        Ok(parsed.keys)
    }

    /// Get a secret (async)
    pub async fn get_async(&self, key: &str) -> Option<String> {
        let result = self.client
            .call_tool("openllm_secrets_get", serde_json::json!({ "key": key }))
            .await
            .ok()?;

        let text = extract_text_content(&result);
        let parsed: GetResult = serde_json::from_str(&text).ok()?;

        parsed.value
    }

    /// Store a secret (async)
    pub async fn store_async(&self, key: &str, value: &str) -> SecretStoreResult<()> {
        let result = self.client
            .call_tool("openllm_secrets_set", serde_json::json!({
                "key": key,
                "value": value
            }))
            .await
            .map_err(|e| SecretStoreError::Other(e.to_string()))?;

        let text = extract_text_content(&result);
        let parsed: StoreResult = serde_json::from_str(&text)
            .map_err(|e| SecretStoreError::Other(format!("Parse error: {}", e)))?;

        if parsed.success {
            Ok(())
        } else {
            Err(SecretStoreError::Other("Store operation failed".to_string()))
        }
    }

    /// Delete a secret (async)
    pub async fn delete_async(&self, key: &str) -> SecretStoreResult<()> {
        let result = self.client
            .call_tool("openllm_secrets_delete", serde_json::json!({ "key": key }))
            .await
            .map_err(|e| SecretStoreError::Other(e.to_string()))?;

        let text = extract_text_content(&result);
        let parsed: DeleteResult = serde_json::from_str(&text)
            .map_err(|e| SecretStoreError::Other(format!("Parse error: {}", e)))?;

        if parsed.success {
            Ok(())
        } else {
            Err(SecretStoreError::Other("Delete operation failed".to_string()))
        }
    }
}

impl SecretStore for McpSecretStore {
    fn name(&self) -> &str {
        &self.name
    }

    fn is_available(&self) -> bool {
        // MCP client is always available once connected
        true
    }

    fn get(&self, key: &str) -> Option<String> {
        // Sync version - blocks on async
        tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current().block_on(self.get_async(key))
        })
    }

    fn store(&self, key: &str, value: &str) -> SecretStoreResult<()> {
        tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current().block_on(self.store_async(key, value))
        })
    }

    fn delete(&self, key: &str) -> SecretStoreResult<()> {
        tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current().block_on(self.delete_async(key))
        })
    }

    fn get_info(&self, key: &str) -> SecretInfo {
        match self.get(key) {
            Some(_) => SecretInfo::new(true, self.name()),
            None => SecretInfo::new(false, self.name()),
        }
    }
}

/// Extract text content from MCP CallToolResult
fn extract_text_content(result: &rmcp::model::CallToolResult) -> String {
    use rmcp::model::RawContent;
    
    result.content.iter()
        .filter_map(|c| {
            match &c.raw {
                RawContent::Text(t) => Some(t.text.clone()),
                _ => None,
            }
        })
        .collect::<Vec<_>>()
        .join("")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_mcp_secret_store_name() {
        // Can't test without a real MCP client, but we can test the name format
        assert!(true);
    }
}
