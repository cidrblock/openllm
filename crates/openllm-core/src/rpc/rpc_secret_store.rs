//! RPC-backed secret store
//!
//! Implements the SecretStore trait by making JSON-RPC calls to an external
//! provider (like VS Code).

use crate::secrets::{SecretStore, SecretStoreError, SecretStoreResult, SecretInfo};
use super::client::RpcClient;
use super::endpoint::RpcEndpoint;
use serde::{Deserialize, Serialize};

/// A secret store that uses JSON-RPC to communicate with an external provider
pub struct RpcSecretStore {
    name: String,
    client: RpcClient,
}

#[derive(Serialize)]
struct GetParams {
    key: String,
}

#[derive(Deserialize)]
struct GetResult {
    value: Option<String>,
}

#[derive(Serialize)]
struct StoreParams {
    key: String,
    value: String,
}

#[derive(Deserialize)]
struct StoreResult {
    success: bool,
}

#[derive(Serialize)]
struct DeleteParams {
    key: String,
}

#[derive(Deserialize)]
struct DeleteResult {
    success: bool,
}

#[derive(Serialize)]
struct ListParams {}

#[derive(Deserialize)]
struct ListResult {
    keys: Vec<String>,
}

impl RpcSecretStore {
    /// Create a new RPC secret store from an endpoint
    pub fn new(endpoint: &RpcEndpoint) -> Self {
        Self {
            name: format!("rpc:{}", endpoint.name),
            client: RpcClient::new(
                endpoint.socket_path.to_string_lossy().to_string(),
                endpoint.auth_token.clone(),
            ),
        }
    }

    /// Create from socket path and auth token directly
    pub fn from_parts(name: impl Into<String>, socket_path: impl Into<String>, auth_token: impl Into<String>) -> Self {
        let name_str = name.into();
        Self {
            name: format!("rpc:{}", name_str),
            client: RpcClient::new(socket_path, auth_token),
        }
    }

    /// List all available secret keys
    pub fn list_keys(&self) -> Result<Vec<String>, SecretStoreError> {
        let result: ListResult = self
            .client
            .call("secrets/list", ListParams {})
            .map_err(|e| SecretStoreError::Other(e.to_string()))?;
        Ok(result.keys)
    }

    /// Check if the RPC endpoint is reachable
    pub fn is_reachable(&self) -> bool {
        self.client.ping().unwrap_or(false)
    }
    
    // ==================== ASYNC API ====================
    
    /// Async check if reachable
    pub async fn is_reachable_async(&self) -> bool {
        self.client.ping_async().await.unwrap_or(false)
    }
    
    /// Async get secret
    pub async fn get_async(&self, key: &str) -> Option<String> {
        let result: GetResult = self
            .client
            .call_async("secrets/get", GetParams { key: key.to_string() })
            .await
            .ok()?;
        result.value
    }
    
    /// Async store secret
    pub async fn store_async(&self, key: &str, value: &str) -> SecretStoreResult<()> {
        let result: StoreResult = self
            .client
            .call_async(
                "secrets/store",
                StoreParams {
                    key: key.to_string(),
                    value: value.to_string(),
                },
            )
            .await
            .map_err(|e| SecretStoreError::Other(e.to_string()))?;

        if result.success {
            Ok(())
        } else {
            Err(SecretStoreError::Other("Store operation failed".to_string()))
        }
    }
    
    /// Async delete secret
    pub async fn delete_async(&self, key: &str) -> SecretStoreResult<()> {
        let result: DeleteResult = self
            .client
            .call_async("secrets/delete", DeleteParams { key: key.to_string() })
            .await
            .map_err(|e| SecretStoreError::Other(e.to_string()))?;

        if result.success {
            Ok(())
        } else {
            Err(SecretStoreError::Other("Delete operation failed".to_string()))
        }
    }
}

impl SecretStore for RpcSecretStore {
    fn name(&self) -> &str {
        &self.name
    }

    fn is_available(&self) -> bool {
        // Check if we can reach the endpoint
        self.is_reachable()
    }

    fn get(&self, key: &str) -> Option<String> {
        let result: GetResult = self
            .client
            .call("secrets/get", GetParams { key: key.to_string() })
            .ok()?;
        result.value
    }

    fn store(&self, key: &str, value: &str) -> SecretStoreResult<()> {
        let result: StoreResult = self
            .client
            .call(
                "secrets/store",
                StoreParams {
                    key: key.to_string(),
                    value: value.to_string(),
                },
            )
            .map_err(|e| SecretStoreError::Other(e.to_string()))?;

        if result.success {
            Ok(())
        } else {
            Err(SecretStoreError::Other("Store operation failed".to_string()))
        }
    }

    fn delete(&self, key: &str) -> SecretStoreResult<()> {
        let result: DeleteResult = self
            .client
            .call("secrets/delete", DeleteParams { key: key.to_string() })
            .map_err(|e| SecretStoreError::Other(e.to_string()))?;

        if result.success {
            Ok(())
        } else {
            Err(SecretStoreError::Other("Delete operation failed".to_string()))
        }
    }

    fn get_info(&self, key: &str) -> SecretInfo {
        match self.get(key) {
            Some(_) => SecretInfo::new(true, self.name()),
            None => SecretInfo::new(false, self.name()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_rpc_secret_store_name() {
        let endpoint = RpcEndpoint::new(
            "vscode",
            "/tmp/test.sock",
            "token",
            vec!["secrets".to_string()],
        );
        let store = RpcSecretStore::new(&endpoint);
        assert_eq!(store.name(), "rpc:vscode");
    }
}
