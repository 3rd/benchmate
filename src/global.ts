export const global = globalThis as unknown as {
  performance: Performance;
  process?: {
    hrtime: { bigint: () => bigint };
    env: { [key: string]: string | undefined };
  };
};
