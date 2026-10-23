// @vitest-environment jsdom
// Existing workflow assertions explicitly exercise the retained Traditional Chinese catalog.
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useComposerStatus } from './ComposerStatus.js';

afterEach(cleanup);

describe('useComposerStatus clearKey', () => {
  it('clears a keyed warning but never an unrelated error', () => {
    const { result } = renderHook(() => useComposerStatus());
    act(() => result.current.setWarning('附件狀態暫時無法更新。', undefined, 'attachment-refresh'));
    act(() => result.current.clearKey('attachment-refresh'));
    expect(result.current.message).toBeNull();

    act(() => result.current.setWarning('附件狀態暫時無法更新。', undefined, 'attachment-refresh'));
    act(() => result.current.setError('傳送失敗'));
    act(() => result.current.clearKey('attachment-refresh'));
    expect(result.current.message).toMatchObject({ severity: 'error', text: '傳送失敗' });
  });
});
