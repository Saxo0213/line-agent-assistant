import { diagnosticFailure } from '@line-agent/contracts';
import type { DiagnosticIdentity, SafeDiagnostic } from '@line-agent/contracts';

export type TrackedOperationContext = {
  operation: SafeDiagnostic['operation'];
  identity?: DiagnosticIdentity;
  reportFailure?: boolean;
};

export type TrackedOperationState = {
  inFlight: Set<Promise<unknown>>;
  isClosing: () => boolean;
  onFailure: (diagnostic: SafeDiagnostic, identity: DiagnosticIdentity & { initiator: 'system' }) => void;
};

function wasChatResourceDiagnosticLogged(error: unknown): boolean {
  return !!error && typeof error === 'object'
    && ((error as { chatResourceDiagnosticLogged?: unknown }).chatResourceDiagnosticLogged === true
      || (error as { diagnosticLogged?: unknown }).diagnosticLogged === true);
}

export function trackOperation<T>(
  work: () => Promise<T>,
  context: TrackedOperationContext,
  state: TrackedOperationState,
): Promise<T> {
  const operation = Promise.resolve().then(work);
  state.inFlight.add(operation);
  void operation.then(
    () => state.inFlight.delete(operation),
    (error: unknown) => {
      state.inFlight.delete(operation);
      if (!state.isClosing() && context.reportFailure !== false && !wasChatResourceDiagnosticLogged(error)) {
        state.onFailure(diagnosticFailure(context.operation, 'execute', error), {
          ...context.identity,
          initiator: 'system',
        });
      }
    },
  );
  return operation;
}
