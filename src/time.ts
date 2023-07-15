import { global } from "./global";

const getNowProvider = (method: "auto" | "hrtime" | "performance.now" = "auto") => {
  if ((method === "hrtime" || method === "auto") && global.process?.hrtime) {
    return () => Number(global.process!.hrtime.bigint()) / 1e6;
  }

  return () => performance.now();
};

export { getNowProvider };
