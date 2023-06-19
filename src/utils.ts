export const sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

// eslint-disable-next-line @typescript-eslint/no-empty-function
export const noop = () => {};
