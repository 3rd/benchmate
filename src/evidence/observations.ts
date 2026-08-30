import type { MeasurementObservation, ObservationFlag } from "../types";

const FLAG_ORDER: readonly ObservationFlag[] = [
  "zero-duration",
  "clock-quantized",
  "pause-like",
  "drift-detected",
  "change-detected",
  "constant-result",
  "unhashable-result",
  "nonlinear-scaling",
];

type ObservationInput = Omit<MeasurementObservation, "flags" | "sequence"> & {
  flags?: readonly ObservationFlag[];
};

const sortFlags = (flags: readonly ObservationFlag[]): readonly ObservationFlag[] => {
  const selected = new Set(flags);
  return Object.freeze(FLAG_ORDER.filter((flag) => selected.has(flag)));
};

const copyObservation = (observation: MeasurementObservation): MeasurementObservation => {
  return Object.freeze({ ...observation, flags: Object.freeze([...observation.flags]) });
};

class ObservationCollector {
  private observations: MeasurementObservation[] = [];

  record(input: ObservationInput): MeasurementObservation {
    if (input.task.length === 0) throw new TypeError("'task' must not be empty.");
    if (!Number.isFinite(input.startedAtMs) || input.startedAtMs < 0) {
      throw new RangeError(`'startedAtMs' must be a finite non-negative number, got ${input.startedAtMs}`);
    }
    if (!Number.isFinite(input.elapsedMs) || input.elapsedMs < 0) {
      throw new RangeError(`'elapsedMs' must be a finite non-negative number, got ${input.elapsedMs}`);
    }
    if (!Number.isSafeInteger(input.operations) || input.operations <= 0) {
      throw new RangeError(`'operations' must be a positive safe integer, got ${input.operations}`);
    }
    if (input.round !== null && (!Number.isSafeInteger(input.round) || input.round < 0)) {
      throw new RangeError(`'round' must be a non-negative safe integer or null, got ${input.round}`);
    }
    if (
      input.seed !== null &&
      (!Number.isInteger(input.seed) || input.seed < 0 || input.seed > 0xFF_FF_FF_FF)
    ) {
      throw new RangeError(`'seed' must be an unsigned 32-bit integer or null, got ${input.seed}`);
    }
    const durationFlags: ObservationFlag[] =
      input.elapsedMs === 0 ? ["zero-duration", "clock-quantized"] : [];
    const observation = copyObservation({
      ...input,
      sequence: this.observations.length,
      flags: sortFlags([...durationFlags, ...(input.flags ?? [])]),
    });
    this.observations.push(observation);
    return copyObservation(observation);
  }

  addFlags(sequence: number, flags: readonly ObservationFlag[]): MeasurementObservation {
    const current = this.observations[sequence];
    if (!current) throw new RangeError(`No observation exists at sequence ${sequence}.`);
    const updated = copyObservation({ ...current, flags: sortFlags([...current.flags, ...flags]) });
    this.observations[sequence] = updated;
    return copyObservation(updated);
  }

  snapshot(): readonly MeasurementObservation[] {
    return Object.freeze(this.observations.map(copyObservation));
  }
}

export { FLAG_ORDER, ObservationCollector };
export type { ObservationInput };
