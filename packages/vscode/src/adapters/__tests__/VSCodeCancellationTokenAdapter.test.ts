import * as assert from 'assert';
import { VSCodeCancellationTokenAdapter } from '../VSCodeCancellationTokenAdapter';

// Mock VS Code CancellationToken
class MockVSCodeCancellationToken {
  private _isCancellationRequested = false;
  private listeners: Array<() => void> = [];

  get isCancellationRequested(): boolean {
    return this._isCancellationRequested;
  }

  cancel(): void {
    this._isCancellationRequested = true;
    this.listeners.forEach(listener => listener());
  }

  onCancellationRequested(listener: () => void): { dispose: () => void } {
    this.listeners.push(listener);
    return {
      dispose: () => {
        const index = this.listeners.indexOf(listener);
        if (index >= 0) {
          this.listeners.splice(index, 1);
        }
      }
    };
  }
}

describe('VSCodeCancellationTokenAdapter', () => {
  it('should reflect cancellation status', () => {
    const mockToken = new MockVSCodeCancellationToken();
    const adapter = new VSCodeCancellationTokenAdapter(mockToken as any);

    assert.strictEqual(adapter.isCancellationRequested, false);

    mockToken.cancel();

    assert.strictEqual(adapter.isCancellationRequested, true);
  });

  it('should call listener when token is cancelled', (done) => {
    const mockToken = new MockVSCodeCancellationToken();
    const adapter = new VSCodeCancellationTokenAdapter(mockToken as any);

    let listenerCalled = false;
    adapter.onCancellationRequested(() => {
      listenerCalled = true;
      assert.strictEqual(adapter.isCancellationRequested, true);
      done();
    });

    assert.strictEqual(listenerCalled, false);
    mockToken.cancel();
  });

  it('should call listener immediately if already cancelled', () => {
    const mockToken = new MockVSCodeCancellationToken();
    mockToken.cancel(); // Cancel before creating adapter

    const adapter = new VSCodeCancellationTokenAdapter(mockToken as any);

    let listenerCalled = false;
    adapter.onCancellationRequested(() => {
      listenerCalled = true;
    });

    assert.strictEqual(listenerCalled, true);
  });

  it('should support multiple listeners', () => {
    const mockToken = new MockVSCodeCancellationToken();
    const adapter = new VSCodeCancellationTokenAdapter(mockToken as any);

    let listener1Called = false;
    let listener2Called = false;

    adapter.onCancellationRequested(() => {
      listener1Called = true;
    });

    adapter.onCancellationRequested(() => {
      listener2Called = true;
    });

    assert.strictEqual(listener1Called, false);
    assert.strictEqual(listener2Called, false);

    mockToken.cancel();

    assert.strictEqual(listener1Called, true);
    assert.strictEqual(listener2Called, true);
  });

  it('should maintain state after cancellation', () => {
    const mockToken = new MockVSCodeCancellationToken();
    const adapter = new VSCodeCancellationTokenAdapter(mockToken as any);

    mockToken.cancel();

    assert.strictEqual(adapter.isCancellationRequested, true);
    
    // Check multiple times
    assert.strictEqual(adapter.isCancellationRequested, true);
    assert.strictEqual(adapter.isCancellationRequested, true);
  });
});
