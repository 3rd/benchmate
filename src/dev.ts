import { Bench } from "./index";

const bench = new Bench({
  timeMs: 3000,
});

const generateTestData = (size: number) => {
  return Array.from({ length: size }, (_, i) => i);
};
const data = generateTestData(1000);

const sum = (a: number, b: number) => a + b;
bench.add("test", () => data.reduce(sum, 0));

await bench.run();
