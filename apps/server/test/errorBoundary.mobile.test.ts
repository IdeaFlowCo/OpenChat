import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  logError: vi.fn(),
}));

// Same inert-primitive boundary the other mobile render tests use: we are
// checking React's error semantics, not iOS drawing.
vi.mock('react-native', () => ({
  Appearance: { getColorScheme: () => 'light' },
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  TouchableOpacity: 'TouchableOpacity',
  View: 'View',
}));
vi.mock('../../mobile/src/services/clientLogger', () => ({ logError: mocks.logError }));

import { ErrorBoundary } from '../../mobile/src/components/ErrorBoundary.js';

function Boom({ message = 'kaboom' }: { message?: string }): React.ReactElement {
  throw new Error(message);
}
function Fine() {
  return React.createElement('Text', null, 'all good');
}

let screen: ReturnType<typeof create> | undefined;
let consoleError: ReturnType<typeof vi.spyOn>;

async function render(element: React.ReactElement) {
  await act(async () => {
    if (screen) screen.update(element);
    else screen = create(element);
  });
}
function text() { return JSON.stringify(screen!.toJSON()); }

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  // React always re-logs a caught render error; keep the suite output readable.
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  await act(async () => { screen?.unmount(); });
  screen = undefined;
  consoleError.mockRestore();
  delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
});

describe('ErrorBoundary', () => {
  it('renders children untouched when nothing throws', async () => {
    await render(
      React.createElement(ErrorBoundary, { scope: 'app-root' }, React.createElement(Fine)),
    );

    expect(text()).toContain('all good');
    expect(mocks.logError).not.toHaveBeenCalled();
  });

  it('shows a recoverable fallback instead of letting a render throw escape', async () => {
    await render(
      React.createElement(ErrorBoundary, { scope: 'app-root' }, React.createElement(Boom)),
    );

    // The tree survived: we have output, not a propagated exception.
    expect(screen!.toJSON()).not.toBeNull();
    expect(text()).toContain('Something went wrong');
    expect(text()).toContain('Try again');
  });

  it('reports the throw through clientLogger with scope and component stack', async () => {
    await render(
      React.createElement(
        ErrorBoundary,
        { scope: 'chat-message' },
        React.createElement(Boom, { message: "Cannot read properties of undefined (reading 'split')" }),
      ),
    );

    expect(mocks.logError).toHaveBeenCalledTimes(1);
    const [message, error, context] = mocks.logError.mock.calls[0];
    expect(message).toBe('Render error in chat-message');
    expect((error as Error).message).toContain("reading 'split'");
    expect(context).toMatchObject({ scope: 'chat-message' });
    expect(typeof (context as Record<string, unknown>).componentStack).toBe('string');
  });

  it('catches a throw from the render slot, which an inline child call would not', async () => {
    // Regression guard: `{buildRow(item)}` runs during the PARENT's render, so
    // the boundary never sees it. The `render` prop must defer the call into a
    // child component.
    await render(
      React.createElement(ErrorBoundary, {
        scope: 'chat-message',
        render: () => { throw new Error('bad row'); },
        fallback: () => React.createElement('Text', null, 'Message unavailable'),
      }),
    );

    expect(text()).toContain('Message unavailable');
    expect(mocks.logError).toHaveBeenCalledTimes(1);
  });

  it('renders a custom compact fallback when one is supplied', async () => {
    await render(
      React.createElement(
        ErrorBoundary,
        { scope: 'chat-message', fallback: () => React.createElement('Text', null, 'Message unavailable') },
        React.createElement(Boom),
      ),
    );

    expect(text()).toContain('Message unavailable');
    expect(text()).not.toContain('Something went wrong');
  });

  it('recovers when resetKey changes, so re-keyed content is retried', async () => {
    await render(
      React.createElement(
        ErrorBoundary,
        { scope: 'chat-message', resetKey: 'msg-1' },
        React.createElement(Boom),
      ),
    );
    expect(text()).toContain('Something went wrong');

    await render(
      React.createElement(
        ErrorBoundary,
        { scope: 'chat-message', resetKey: 'msg-2' },
        React.createElement(Fine),
      ),
    );
    expect(text()).toContain('all good');
  });

  it('recovers when the fallback retry callback fires', async () => {
    let retry: (() => void) | undefined;
    const fallback = (_error: Error, onRetry: () => void) => {
      retry = onRetry;
      return React.createElement('Text', null, 'Message unavailable');
    };

    await render(
      React.createElement(
        ErrorBoundary,
        { scope: 'chat-message', fallback },
        React.createElement(Boom),
      ),
    );
    expect(text()).toContain('Message unavailable');

    // Swap in healthy children, then retry — mirrors "pull to refresh".
    await act(async () => {
      screen!.update(
        React.createElement(
          ErrorBoundary,
          { scope: 'chat-message', fallback },
          React.createElement(Fine),
        ),
      );
      retry!();
    });

    expect(text()).toContain('all good');
  });

  it('normalizes non-Error throws so the fallback still has a message', async () => {
    function ThrowString(): React.ReactElement {
      throw 'just a string';
    }

    await render(
      React.createElement(ErrorBoundary, { scope: 'app-root' }, React.createElement(ThrowString)),
    );

    expect(text()).toContain('just a string');
  });
});
