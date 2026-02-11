#!/usr/bin/env python3
"""
Integration tests for OpenLLM Python bindings (Rust via PyO3)

Run with: pytest test_secret_stores.py -v
Or simply: python test_secret_stores.py
"""

import os
import sys

# Try to import pytest, fall back to simple runner
try:
    import pytest
    HAS_PYTEST = True
except ImportError:
    HAS_PYTEST = False

from openllm import (
    EnvSecretStore, MemorySecretStore, list_secret_stores,
    # New types
    ChatMessage, MessageRole, Tool, ToolCall, ToolResult,
    ModelConfig, ModelCapabilities, ProviderMetadata,
    list_providers,
)


# =============================================================================
# Registry Tests
# =============================================================================

class TestRegistry:
    """Tests for the secret store registry."""

    def test_list_returns_builtin_stores(self):
        """Registry should include built-in stores."""
        stores = list_secret_stores()
        assert len(stores) >= 2, "Should have at least 2 stores"
        
        names = [s.name for s in stores]
        assert "env" in names, "Should include env store"
        assert "memory" in names, "Should include memory store"

    def test_store_info_shape(self):
        """Store info should have correct attributes."""
        stores = list_secret_stores()
        env_store = next(s for s in stores if s.name == "env")
        
        assert isinstance(env_store.name, str)
        assert isinstance(env_store.description, str)
        assert isinstance(env_store.is_plugin, bool)
        assert env_store.is_plugin is False, "Built-in stores are not plugins"


# =============================================================================
# EnvSecretStore Tests
# =============================================================================

class TestEnvSecretStore:
    """Tests for environment variable secret store."""

    def setup_method(self):
        """Set up test fixtures."""
        self.store = EnvSecretStore()
        # Clean up any test env vars
        for key in list(os.environ.keys()):
            if key.startswith("TEST_OPENLLM_"):
                del os.environ[key]

    def teardown_method(self):
        """Clean up test fixtures."""
        for key in list(os.environ.keys()):
            if key.startswith("TEST_OPENLLM_"):
                del os.environ[key]

    def test_name(self):
        """Store should have correct name."""
        assert self.store.name == "env"

    def test_is_available(self):
        """Store should always be available."""
        assert self.store.is_available() is True

    def test_repr(self):
        """Store should have useful repr."""
        assert "EnvSecretStore" in repr(self.store)
        assert "env" in repr(self.store)

    def test_get_direct_env_var(self):
        """Should read direct environment variable."""
        os.environ["TEST_OPENLLM_SECRET"] = "test-value-123"
        assert self.store.get("TEST_OPENLLM_SECRET") == "test-value-123"

    def test_get_mapped_openai(self):
        """Should map 'openai' to OPENAI_API_KEY."""
        os.environ["OPENAI_API_KEY"] = "sk-test-openai"
        assert self.store.get("openai") == "sk-test-openai"
        del os.environ["OPENAI_API_KEY"]

    def test_get_mapped_anthropic(self):
        """Should map 'anthropic' to ANTHROPIC_API_KEY."""
        os.environ["ANTHROPIC_API_KEY"] = "sk-ant-test"
        assert self.store.get("anthropic") == "sk-ant-test"
        del os.environ["ANTHROPIC_API_KEY"]

    def test_get_missing_returns_none(self):
        """Should return None for missing key."""
        assert self.store.get("NONEXISTENT_KEY_12345") is None

    def test_has_existing_key(self):
        """has() should return True for existing key."""
        os.environ["TEST_OPENLLM_HAS"] = "value"
        assert self.store.has("TEST_OPENLLM_HAS") is True

    def test_has_missing_key(self):
        """has() should return False for missing key."""
        assert self.store.has("NONEXISTENT_KEY_12345") is False

    def test_get_info_existing(self):
        """get_info() should return correct info for existing key."""
        os.environ["TEST_OPENLLM_INFO"] = "value"
        info = self.store.get_info("TEST_OPENLLM_INFO")
        assert info.available is True
        assert info.source == "env"

    def test_get_info_missing(self):
        """get_info() should return not available for missing key."""
        info = self.store.get_info("NONEXISTENT_KEY_12345")
        assert info.available is False

    def test_store_raises_read_only(self):
        """store() should raise RuntimeError (read-only)."""
        with pytest.raises(RuntimeError) if HAS_PYTEST else self._raises(RuntimeError):
            self.store.store("key", "value")

    def test_delete_raises_read_only(self):
        """delete() should raise RuntimeError (read-only)."""
        with pytest.raises(RuntimeError) if HAS_PYTEST else self._raises(RuntimeError):
            self.store.delete("key")

    @staticmethod
    def _raises(exc_type):
        """Simple context manager for exception testing without pytest."""
        class RaisesContext:
            def __enter__(self):
                return self
            def __exit__(self, exc_type_actual, exc_val, exc_tb):
                if exc_type_actual is None:
                    raise AssertionError(f"Expected {exc_type.__name__} to be raised")
                if not issubclass(exc_type_actual, exc_type):
                    raise AssertionError(f"Expected {exc_type.__name__}, got {exc_type_actual.__name__}")
                return True  # Suppress the exception
        return RaisesContext()


# =============================================================================
# MemorySecretStore Tests
# =============================================================================

class TestMemorySecretStore:
    """Tests for in-memory secret store."""

    def setup_method(self):
        """Set up test fixtures."""
        self.store = MemorySecretStore()

    def test_name(self):
        """Store should have correct name."""
        assert self.store.name == "memory"

    def test_is_available(self):
        """Store should always be available."""
        assert self.store.is_available() is True

    def test_repr(self):
        """Store should have useful repr."""
        assert "MemorySecretStore" in repr(self.store)

    def test_starts_empty(self):
        """New store should be empty."""
        assert self.store.is_empty() is True
        assert len(self.store) == 0

    def test_store_and_get(self):
        """Should store and retrieve values."""
        self.store.store("key1", "value1")
        assert self.store.get("key1") == "value1"

    def test_has_after_store(self):
        """has() should return True after store."""
        self.store.store("key2", "value2")
        assert self.store.has("key2") is True

    def test_len_increases(self):
        """len() should increase after store."""
        self.store.store("a", "1")
        self.store.store("b", "2")
        assert len(self.store) == 2

    def test_is_empty_false_after_store(self):
        """is_empty() should return False after store."""
        self.store.store("key", "value")
        assert self.store.is_empty() is False

    def test_get_info_existing(self):
        """get_info() should return correct info."""
        self.store.store("key", "value")
        info = self.store.get_info("key")
        assert info.available is True
        assert info.source == "memory"

    def test_delete_removes_key(self):
        """delete() should remove the key."""
        self.store.store("to_delete", "value")
        assert self.store.has("to_delete") is True
        self.store.delete("to_delete")
        assert self.store.has("to_delete") is False

    def test_clear_removes_all(self):
        """clear() should remove all keys."""
        self.store.store("a", "1")
        self.store.store("b", "2")
        self.store.clear()
        assert self.store.is_empty() is True
        assert len(self.store) == 0

    def test_update_existing_key(self):
        """Storing to existing key should update."""
        self.store.store("key", "original")
        assert self.store.get("key") == "original"
        self.store.store("key", "updated")
        assert self.store.get("key") == "updated"


# =============================================================================
# Multiple Instances Tests
# =============================================================================

class TestMultipleInstances:
    """Tests for multiple store instances."""

    def test_memory_stores_independent(self):
        """Memory stores should be independent."""
        store1 = MemorySecretStore()
        store2 = MemorySecretStore()
        
        store1.store("key", "value1")
        store2.store("key", "value2")
        
        assert store1.get("key") == "value1"
        assert store2.get("key") == "value2"

    def test_env_stores_share_environment(self):
        """Env stores should share the same environment."""
        store1 = EnvSecretStore()
        store2 = EnvSecretStore()
        
        os.environ["TEST_SHARED_KEY"] = "shared_value"
        
        assert store1.get("TEST_SHARED_KEY") == "shared_value"
        assert store2.get("TEST_SHARED_KEY") == "shared_value"
        
        del os.environ["TEST_SHARED_KEY"]


# =============================================================================
# Chat Message Tests
# =============================================================================

class TestChatMessage:
    """Tests for ChatMessage type."""

    def test_system_message(self):
        """Can create system message."""
        msg = ChatMessage.system("You are helpful")
        assert msg.role == MessageRole.System
        assert msg.content == "You are helpful"

    def test_user_message(self):
        """Can create user message."""
        msg = ChatMessage.user("Hello")
        assert msg.role == MessageRole.User
        assert msg.content == "Hello"

    def test_assistant_message(self):
        """Can create assistant message."""
        msg = ChatMessage.assistant("Hi there!")
        assert msg.role == MessageRole.Assistant
        assert msg.content == "Hi there!"


# =============================================================================
# Tool Tests
# =============================================================================

class TestToolTypes:
    """Tests for tool-related types."""

    def test_tool_creation(self):
        """Can create a tool."""
        tool = Tool("get_weather", "Get the weather", None)
        assert tool.name == "get_weather"
        assert tool.description == "Get the weather"

    def test_tool_result_success(self):
        """Can create success result."""
        result = ToolResult.success("call_123", "72°F")
        assert result.call_id == "call_123"
        assert result.content == "72°F"
        assert result.is_error is False

    def test_tool_result_error(self):
        """Can create error result."""
        result = ToolResult.error("call_456", "Not found")
        assert result.call_id == "call_456"
        assert result.is_error is True


# =============================================================================
# Provider Tests
# =============================================================================

class TestProviders:
    """Tests for provider metadata."""

    def test_list_providers(self):
        """list_providers returns all providers."""
        providers = list_providers()
        assert len(providers) >= 7  # OpenAI, Anthropic, Gemini, Ollama, Mistral, Azure, OpenRouter
        
        names = [p.id for p in providers]
        assert "openai" in names
        assert "anthropic" in names
        assert "gemini" in names
        assert "ollama" in names

    def test_provider_metadata(self):
        """Provider metadata has correct structure."""
        providers = list_providers()
        openai = next(p for p in providers if p.id == "openai")
        
        assert openai.display_name == "OpenAI"
        assert "openai.com" in openai.default_api_base
        assert openai.requires_api_key is True

    def test_ollama_no_api_key(self):
        """Ollama doesn't require API key."""
        providers = list_providers()
        ollama = next(p for p in providers if p.id == "ollama")
        
        assert ollama.requires_api_key is False


# =============================================================================
# Model Config Tests
# =============================================================================

class TestModelConfig:
    """Tests for model configuration."""

    def test_model_config_creation(self):
        """Can create model config."""
        config = ModelConfig("gpt4", "openai", "gpt-4")
        assert config.id == "gpt4"
        assert config.provider == "openai"
        assert config.model == "gpt-4"

    def test_model_config_with_options(self):
        """Can create model config with options."""
        config = ModelConfig(
            id="gpt4",
            provider="openai",
            model="gpt-4",
            api_key="sk-test",
            api_base="https://custom.api",
            context_length=8192
        )
        assert config.api_key == "sk-test"
        assert config.api_base == "https://custom.api"
        assert config.context_length == 8192

    def test_model_capabilities(self):
        """Can create model capabilities."""
        caps = ModelCapabilities.full()
        assert caps.image_input is True
        assert caps.tool_calling is True
        assert caps.streaming is True


# =============================================================================
# Simple Test Runner (when pytest not available)
# =============================================================================

def run_simple_tests():
    """Run tests without pytest."""
    passed = 0
    failed = 0
    
    test_classes = [
        TestRegistry,
        TestEnvSecretStore,
        TestMemorySecretStore,
        TestMultipleInstances,
        TestChatMessage,
        TestToolTypes,
        TestProviders,
        TestModelConfig,
    ]
    
    for test_class in test_classes:
        print(f"\n{test_class.__name__}")
        instance = test_class()
        
        # Run setup if exists
        setup = getattr(instance, "setup_method", None)
        teardown = getattr(instance, "teardown_method", None)
        
        for name in dir(instance):
            if name.startswith("test_"):
                if setup:
                    setup()
                try:
                    getattr(instance, name)()
                    print(f"  ✓ {name}")
                    passed += 1
                except Exception as e:
                    print(f"  ✗ {name}")
                    print(f"    Error: {e}")
                    failed += 1
                finally:
                    if teardown:
                        teardown()
    
    print(f"\n{'═' * 60}")
    print(f" Results: {passed} passed, {failed} failed")
    print(f"{'═' * 60}")
    
    return failed == 0


# =============================================================================
# Main
# =============================================================================

if __name__ == "__main__":
    print("═" * 60)
    print(" OpenLLM Python Bindings - Integration Tests")
    print("═" * 60)
    
    if HAS_PYTEST and len(sys.argv) > 1 and sys.argv[1] != "--no-pytest":
        # Run with pytest
        sys.exit(pytest.main([__file__, "-v"] + sys.argv[1:]))
    else:
        # Run simple test runner
        success = run_simple_tests()
        sys.exit(0 if success else 1)
