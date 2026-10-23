type SingleFlightReadOptions<T> = {
  createState: () => T;
  start: (state: T) => Promise<void>;
  drain: () => Promise<void>;
  timeoutMs: number;
};

export function createSingleFlightRead<T>({ createState, start, drain, timeoutMs }: SingleFlightReadOptions<T>): () => Promise<T> {
  let flight: { response: Promise<T>; settled: Promise<void> } | undefined;
  return () => {
    if (flight) return flight.response;
    const state = createState();
    let dataReady: Promise<void>;
    try { dataReady = Promise.resolve(start(state)); }
    catch { dataReady = Promise.resolve(); }
    const settled = dataReady.then(() => drain()).catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<T>((resolve) => {
      timer = setTimeout(() => { timer = undefined; resolve(state); }, timeoutMs);
    });
    const response = Promise.race([dataReady.then(() => state), deadline]);
    const current = { response, settled };
    flight = current;
    const clearDeadline = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
    };
    void dataReady.then(clearDeadline, clearDeadline);
    void settled.then(() => { if (flight === current) flight = undefined; });
    return response;
  };
}
