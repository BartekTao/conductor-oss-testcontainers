export function pickMetrics(metrics, names) {
  const result = {};

  for (const name of names) {
    if (metrics[name]) {
      result[name] = metrics[name];
    }
  }

  return result;
}

export function metricCount(metrics, name) {
  const metric = metrics[name];

  if (!metric || !metric.values) {
    return 0;
  }

  if (metric.values.count !== undefined) {
    return Number(metric.values.count) || 0;
  }

  if (metric.values.rate !== undefined && metric.values.passes !== undefined) {
    return Number(metric.values.passes) + Number(metric.values.fails || 0);
  }

  return 0;
}

export function metricRate(metrics, name) {
  const metric = metrics[name];

  if (!metric || !metric.values || metric.values.rate === undefined) {
    return 0;
  }

  return Number(metric.values.rate) || 0;
}

export function ratio(numerator, denominator) {
  if (!denominator) {
    return 0;
  }

  return numerator / denominator;
}
