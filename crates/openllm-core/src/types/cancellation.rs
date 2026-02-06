//! Cancellation token for request cancellation

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::Notify;

/// Token for cancelling async operations
///
/// This is a platform-agnostic cancellation mechanism that can be
/// adapted to VS Code's CancellationToken, tokio's CancellationToken, etc.
#[derive(Clone)]
pub struct CancellationToken {
    inner: Arc<CancellationTokenInner>,
}

struct CancellationTokenInner {
    cancelled: AtomicBool,
    notify: Notify,
}

impl Default for CancellationToken {
    fn default() -> Self {
        Self::new()
    }
}

impl CancellationToken {
    /// Create a new cancellation token
    pub fn new() -> Self {
        Self {
            inner: Arc::new(CancellationTokenInner {
                cancelled: AtomicBool::new(false),
                notify: Notify::new(),
            }),
        }
    }

    /// Check if cancellation has been requested
    pub fn is_cancelled(&self) -> bool {
        self.inner.cancelled.load(Ordering::SeqCst)
    }

    /// Request cancellation
    pub fn cancel(&self) {
        if !self.inner.cancelled.swap(true, Ordering::SeqCst) {
            self.inner.notify.notify_waiters();
        }
    }

    /// Wait until cancellation is requested
    pub async fn cancelled(&self) {
        // If already cancelled, return immediately
        if self.is_cancelled() {
            return;
        }
        
        // Wait for notification
        self.inner.notify.notified().await;
    }

    /// Create a child token that is cancelled when this token is cancelled
    pub fn child_token(&self) -> CancellationToken {
        // For simplicity, just clone (shares same inner state)
        // A more sophisticated implementation would track parent-child relationships
        self.clone()
    }
}

impl std::fmt::Debug for CancellationToken {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CancellationToken")
            .field("is_cancelled", &self.is_cancelled())
            .finish()
    }
}

/// A cancellation token that is never cancelled
/// Useful for operations that should run to completion
pub struct NeverCancelledToken;

impl NeverCancelledToken {
    /// Check if cancellation has been requested (always false)
    pub fn is_cancelled(&self) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cancellation_token() {
        let token = CancellationToken::new();
        assert!(!token.is_cancelled());

        token.cancel();
        assert!(token.is_cancelled());

        // Multiple cancels are idempotent
        token.cancel();
        assert!(token.is_cancelled());
    }

    #[test]
    fn test_cloned_token_shares_state() {
        let token1 = CancellationToken::new();
        let token2 = token1.clone();

        assert!(!token1.is_cancelled());
        assert!(!token2.is_cancelled());

        token1.cancel();

        assert!(token1.is_cancelled());
        assert!(token2.is_cancelled());
    }

    #[tokio::test]
    async fn test_cancelled_future() {
        let token = CancellationToken::new();
        let token_clone = token.clone();

        // Spawn a task that waits for cancellation
        let handle = tokio::spawn(async move {
            token_clone.cancelled().await;
            "cancelled"
        });

        // Cancel the token
        token.cancel();

        // The task should complete
        let result = handle.await.unwrap();
        assert_eq!(result, "cancelled");
    }

    #[test]
    fn test_never_cancelled() {
        let token = NeverCancelledToken;
        assert!(!token.is_cancelled());
    }
}
