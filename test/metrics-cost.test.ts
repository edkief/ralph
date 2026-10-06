import { describe, expect, it } from 'vitest';
import { costEstimator, energyEstimator } from '../src/metrics/cost.js';
import { emptyUsage } from '../src/metrics/usage.js';

const hour = { ...emptyUsage(), inferenceMs: 3_600_000, input: 1_000_000 };

describe('costEstimator', () => {
  it('is off until watts and a price per kWh are set', () => {
    expect(costEstimator({ estimator: 'power', currency: 'USD', power: { watts: 300, models: {} } })).toBeUndefined();
    expect(costEstimator({ estimator: 'power', currency: 'USD', power: { pricePerKwh: 0.3, models: {} } })).toBeUndefined();
  });

  it('charges power on inference time, per model where one draws differently', () => {
    const estimator = costEstimator({
      estimator: 'power',
      currency: 'EUR',
      power: { watts: 400, pricePerKwh: 0.25, models: { 'ollama/small': { watts: 100 } } },
    })!;
    expect(estimator.estimate('ollama/big', hour)).toBeCloseTo(0.1);
    expect(estimator.estimate('ollama/small', hour)).toBeCloseTo(0.025);
    expect(estimator.estimate('ollama/big', { ...hour, inferenceMs: 0 })).toBe(0);
    expect(estimator.basis).toBe('400 W (1 model set apart) × inference time × 0.25 EUR/kWh');
  });
});

describe('energyEstimator', () => {
  it('needs only watts, not a price', () => {
    expect(energyEstimator({ estimator: 'power', currency: 'USD', power: { pricePerKwh: 0.3, models: {} } })).toBeUndefined();
    const energy = energyEstimator({ estimator: 'power', currency: 'USD', power: { watts: 400, models: {} } })!;
    expect(energy.kwh('ollama/big', hour)).toBeCloseTo(0.4);
    expect(energy.basis).toBe('400 W × inference time');
  });

  it('draws per model where one draws differently, as the cost does', () => {
    const config = { estimator: 'power' as const, currency: 'EUR', power: { watts: 400, pricePerKwh: 0.25, models: { 'ollama/small': { watts: 100 } } } };
    const energy = energyEstimator(config)!;
    expect(energy.kwh('ollama/small', hour)).toBeCloseTo(0.1);
    expect(energy.kwh('ollama/big', { ...hour, inferenceMs: 1_800_000 })).toBeCloseTo(0.2);
    expect(costEstimator(config)!.estimate('ollama/small', hour)).toBeCloseTo(energy.kwh('ollama/small', hour) * 0.25);
    expect(energy.basis).toBe('400 W (1 model set apart) × inference time');
  });
});
