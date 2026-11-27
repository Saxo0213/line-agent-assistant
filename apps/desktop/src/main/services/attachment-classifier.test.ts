import { describe, expect, it, vi } from 'vitest';
import { AttachmentClassifier, buildClassifierPrompt, parseClassifierAnswer, type ClassifierInput } from './attachment-classifier.js';

const key = { accountId: 'account', chatType: 'group' as const, chatId: 'chat' };
const folder = (folderId: string, kind: 'classified' | 'default', root = `D:/${folderId}`) => ({ ...key, folderId, kind, root, description: `about ${folderId}` });
const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const D = 'dddddddd-0000-4000-8000-000000000003';

function setup(options: { folders: ReturnType<typeof folder>[]; run: () => Promise<string>; attempts?: number }) {
  const claim = { ...key, classificationId: 1, attachmentId: 'att-1', attempts: options.attempts ?? 1 };
  const repository = {
    listFolders: vi.fn().mockResolvedValue(options.folders),
    claimClassification: vi.fn().mockResolvedValueOnce(claim).mockResolvedValue(null),
    getClassificationContext: vi.fn().mockResolvedValue({ name: 'a.png', kind: 'image', mimeType: 'image/png', sizeBytes: 5, relativePath: 'x/a.png',
      occurredAt: '2026-11-27T00:00:00.000Z', ownText: 'receipt', nearby: [{ senderDisplayName: 'Amy', text: 'hello', occurredAt: '2026-11-27T00:00:01.000Z' }] }),
    completeClassification: vi.fn().mockResolvedValue({ status: 'decided', folderId: null, decidedBy: null }),
    retryClassificationLater: vi.fn().mockResolvedValue(undefined),
  };
  const run = vi.fn<(request: { imageRelativePath: string | null; input: ClassifierInput }) => Promise<string>>(options.run);
  const onFailure = vi.fn();
  const classifier = new AttachmentClassifier({ repository: repository as never, run, onFailure });
  return { repository, run, onFailure, classifier };
}
const twoFolders = [folder(A, 'classified'), folder(B, 'classified'), folder(D, 'default')];

describe('parseClassifierAnswer', () => {
  it('reads a valid id, null, a fenced object and refuses everything else', () => {
    expect(parseClassifierAnswer(`{"folder":"${A}","reason":"invoice"}`, [A, B])).toEqual({ kind: 'folder', folderId: A, reason: 'invoice' });
    expect(parseClassifierAnswer('```json\n{"folder":null,"reason":"unclear"}\n```', [A, B])).toEqual({ kind: 'none', reason: 'unclear' });
    expect(parseClassifierAnswer('{"folder":"none"}', [A, B]).kind).toBe('none');
    expect(parseClassifierAnswer('{"folder":"not-an-id","reason":"x"}', [A, B]).kind).toBe('invalid');
    expect(parseClassifierAnswer(`{"folder":"${D}"}`, [A, B]).kind).toBe('invalid');
    expect(parseClassifierAnswer('{"folder":7}', [A, B]).kind).toBe('invalid');
    expect(parseClassifierAnswer('I think folder A.', [A, B]).kind).toBe('invalid');
    expect(parseClassifierAnswer('', [A, B]).kind).toBe('invalid');
  });
  it('cuts the reason to 200 characters', () => {
    const answer = parseClassifierAnswer(JSON.stringify({ folder: A, reason: 'r'.repeat(500) }), [A]);
    expect(answer.kind === 'folder' && answer.reason.length).toBe(200);
  });
});

describe('buildClassifierPrompt', () => {
  it('lists the folders, cuts each nearby text to 300 characters and keeps text inside JSON strings', () => {
    const input: ClassifierInput = { folders: [{ id: A, description: 'invoices', name: 'Bills' }],
      attachment: { name: 'a"b.png', kind: 'image', mimeType: 'image/png', sizeBytes: 5 }, ownText: '', nearby: [{ senderDisplayName: 'Amy', text: `x\n${'y'.repeat(400)}` }] };
    const prompt = buildClassifierPrompt(input, true);
    expect(prompt).toContain(`id: ${A}`);
    expect(prompt).toContain('"a\\"b.png"');
    expect(prompt).toContain('image: attached');
    expect(prompt).not.toContain('y'.repeat(301));
    expect(buildClassifierPrompt(input, false)).toContain('image: not attached');
  });
});

describe('AttachmentClassifier decisions', () => {
  it('copies to the folder the Agent chose', async () => {
    const t = setup({ folders: twoFolders, run: async () => `{"folder":"${B}","reason":"photo"}` });
    await t.classifier.tick();
    expect(t.repository.completeClassification).toHaveBeenCalledWith(expect.anything(), { folderId: B, decidedBy: 'agent', reason: 'photo' });
    expect(t.run.mock.calls[0]![0]).toMatchObject({ imageRelativePath: 'x/a.png' });
  });
  it.each([['null', '{"folder":null,"reason":"unclear"}'], ['an unknown id', '{"folder":"zzz"}'], ['bad JSON', 'sorry']])('uses the default decision for %s', async (_name, answer) => {
    const t = setup({ folders: twoFolders, run: async () => answer });
    await t.classifier.tick();
    expect(t.repository.completeClassification).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ folderId: null, decidedBy: 'default_uncertain' }));
  });
  it('tries again after 1 minute and after 5 minutes, then uses the default folder and records the real code', async () => {
    const failing = Object.assign(new Error('x'), { code: 'CLASSIFIER_TIMEOUT' });
    const first = setup({ folders: twoFolders, run: async () => { throw failing; }, attempts: 1 });
    await first.classifier.tick();
    expect(first.repository.retryClassificationLater).toHaveBeenCalledWith(expect.anything(), 60_000, 'CLASSIFIER_TIMEOUT');
    expect(first.repository.completeClassification).not.toHaveBeenCalled();
    const second = setup({ folders: twoFolders, run: async () => { throw failing; }, attempts: 2 });
    await second.classifier.tick();
    expect(second.repository.retryClassificationLater).toHaveBeenCalledWith(expect.anything(), 300_000, 'CLASSIFIER_TIMEOUT');
    const last = setup({ folders: twoFolders, run: async () => { throw failing; }, attempts: 3 });
    await last.classifier.tick();
    expect(last.repository.retryClassificationLater).not.toHaveBeenCalled();
    expect(last.repository.completeClassification).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ decidedBy: 'default_failed', errorCode: 'CLASSIFIER_TIMEOUT' }));
    expect(last.onFailure).toHaveBeenCalledWith(failing, { attempt: 3, final: true });
  });
  it('does not call the Agent when one rule of the single-folder kind applies', async () => {
    const onlyDefault = setup({ folders: [folder(D, 'default')], run: async () => '' });
    await onlyDefault.classifier.tick();
    expect(onlyDefault.run).not.toHaveBeenCalled();
    expect(onlyDefault.repository.completeClassification).toHaveBeenCalledWith(expect.anything(), { folderId: D, decidedBy: null, reason: null });
    const onlyOne = setup({ folders: [folder(A, 'classified')], run: async () => '' });
    await onlyOne.classifier.tick();
    expect(onlyOne.run).not.toHaveBeenCalled();
    expect(onlyOne.repository.completeClassification).toHaveBeenCalledWith(expect.anything(), { folderId: A, decidedBy: null, reason: null });
  });
  it('asks the Agent for one classification folder and a default folder (the default is never an answer)', async () => {
    const t = setup({ folders: [folder(A, 'classified'), folder(D, 'default')], run: async () => `{"folder":"${D}"}` });
    await t.classifier.tick();
    expect(t.run.mock.calls[0]![0].input.folders.map((entry: { id: string }) => entry.id)).toEqual([A]);
    expect(t.repository.completeClassification).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ decidedBy: 'default_uncertain' }));
  });
});
