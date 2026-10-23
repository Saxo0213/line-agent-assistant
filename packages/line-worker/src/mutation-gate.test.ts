import { describe, expect, it, vi } from "vitest";

import {
  EffectDeniedError,
  createMutationGate,
  type ControlLease,
  type RpcTransportState,
  type TrustedRequestClient,
} from "./mutation-gate.js";

type FakeCall = Readonly<{
  operation:
    | "send"
    | "unsend"
    | "profile"
    | "register-public-key"
    | "last-group-key"
    | "last-public-keys"
    | "register-group-key"
    | "legacy-login-z"
    | "legacy-login-v2"
    | "legacy-confirm-e2ee"
    | "relation-ids"
    | "relation-details"
    | "relation-add";
  payload?: Readonly<Record<string, string>>;
}>;

type TransportResult = Readonly<{ status: number }>;

const ACCOUNT = "u-agent";
const WORKER = "worker-1";
const LEASE: ControlLease = Object.freeze({
  accountId: ACCOUNT,
  workerInstanceId: WORKER,
  controlEpoch: 7,
});

const RPC_BY_OPERATION: Readonly<Record<FakeCall["operation"], Readonly<{
  methodName: string;
  path: string;
}>>> = Object.freeze({
  send: { methodName: "sendMessage", path: "/S4" },
  unsend: { methodName: "unsendMessage", path: "/S4" },
  profile: { methodName: "getProfile", path: "/S4" },
  "register-public-key": { methodName: "registerE2EEPublicKey", path: "/S4" },
  "last-group-key": { methodName: "getLastE2EEGroupSharedKey", path: "/S4" },
  "last-public-keys": { methodName: "getLastE2EEPublicKeys", path: "/S4" },
  "register-group-key": { methodName: "registerE2EEGroupKey", path: "/S4" },
  "legacy-login-z": { methodName: "loginZ", path: "/S4" },
  "legacy-login-v2": { methodName: "loginV2", path: "/S4" },
  "legacy-confirm-e2ee": { methodName: "confirmE2EELogin", path: "/S4" },
  "relation-ids": { methodName: "getUserFriendIds", path: "/RE4" },
  "relation-details": { methodName: "getFriendDetails", path: "/RE4" },
  "relation-add": { methodName: "addFriendByMid", path: "/RE4" },
});

class FidelityRequestClient implements TrustedRequestClient<
  FakeCall,
  TransportResult,
  TransportResult
> {
  readonly #transport: RpcTransportState;
  readonly #physicalAttempts: number;
  readonly #catchFirstFailure: boolean;
  readonly #physicalUrl: string;
  escapedFetch?: (request: Request) => Promise<TransportResult>;
  lastLogicalRequest?: Request;
  lastSerializedBody?: string;
  lastOuterBody?: string;

  constructor(options: Readonly<{
    transport: RpcTransportState;
    physicalAttempts?: number;
    catchFirstFailure?: boolean;
    physicalUrl?: string;
  }>) {
    this.#transport = options.transport;
    this.#physicalAttempts = options.physicalAttempts ?? 1;
    this.#catchFirstFailure = options.catchFirstFailure ?? false;
    this.#physicalUrl = options.physicalUrl ?? "https://gf.line.naver.jp/enc";
  }

  async invoke(call: FakeCall, dispatch: Parameters<TrustedRequestClient<
    FakeCall,
    TransportResult,
    TransportResult
  >["invoke"]>[1]): Promise<TransportResult> {
    const rpc = RPC_BY_OPERATION[call.operation];
    // Fidelity seam: the actual method used for authorization is the same
    // value consumed by the serializer. The public caller supplies no method,
    // path, Request, transport, or fetch closure.
    const body = JSON.stringify({
      methodName: rpc.methodName,
      payload: call.payload ?? null,
    });
    this.lastSerializedBody = body;
    const logicalRequest = new Request(`https://legy.line-apps.com${rpc.path}`, {
      method: "POST",
      body,
    });
    this.lastLogicalRequest = logicalRequest;

    return dispatch({
      actualMethodName: rpc.methodName,
      actualPath: rpc.path,
      transport: this.#transport,
      logicalRequest,
      execute: async (customFetch) => {
        this.escapedFetch = customFetch;
        const physical = this.#transport.mode === "legy-encrypted"
          ? await this.#legyTransform(logicalRequest)
          : logicalRequest;
        let result: TransportResult | undefined;
        for (let attempt = 0; attempt < this.#physicalAttempts; attempt += 1) {
          try {
            result = await customFetch(physical);
          } catch (error) {
            if (!this.#catchFirstFailure || attempt > 0) throw error;
          }
        }
        if (result === undefined) throw new Error("no transport result");
        return result;
      },
    });
  }

  async #legyTransform(logicalRequest: Request): Promise<Request> {
    const inner = await logicalRequest.clone().text();
    this.lastOuterBody = `LEGY:${Buffer.from(inner).toString("base64url")}`;
    return new Request(this.#physicalUrl, {
      method: "POST",
      body: this.lastOuterBody,
    });
  }
}

function setup(options: Readonly<{
  requestClient: FidelityRequestClient;
  leaseResults?: readonly boolean[];
  transport?: (request: Request) => Promise<TransportResult>;
}>) {
  const seen: Request[] = [];
  const leaseResults = [...(options.leaseResults ?? [true])];
  const validateControlLease = vi.fn(async () => leaseResults.shift() ?? true);
  const physicalTransport = vi.fn(options.transport ?? (async (request: Request) => {
    seen.push(request);
    return { status: 200 };
  }));
  const gate = createMutationGate({
    accountId: ACCOUNT,
    workerInstanceId: WORKER,
    validateControlLease,
    physicalTransport,
    requestClient: options.requestClient,
  });
  return { gate, seen, validateControlLease, physicalTransport };
}

function encryptedClient(options: Partial<ConstructorParameters<typeof FidelityRequestClient>[0]> = {}) {
  return new FidelityRequestClient({
    transport: { mode: "legy-encrypted", tokenState: "v3-jwt" },
    ...options,
  });
}

describe("trusted RequestClient boundary", () => {
  it("requires a current matching lease for manual sends", async () => {
    const client = encryptedClient();
    const { gate, physicalTransport, validateControlLease } = setup({ requestClient: client, leaseResults: [false] });
    await expect(gate.invokeRpc({ phase: "MANUAL_SEND", lease: LEASE }, { operation: "send" }))
      .rejects.toMatchObject({ code: "SIDE_EFFECT_DENIED" });
    expect(validateControlLease).toHaveBeenCalledWith(LEASE, "MANUAL_SEND");
    expect(physicalTransport).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    { accountId: "wrong", workerInstanceId: WORKER, controlEpoch: 7 },
    { accountId: ACCOUNT, workerInstanceId: "wrong", controlEpoch: 7 },
  ])("rejects missing or wrong MANUAL_SEND lease %#", async (lease) => {
    const client = encryptedClient();
    const { gate, physicalTransport } = setup({ requestClient: client });
    await expect(gate.invokeRpc(
      { phase: "MANUAL_SEND", ...(lease === undefined ? {} : { lease }) }, { operation: "send" },
    )).rejects.toMatchObject({ code: "SIDE_EFFECT_DENIED" });
    expect(physicalTransport).not.toHaveBeenCalled();
  });

  it("revalidates a manual lease after asynchronous preparation before transport", async () => {
    let current = true;
    let release!: () => void;
    let reached!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const prepared = new Promise<void>((resolve) => { reached = resolve; });
    const client = new FidelityRequestClient({ transport: { mode: "legy-encrypted", tokenState: "v3-jwt" } });
    const requestClient: TrustedRequestClient<FakeCall, TransportResult, TransportResult> = {
      invoke: async (call, dispatch) => {
        const rpc = RPC_BY_OPERATION[call.operation];
        const logicalRequest = new Request(`https://legy.line-apps.com${rpc.path}`, { method: "POST", body: "{}" });
        return dispatch({ actualMethodName: rpc.methodName, actualPath: rpc.path,
          transport: { mode: "legy-encrypted", tokenState: "v3-jwt" }, logicalRequest,
          execute: async (fetch) => {
            reached(); await held;
            return fetch(new Request("https://gf.line.naver.jp/enc", { method: "POST", body: "prepared" }));
          } });
      },
    };
    const validateControlLease = vi.fn(async () => current);
    const physicalTransport = vi.fn(async () => ({ status: 200 }));
    const gate = createMutationGate({ accountId: ACCOUNT, workerInstanceId: WORKER, validateControlLease,
      requestClient, physicalTransport });
    const sending = gate.invokeRpc({ phase: "MANUAL_SEND", lease: LEASE }, { operation: "send" });
    await prepared;
    current = false;
    release();
    await expect(sending).rejects.toMatchObject({ code: "SIDE_EFFECT_DENIED" });
    expect(validateControlLease).toHaveBeenCalledWith(LEASE, "MANUAL_SEND");
    expect(physicalTransport).not.toHaveBeenCalled();
  });

  it("allows one physical manual send across repeated attempts", async () => {
    const client = encryptedClient({ physicalAttempts: 2 });
    const { gate, physicalTransport } = setup({ requestClient: client });
    await expect(gate.invokeRpc({ phase: "MANUAL_SEND", lease: LEASE }, { operation: "send" }))
      .rejects.toMatchObject({ code: "SIDE_EFFECT_DENIED" });
    expect(physicalTransport).toHaveBeenCalledTimes(1);
  });

  it("allows one physical manual send across concurrent fetch attempts", async () => {
    let validations = 0;
    let release!: () => void;
    const validatedTwice = new Promise<void>((resolve) => { release = resolve; });
    const client: TrustedRequestClient<FakeCall, TransportResult, TransportResult> = {
      invoke: async (_call, dispatch) => {
        const logicalRequest = new Request("https://legy.line-apps.com/S4", { method: "POST", body: "{}" });
        return dispatch({ actualMethodName: "sendMessage", actualPath: "/S4",
          transport: { mode: "legy-encrypted", tokenState: "v3-jwt" }, logicalRequest,
          execute: async (fetch) => {
            const outer = new Request("https://gf.line.naver.jp/enc", { method: "POST", body: "encrypted" });
            const first = fetch(outer.clone());
            const second = fetch(outer.clone());
            return Promise.allSettled([first, second]).then(() => ({ status: 200 }));
          } });
      },
    };
    const validateControlLease = vi.fn(async () => {
      validations += 1;
      if (validations === 2) release();
      await validatedTwice;
      return true;
    });
    const physicalTransport = vi.fn(async () => ({ status: 200 }));
    const gate = createMutationGate({ accountId: ACCOUNT, workerInstanceId: WORKER,
      validateControlLease, requestClient: client, physicalTransport });
    await gate.invokeRpc({ phase: "MANUAL_SEND", lease: LEASE }, { operation: "send" });
    expect(physicalTransport).toHaveBeenCalledTimes(1);
  });

  it("does not retry a failed physical manual send", async () => {
    const client = encryptedClient({ physicalAttempts: 2, catchFirstFailure: true });
    const transport = vi.fn(async () => { throw new Error("timeout after dispatch"); });
    const { gate } = setup({ requestClient: client, transport });
    await expect(gate.invokeRpc({ phase: "MANUAL_SEND", lease: LEASE }, { operation: "send" }))
      .rejects.toMatchObject({ code: "SIDE_EFFECT_DENIED" });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("limits a manual grant to one native sendMessage RPC", async () => {
    const client = encryptedClient();
    const { gate, physicalTransport } = setup({ requestClient: client });
    await gate.invokeRpc({ phase: "MANUAL_SEND", lease: LEASE }, { operation: "send", payload: { text: "hello" } });
    await expect(gate.invokeRpc({ phase: "MANUAL_SEND", lease: LEASE }, { operation: "unsend" }))
      .rejects.toMatchObject({ code: "SIDE_EFFECT_DENIED" });
    expect(physicalTransport).toHaveBeenCalledTimes(1);
  });

  it("permits Relation reads only in CONTROL_READ and permits exactly addFriendByMid as a CONTROL_SEND", async () => {
    const direct = new FidelityRequestClient({ transport: { mode: "direct", tokenState: "v3-jwt" } });
    const { gate, physicalTransport } = setup({ requestClient: direct });
    await gate.invokeRpc({ phase: "CONTROL_READ", lease: LEASE }, { operation: "relation-ids" });
    await gate.invokeRpc({ phase: "CONTROL_READ", lease: LEASE }, { operation: "relation-details" });
    await expect(gate.invokeRpc({ phase: "MONITOR_READ" }, { operation: "relation-ids" }))
      .rejects.toMatchObject({ code: "SIDE_EFFECT_DENIED" });
    await gate.invokeRpc({ phase: "CONTROL_SEND", lease: LEASE }, { operation: "relation-add" });
    expect(physicalTransport).toHaveBeenCalledTimes(3);
  });

  it("authorizes the actual method consumed by the serializer through the LEGY transform", async () => {
    const client = encryptedClient();
    const { gate, seen } = setup({ requestClient: client });

    await expect(gate.invokeRpc(
      { phase: "CONTROL_SEND", lease: LEASE },
      { operation: "send", payload: { text: "hello" }, claimedMethodName: "unsendMessage" } as FakeCall,
    )).resolves.toEqual({ status: 200 });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("https://gf.line.naver.jp/enc");
    const encoded = client.lastOuterBody?.slice("LEGY:".length) ?? "";
    expect(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))).toEqual({
      methodName: "sendMessage",
      payload: { text: "hello" },
    });
    expect("runRpc" in gate).toBe(false);
  });

  it("rejects a serialized write method that is not allowlisted", async () => {
    const client = encryptedClient();
    const { gate, physicalTransport } = setup({ requestClient: client });

    await expect(gate.invokeRpc(
      { phase: "CONTROL_SEND", lease: LEASE },
      { operation: "unsend" },
    )).rejects.toMatchObject({ code: "SIDE_EFFECT_DENIED" });
    expect(physicalTransport).not.toHaveBeenCalled();
  });

  it("expires captured custom fetch and rejects a fabricated same-URL outer", async () => {
    const client = encryptedClient();
    const { gate, physicalTransport } = setup({ requestClient: client });
    await gate.invokeRpc(
      { phase: "CONTROL_SEND", lease: LEASE },
      { operation: "send" },
    );

    await expect(client.escapedFetch?.(new Request("https://gf.line.naver.jp/enc", {
      method: "POST",
      body: "fabricated",
    }))).rejects.toMatchObject({ code: "SIDE_EFFECT_DENIED" });
    expect(physicalTransport).toHaveBeenCalledTimes(1);
  });

  it("rejects a captured custom fetch called outside its active async context", async () => {
    let capturedFetch: ((request: Request) => Promise<TransportResult>) | undefined;
    let signalCaptured: (() => void) | undefined;
    let releaseInvocation: (() => void) | undefined;
    const captured = new Promise<void>((resolve) => { signalCaptured = resolve; });
    const release = new Promise<void>((resolve) => { releaseInvocation = resolve; });
    const requestClient: TrustedRequestClient<FakeCall, TransportResult, TransportResult> = {
      invoke: async (call, dispatch) => {
        const rpc = RPC_BY_OPERATION[call.operation];
        const logicalRequest = new Request(`https://legy.line-apps.com${rpc.path}`, {
          method: "POST",
          body: JSON.stringify({ methodName: rpc.methodName }),
        });
        return dispatch({
          actualMethodName: rpc.methodName,
          actualPath: rpc.path,
          transport: { mode: "legy-encrypted", tokenState: "v3-jwt" },
          logicalRequest,
          execute: async (customFetch) => {
            capturedFetch = customFetch;
            signalCaptured?.();
            await release;
            return customFetch(new Request("https://gf.line.naver.jp/enc", {
              method: "POST",
              body: "trusted-legy-body",
            }));
          },
        });
      },
    };
    const physicalTransport = vi.fn(async () => ({ status: 200 }));
    const gate = createMutationGate({
      accountId: ACCOUNT,
      workerInstanceId: WORKER,
      validateControlLease: async () => true,
      requestClient,
      physicalTransport,
    });

    const invocation = gate.invokeRpc(
      { phase: "CONTROL_READ", lease: LEASE },
      { operation: "profile" },
    );
    await captured;
    const escaped = capturedFetch;
    expect(escaped).toBeTypeOf("function");
    await expect(escaped?.(new Request("https://gf.line.naver.jp/enc", {
      method: "POST",
      body: "fabricated",
    }))).rejects.toMatchObject({ code: "SIDE_EFFECT_DENIED" });
    expect(physicalTransport).not.toHaveBeenCalled();

    releaseInvocation?.();
    await expect(invocation).resolves.toEqual({ status: 200 });
    expect(physicalTransport).toHaveBeenCalledTimes(1);
  });

  it("consumes CONTROL_SEND before a throw so the RequestClient cannot blindly retry", async () => {
    const client = encryptedClient({ physicalAttempts: 2, catchFirstFailure: true });
    const transport = vi.fn(async () => { throw new Error("timeout after dispatch"); });
    const { gate } = setup({ requestClient: client, transport });

    await expect(gate.invokeRpc(
      { phase: "CONTROL_SEND", lease: LEASE },
      { operation: "send" },
    )).rejects.toMatchObject({ code: "SIDE_EFFECT_DENIED" });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("keeps addFriendByMid single-use even when the RequestClient catches a failed first fetch", async () => {
    const client = new FidelityRequestClient({ transport: { mode: 'direct', tokenState: 'v3-jwt' },
      physicalAttempts: 2, catchFirstFailure: true });
    const transport = vi.fn(async () => { throw new Error('timeout after dispatch'); });
    const { gate } = setup({ requestClient: client, transport });
    await expect(gate.invokeRpc({ phase: 'CONTROL_SEND', lease: LEASE }, { operation: 'relation-add' }))
      .rejects.toMatchObject({ code: 'SIDE_EFFECT_DENIED' });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("rejects a second CONTROL_SEND physical fetch even after transport success", async () => {
    const client = encryptedClient({ physicalAttempts: 2 });
    const { gate, physicalTransport } = setup({ requestClient: client });
    await expect(gate.invokeRpc(
      { phase: "CONTROL_SEND", lease: LEASE },
      { operation: "send" },
    )).rejects.toMatchObject({ code: "SIDE_EFFECT_DENIED" });
    expect(physicalTransport).toHaveBeenCalledTimes(1);
  });

  it("rejects physical URL drift produced by the RequestClient transform", async () => {
    const client = encryptedClient({ physicalUrl: "https://evil.example/enc" });
    const { gate, physicalTransport } = setup({ requestClient: client });
    await expect(gate.invokeRpc(
      { phase: "MONITOR_READ" },
      { operation: "profile" },
    )).rejects.toMatchObject({ code: "SIDE_EFFECT_DENIED" });
    expect(physicalTransport).not.toHaveBeenCalled();
  });

  it("revalidates CONTROL_READ on every physical fetch", async () => {
    const client = encryptedClient({ physicalAttempts: 2 });
    const { gate, physicalTransport, validateControlLease } = setup({
      requestClient: client,
      leaseResults: [true, false],
    });

    await expect(gate.invokeRpc(
      { phase: "CONTROL_READ", lease: LEASE },
      { operation: "profile" },
    )).rejects.toMatchObject({ code: "SIDE_EFFECT_DENIED" });
    expect(validateControlLease).toHaveBeenCalledTimes(2);
    expect(validateControlLease).toHaveBeenNthCalledWith(1, LEASE, "CONTROL_READ");
    expect(validateControlLease).toHaveBeenNthCalledWith(2, LEASE, "CONTROL_READ");
    expect(physicalTransport).toHaveBeenCalledTimes(1);
  });
});

describe("transport modes and allowlists", () => {
  it("allows tokenless QR registration only as the exact direct logical Request", async () => {
    const client = new FidelityRequestClient({ transport: { mode: "direct", tokenState: "none" } });
    const { gate, seen } = setup({ requestClient: client });
    await gate.invokeRpc(
      { phase: "AUTH_BOOTSTRAP" },
      { operation: "register-public-key" },
    );
    expect(seen[0]).toBe(client.lastLogicalRequest);
    expect(seen[0]?.url).toBe("https://legy.line-apps.com/S4");
  });

  it("rejects tokenless getProfile because QR-ready profile calls require installed V3 transport", async () => {
    const client = new FidelityRequestClient({ transport: { mode: "direct", tokenState: "none" } });
    const { gate, physicalTransport } = setup({ requestClient: client });
    await expect(gate.invokeRpc(
      { phase: "AUTH_BOOTSTRAP" },
      { operation: "profile" },
    )).rejects.toMatchObject({ code: "SIDE_EFFECT_DENIED" });
    expect(physicalTransport).not.toHaveBeenCalled();
  });

  it.each([
    ["AUTH_BOOTSTRAP", "profile"],
    ["MONITOR_READ", "profile"],
  ] as const)("allows verified V3 encrypted %s RPC", async (phase, operation) => {
    const client = encryptedClient();
    const { gate, seen } = setup({ requestClient: client });
    await gate.invokeRpc({ phase }, { operation });
    expect(seen[0]?.url).toBe("https://gf.line.naver.jp/enc");
  });

  it.each([
    { mode: "unsupported", tokenState: "legacy-opaque" } as const,
    { mode: "direct", tokenState: "v3-jwt" } as const,
  ])("fails closed for unsupported Talk transport %#", async (transport) => {
    const client = new FidelityRequestClient({ transport });
    const { gate, physicalTransport } = setup({ requestClient: client });
    await expect(gate.invokeRpc(
      { phase: "MONITOR_READ" },
      { operation: "profile" },
    )).rejects.toMatchObject({ code: "SIDE_EFFECT_DENIED" });
    expect(physicalTransport).not.toHaveBeenCalled();
  });

  it.each(["last-group-key", "last-public-keys"] as const)(
    "allows monitor read %s",
    async (operation) => {
      const client = encryptedClient();
      const { gate } = setup({ requestClient: client });
      await expect(gate.invokeRpc(
        { phase: "MONITOR_READ" },
        { operation },
      )).resolves.toEqual({ status: 200 });
    },
  );

  it.each(["register-group-key", "legacy-login-z", "legacy-login-v2", "legacy-confirm-e2ee"] as const)(
    "denies non-fixture RPC %s",
    async (operation) => {
      const client = encryptedClient();
      const { gate } = setup({ requestClient: client });
      await expect(gate.invokeRpc(
        { phase: operation === "register-group-key" ? "MONITOR_READ" : "AUTH_BOOTSTRAP" },
        { operation },
      )).rejects.toBeInstanceOf(EffectDeniedError);
    },
  );
});

describe("control lease and OBS reads", () => {
  it.each([
    undefined,
    { accountId: "wrong", workerInstanceId: WORKER, controlEpoch: 7 },
    { accountId: ACCOUNT, workerInstanceId: "wrong", controlEpoch: 7 },
  ])("rejects missing or wrong CONTROL_READ lease %#", async (lease) => {
    const client = encryptedClient();
    const { gate } = setup({ requestClient: client });
    await expect(gate.invokeRpc(
      { phase: "CONTROL_READ", ...(lease === undefined ? {} : { lease }) },
      { operation: "profile" },
    )).rejects.toMatchObject({ code: "SIDE_EFFECT_DENIED" });
  });

  it("rejects a revoked or stale control epoch before physical transport", async () => {
    const client = encryptedClient();
    const { gate, physicalTransport, validateControlLease } = setup({
      requestClient: client,
      leaseResults: [false],
    });
    const stale = { ...LEASE, controlEpoch: 6 };
    await expect(gate.invokeRpc(
      { phase: "CONTROL_READ", lease: stale },
      { operation: "profile" },
    )).rejects.toMatchObject({ code: "SIDE_EFFECT_DENIED" });
    expect(validateControlLease).toHaveBeenCalledWith(stale, "CONTROL_READ");
    expect(physicalTransport).not.toHaveBeenCalled();
  });

  it.each([
    "?p=one&p=two", "?other=value", "?p=a&x=b", "?p=%2F..%2F", "?p=%00",
  ])("rejects noncanonical OBS query %s before transport", async (query) => {
    const client = encryptedClient();
    const { gate, physicalTransport } = setup({ requestClient: client });
    await expect(gate.runFetch({ phase: "MONITOR_READ" },
      new Request(`https://obs.line-apps.com/r/talk/emi/OID_123${query}`, { method: "GET", redirect: "error" })))
      .rejects.toMatchObject({ code: "SIDE_EFFECT_DENIED" });
    expect(physicalTransport).not.toHaveBeenCalled();
  });

  it.each(["/r/talk/emi/OID_123/object_info.obs", "/r/talk/emi/OID_123", "/r/talk/m/9/original"])(
    "allows only gated Chrome attachment path %s", async (path) => {
      const client = encryptedClient();
      const { gate } = setup({ requestClient: client });
      await expect(gate.runFetch({ phase: "MONITOR_READ" },
        new Request(`https://obs.line-apps.com${path}?p=pop%20value`, { method: "GET", redirect: "error" })))
        .resolves.toEqual({ status: 200 });
    });

  it.each(["emi", "emv", "ema", "emf"])("allows fixture OBS %s OID", async (kind) => {
    const client = encryptedClient();
    const { gate } = setup({ requestClient: client });
    await expect(gate.runFetch(
      { phase: "MONITOR_READ" },
      new Request(`https://obs.line-apps.com/r/talk/${kind}/OID_123`, { method: "GET", redirect: "error" }),
    )).resolves.toEqual({ status: 200 });
  });

  it.each([
    new Request("https://evil.example/r/talk/emi/OID_123"),
    new Request("https://obs.line-apps.com/r/talk/emi/no_digit"),
    new Request("https://obs.line-apps.com/r/talk/emi/OID_123", { method: "POST" }),
    new Request("https://obs.line-apps.com/r/talk/emi/OID_123", { method: "GET", redirect: "follow" }),
  ])("rejects OBS host/path/verb drift", async (request) => {
    const client = encryptedClient();
    const { gate } = setup({ requestClient: client });
    await expect(gate.runFetch({ phase: "MONITOR_READ" }, request))
      .rejects.toMatchObject({ code: "SIDE_EFFECT_DENIED" });
  });
});
