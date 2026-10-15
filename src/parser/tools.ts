import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { CommandSchema, type ParsedCommand } from './schema.js';

/**
 * The parser's commands, offered to the model as one strict tool per action.
 *
 * Why tools and not one response schema: structured outputs compile the whole schema into a
 * grammar, and a single union of every command outgrew the API's limits (grammar size, and at
 * most 16 nullable/union fields in total). Separate tools keep each grammar small.
 *
 * Why no nulls: nullable fields count against that union limit, so the model sends an empty
 * value instead ("" for text, 0 for numbers, [] for lists, "none" for choices) and
 * `fromToolCall` turns it back into null before the usual validation.
 */

const TOOL_DESCRIPTIONS: Record<ParsedCommand['action'], string> = {
  create: 'Create one reminder (including a single birthday or anniversary).',
  list: 'Show all of the group’s reminders.',
  query: 'Answer a question about existing reminders narrowed by period, person, kind or reminder.',
  cancel: 'Cancel a reminder.',
  edit: 'Change a reminder.',
  set_timezone: 'Change the group timezone.',
  set_policy: 'Change who may create reminders.',
  bulk_add_birthdays: 'Save a pasted list of several birthdays (preview first).',
  link_birthday: 'Link a saved birthday to a mentioned group member.',
  set_date_format: 'Change how the group writes numeric dates.',
  help: 'Explain what the bot does.',
  clarify: 'Ask one short question when something essential is missing.',
  unsupported: 'Anything that is not about this group’s reminders.',
};

export const NONE_CHOICE = 'none';

const UNSUPPORTED_KEYWORDS = new Set([
  '$schema', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems',
]);

type JsonSchema = Record<string, unknown>;

function emptyHint(schema: JsonSchema): string {
  if (schema.type === 'string' && Array.isArray(schema.enum)) return `"${NONE_CHOICE}" if none`;
  if (schema.type === 'string') return 'empty string if none';
  if (schema.type === 'integer' || schema.type === 'number') return '0 if none';
  if (schema.type === 'array') return 'empty list if none';
  return 'empty if none';
}

/** Rewrites zod's JSON Schema into what strict tools accept: no nulls, no numeric/string limits. */
function toStrict(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(toStrict);
  if (!node || typeof node !== 'object') return node;
  const out: JsonSchema = {};
  for (const [k, v] of Object.entries(node)) {
    if (!UNSUPPORTED_KEYWORDS.has(k)) out[k === 'oneOf' ? 'anyOf' : k] = toStrict(v);
  }

  let wasNullable = false;
  const anyOf = out.anyOf as JsonSchema[] | undefined;
  if (anyOf && anyOf.length === 2 && anyOf.some((a) => a.type === 'null')) {
    const { anyOf: _drop, ...rest } = out;
    const inner = anyOf.find((a) => a.type !== 'null')!;
    Object.keys(out).forEach((k) => delete out[k]);
    Object.assign(out, inner, rest);
    wasNullable = true;
  }
  if (Array.isArray(out.type)) {
    const types = (out.type as string[]).filter((t) => t !== 'null');
    wasNullable ||= types.length < (out.type as string[]).length;
    out.type = types.length === 1 ? types[0] : types;
  }
  if (Array.isArray(out.enum) && (wasNullable || out.enum.includes(null))) {
    out.enum = [...(out.enum as unknown[]).filter((e) => e !== null), NONE_CHOICE];
    wasNullable = true;
  }
  if (wasNullable) {
    const hint = `(${emptyHint(out)})`;
    out.description = out.description ? `${String(out.description)} ${hint}` : hint;
  }
  if (out.type === 'object') out.additionalProperties = false;
  return out;
}

function variants(): z.ZodObject[] {
  return CommandSchema.options as unknown as z.ZodObject[];
}

/** The tool list sent with every parse. Stable order and content, so it caches. */
export function commandTools(): Anthropic.Tool[] {
  return variants().map((variant) => {
    const { action, ...shape } = variant.shape as Record<string, z.ZodType> & { action: z.ZodLiteral<string> };
    const name = action.value as ParsedCommand['action'];
    return {
      name,
      description: TOOL_DESCRIPTIONS[name],
      strict: true,
      input_schema: toStrict(z.toJSONSchema(z.object(shape))) as Anthropic.Tool.InputSchema,
    };
  });
}

/** Text the model sometimes writes for "nothing" instead of an empty string. */
const EMPTY_TEXT = new Set(['', 'null', '""', "''", 'none', 'n/a']);

/** Turns empty values back into null wherever the command schema allows null. */
function restoreNulls(schema: z.ZodType, value: unknown): unknown {
  if (schema instanceof z.ZodNullable) {
    const inner = schema.unwrap() as z.ZodType;
    if (value === null || value === undefined) return null;
    if (inner instanceof z.ZodString && typeof value === 'string' && EMPTY_TEXT.has(value.trim().toLowerCase())) return null;
    if (inner instanceof z.ZodNumber && value === 0) return null;
    if (inner instanceof z.ZodEnum && value === NONE_CHOICE) return null;
    if (inner instanceof z.ZodArray && Array.isArray(value) && value.length === 0) return null;
    return restoreNulls(inner, value);
  }
  if (schema instanceof z.ZodObject && value && typeof value === 'object' && !Array.isArray(value)) {
    const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
    for (const [key, field] of Object.entries(schema.shape as Record<string, z.ZodType>)) {
      out[key] = restoreNulls(field, out[key]);
    }
    return out;
  }
  if (schema instanceof z.ZodArray && Array.isArray(value)) {
    return value.map((v) => restoreNulls(schema.element as z.ZodType, v));
  }
  return value;
}

/** Rebuilds the command from a tool call, ready for `validateCommand`. Unknown tools pass through. */
export function fromToolCall(name: string, input: unknown): unknown {
  const variant = variants().find((v) => (v.shape.action as z.ZodLiteral<string>).value === name);
  const withAction = { ...(input && typeof input === 'object' ? input : {}), action: name };
  return variant ? restoreNulls(variant, withAction) : withAction;
}
