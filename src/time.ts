export const getNowProvider = (method: "auto" | "hrtime" | "performance.now" = "auto") => {
  if ((method === "hrtime" || method === "auto") && typeof process !== "undefined" && "hrtime" in process) {
    return () => Number(process.hrtime.bigint()) / 1e6;
  }
  return () => performance.now();
};
