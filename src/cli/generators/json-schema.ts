import { RegistrySnapshot } from '../../services/registry/registry.types';

export function generateJsonSchema(snapshot: RegistrySnapshot): Record<string, any> {
  const output: Record<string, any> = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'atomic-queues Registry Schema',
    description: `Generated from registry (prefix: ${snapshot.keyPrefix})`,
    generatedAt: new Date(snapshot.generatedAt).toISOString(),
    definitions: {},
  };

  for (const entity of snapshot.entities) {
    for (const [msgName, spec] of Object.entries(entity.messages)) {
      const defKey = `${entity.entityType}.${msgName}`;
      output.definitions[defKey] = {
        title: msgName,
        description: `${spec.kind} for entity type '${entity.entityType}' (service: ${entity.serviceName})`,
        ...(spec.schema || { type: 'object' }),
      };

      if (spec.replySchema) {
        output.definitions[`${defKey}Reply`] = {
          title: `${msgName}Reply`,
          description: `Reply for ${msgName}`,
          ...spec.replySchema,
        };
      }
    }
  }

  return output;
}
