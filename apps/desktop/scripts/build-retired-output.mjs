import { rm } from 'node:fs/promises';
import path from 'node:path';

export async function removeRetiredProbeOutput(scriptsDirectory) {
  await rm(path.join(scriptsDirectory, 'external-monitor-probe.py'), { force: true });
}
