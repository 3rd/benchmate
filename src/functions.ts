export const compileTaskFunction = (fn: () => Promise<void> | void) => {
  // return async (iterations: number, now: () => number) => {
  //   let remainingIterations = iterations;
  //   const start = now();
  //   while (remainingIterations--) { await fn(); }
  //   return now() - start;
  // };
  const isAsync = fn() instanceof Promise;
  const body = [
    isAsync ? `async function (iterations, now) {` : `function (iterations, now) {`,
    `
      let remainingIterations = iterations;
      const start = now();
      while (remainingIterations--) {
        ${isAsync ? "await " : ""}fn();
      }
      return now() - start;
    }`,
  ];
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  return new Function(`return (function(fn) { return ${body.join("\n")} });`)()(fn);
};
