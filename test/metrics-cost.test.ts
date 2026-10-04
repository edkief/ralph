import { describe, expect, it } from 'vitest';
import { costEstimator } from '../src/metrics/cost.js';
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
