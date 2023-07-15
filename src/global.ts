const global = globalThis as unknown as {
  performance: Performance;
  process?: {
    hrtime: { bigint: () => bigint };
    env: Record<string, string | undefined>;
  };
};

export { global };
