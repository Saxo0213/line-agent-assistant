/** Narrow backend storage entry point; intentionally excludes worker and Chrome adapters. */
export * from './attachment-store.js';
export { WindowsAttachmentBroker, createWindowsAttachmentBroker, resolveWindowsAttachmentBrokerPath } from './windows-attachment-broker.js';
export { IMAGE_SNIFF_PREFIX_BYTES, fallbackAttachmentFileName, peekAttachmentSource } from './attachment-peek.js';
