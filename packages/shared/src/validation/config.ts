/**
 * Startup check for a service's environment (Nest ConfigModule `validate`).
 * Secrets named in `requiredInProduction` must be set when NODE_ENV is
 * production (each service lists only the keys it is given; see
 * deploy/k8s/apps.yaml). Numbers named in `positiveInts` must be whole numbers
 * above zero whenever set: `Number("10m")` used to become NaN and a TTL of NaN
 * silently expired everything at once.
 */
export function envValidator(spec: {
  requiredInProduction: readonly string[];
  positiveInts: readonly string[];
}): (env: Record<string, unknown>) => Record<string, unknown> {
  return (env) => {
    const problems: string[] = [];
    if (env.NODE_ENV === 'production') {
      for (const key of spec.requiredInProduction) {
        const value = env[key];
        if (typeof value !== 'string' || !value.trim()) problems.push(`${key} is required`);
      }
    }
    for (const key of spec.positiveInts) {
      const value = env[key];
      if (value === undefined || value === '') continue;
      if (!/^\d+$/.test(String(value).trim()) || Number(value) <= 0) {
        problems.push(`${key} must be a whole number above zero (got "${String(value)}")`);
      }
    }
    if (problems.length) throw new Error(`Invalid configuration: ${problems.join('; ')}`);
    return env;
  };
}
