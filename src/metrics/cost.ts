import type { CostConfig } from '../config/schema.js';
import type { ModelUsage } from './usage.js';

/**
 * Estimates what a model's work cost. One per pricing scheme: `power` charges
 * electricity on inference time; a scheme priced per token (a provider's price
 * table) implements the same interface over the usage's tokens.
 */
export interface CostEstimator {
  readonly id: string;
  /** How estimates are made, in a line for the web UI. */
  readonly basis: string;
  /** The cost of `usage` by `model`, in the configured currency; undefined when it cannot say. */
  estimate(model: string, usage: ModelUsage): number | undefined;
}

/** Estimates the energy a model's work drew, for models whose draw is known. */
export interface EnergyEstimator {
  /** How estimates are made, in a line for the web UI. */
  readonly basis: string;
  /** The energy `usage` by `model` drew, in kWh. */
  kwh(model: string, usage: ModelUsage): number;
}

const MS_PER_HOUR = 3_600_000;

/** What the machine draws while a model generates, charged on inference time. */
export class PowerDraw implements EnergyEstimator {
  constructor(
    private readonly watts: number,
    private readonly modelWatts: Record<string, { watts: number }> = {},
  ) {}

  get basis(): string {
    const others = Object.keys(this.modelWatts).length;
    return `${this.watts} W${others ? ` (${others} model${others === 1 ? '' : 's'} set apart)` : ''} × inference time`;
  }

  kwh(model: string, usage: ModelUsage): number {
    const watts = this.modelWatts[model]?.watts ?? this.watts;
    return (usage.inferenceMs / MS_PER_HOUR) * (watts / 1000);
  }
}

export class PowerEstimator implements CostEstimator {
  readonly id = 'power';
  private readonly draw: PowerDraw;

  constructor(
    watts: number,
    private readonly pricePerKwh: number,
    modelWatts: Record<string, { watts: number }> = {},
    private readonly currency = '',
  ) {
    this.draw = new PowerDraw(watts, modelWatts);
  }

  get basis(): string {
    return `${this.draw.basis} × ${this.pricePerKwh} ${this.currency}/kWh`.trim();
  }

  estimate(model: string, usage: ModelUsage): number {
    return this.draw.kwh(model, usage) * this.pricePerKwh;
  }
}

/** The configured estimator, or none until it has what it needs. */
export function costEstimator(config: CostConfig): CostEstimator | undefined {
  switch (config.estimator) {
    case 'power': {
      const { watts, pricePerKwh, models } = config.power;
      if (watts === undefined || pricePerKwh === undefined) return undefined;
      return new PowerEstimator(watts, pricePerKwh, models, config.currency);
    }
    default:
      return undefined;
  }
}

/** Energy from the configured draw, whichever estimator prices it; none until `power.watts` is set, price or no price. */
export function energyEstimator(config: CostConfig): EnergyEstimator | undefined {
  const { watts, models } = config.power;
  return watts === undefined ? undefined : new PowerDraw(watts, models);
}
