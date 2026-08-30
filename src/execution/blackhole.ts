import { global } from "../platform/global";

const blackholeGlobal = global as { __benchmateBlackhole?: unknown } & typeof global;

type Blackhole = (value: unknown) => void;

// the global store keeps the final value observable outside the benchmarked callback
const blackhole: Blackhole = (value) => {
  blackholeGlobal.__benchmateBlackhole = value;
};

export { blackhole };
