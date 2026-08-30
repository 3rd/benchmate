const global = globalThis as unknown as {
  process?: {
    hrtime?: { bigint?: () => bigint };
    env?: Record<string, string | undefined>;
  };
};

export { global };
