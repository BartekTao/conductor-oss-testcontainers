export function numberEnv(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function booleanEnv(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  return String(value).toLowerCase() === 'true';
}

export function stripTrailingSlash(value) {
  return String(value || '').replace(/\/$/, '');
}

export function stripSlashes(value) {
  return String(value || '').replace(/^\/+|\/+$/g, '');
}

export function requireString(value, name) {
  if (!value) {
    throw new Error(`Missing required env: ${name}`);
  }

  return value;
}
