import {z} from 'zod';

/** Stagehand 4.3 emits Zod 4 / JSON Schema 2020-12. Interpret it without
 * Ajv's runtime code generation, which is unavailable in production workerd. */
export function stagehandSchema(schema:Record<string,unknown>) {
  try {
    // Per-request registry prevents external schema IDs accumulating or colliding.
    const validator=z.fromJSONSchema(schema,{registry:z.registry()});
    return (value:unknown)=>{
      if(!validator.safeParse(value).success)throw new Error('STAGEHAND_SCHEMA_INVALID');
      return value;
    };
  }catch{throw new Error('STAGEHAND_SCHEMA_INVALID');}
}
