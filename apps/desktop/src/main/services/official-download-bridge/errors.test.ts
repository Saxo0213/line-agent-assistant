import { describe, expect, it } from 'vitest';
import { BridgeError, bridgeFailureDetail, safeReasonText } from './errors.js';

describe('bridge failure safe reason', () => {
  it('removes file system paths and unsafe characters', () => {
    const ext = 'C:\\Users\\Some Name\\AppData\\Roaming\\app\\extension';
    const text = safeReasonText(`CDP_ERROR: Extensions.loadUnpacked: Failed to load "${ext}" from D:\\x\\y <b>\n  now (-32000)`, [ext]);
    expect(text).toBe('Extensions.loadUnpacked: Failed to load <path> from <path> b now (-32000)');
    expect(text).not.toMatch(/Users|Some Name|[\\/"<>]{2}/);
    expect(safeReasonText('a'.repeat(300)).length).toBe(160);
  });

  it('builds an audit detail that matches the audit pattern', () => {
    const error = new BridgeError('EXTENSION_LOAD_FAILED', 'Extensions.loadUnpacked: Failed (x) at C:\\Users\\n\\e');
    const detail = bridgeFailureDetail(error);
    expect(detail).toBe('code:EXTENSION_LOAD_FAILED:reason:Extensions.loadUnpacked:_Failed_x_at_path');
    expect(detail).toMatch(/^[A-Za-z0-9_.:-]{1,160}$/);
    expect(bridgeFailureDetail(new BridgeError('CDP_CLOSED', 'x'))).toBeUndefined();
  });
});
