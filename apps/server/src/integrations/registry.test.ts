import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { IntegrationRegistry } from './registry';

// Zod 3.25: a z.object(...) exposes its `.shape` (a record of key → ZodType);
// each ZodType has `.isOptional()`. Integrations declare object schemas, so the
// cast is safe at runtime.
function shapeKeys(schema: z.ZodType): { key: string; optional: boolean }[] {
  const shape = (schema as unknown as { shape: Record<string, z.ZodTypeAny> }).shape;
  return Object.keys(shape).map((key) => ({ key, optional: shape[key]!.isOptional() }));
}

describe('integration field descriptors match their Zod schemas', () => {
  for (const def of IntegrationRegistry.values()) {
    describe(def.id, () => {
      const credKeys = shapeKeys(def.credentialsSchema);
      const configKeys = shapeKeys(def.configSchema);
      const credFieldNames = def.fields.filter((f) => f.section === 'credentials').map((f) => f.name);
      const configFieldNames = def.fields.filter((f) => f.section === 'config').map((f) => f.name);

      it('declares at least one field', () => {
        expect(def.fields.length).toBeGreaterThan(0);
      });

      it('every credentials field maps to a credentials schema key', () => {
        const keys = credKeys.map((k) => k.key);
        for (const name of credFieldNames) expect(keys).toContain(name);
      });

      it('every config field maps to a config schema key', () => {
        const keys = configKeys.map((k) => k.key);
        for (const name of configFieldNames) expect(keys).toContain(name);
      });

      it('every required schema key has a corresponding field', () => {
        const fieldNames = def.fields.map((f) => f.name);
        for (const { key, optional } of [...credKeys, ...configKeys]) {
          if (!optional) expect(fieldNames).toContain(key);
        }
      });
    });
  }
});
