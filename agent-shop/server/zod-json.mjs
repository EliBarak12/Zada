import { z } from 'zod';

// ChatGPT's WebMCP docs require object schemas to declare
// additionalProperties: false — make that explicit everywhere.
function closeObjects(js) {
  if (js && typeof js === 'object') {
    if (js.type === 'object' && js.additionalProperties === undefined) js.additionalProperties = false;
    for (const v of Object.values(js)) closeObjects(v);
  }
  return js;
}

export function zodToJsonSchema(schema) {
  const js = z.toJSONSchema(schema, { target: 'draft-7', io: 'input' });
  delete js.$schema;
  return closeObjects(js);
}
