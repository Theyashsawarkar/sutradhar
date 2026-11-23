// Shapes shared by the daemon and the extension. Each zod schema here is
// both a tRPC procedure's input and (through the agent router) an MCP tool's
// input schema, so a field changed here changes every hop.

import { z } from 'zod';

export const Target = z.object({
  ref: z.string().optional().describe('Element ref from snapshot/find, e.g. "e12" or "f3:e7" (in a frame)'),
  selector: z.string().optional().describe('CSS selector (first match)'),
  text: z.string().optional().describe('Visible text or accessible name to match (exact first, then contains)'),
  x: z.number().optional().describe('Viewport x in CSS pixels (with y), for canvas and maps'),
  y: z.number().optional().describe('Viewport y in CSS pixels'),
});
export type Target = z.infer<typeof Target>;

const Common = {
  trusted: z.boolean().optional().describe('Use real OS input for this step (Firefox/Zen; Chrome input is always trusted)'),
  force: z.boolean().optional().describe('Act even if the element looks covered or disabled'),
};

const Modifier = z.enum(['Alt', 'Control', 'Meta', 'Shift']);

export const Step = z.discriminatedUnion('do', [
  z.object({ do: z.literal('click'), ...Target.shape, ...Common,
    button: z.enum(['left', 'right', 'middle']).optional(),
    count: z.number().int().min(1).max(3).optional().describe('2 = double click'),
    modifiers: z.array(Modifier).optional() }),
  z.object({ do: z.literal('hover'), ...Target.shape, ...Common }),
  z.object({ do: z.literal('move'), x: z.number(), y: z.number(), ...Common }),
  z.object({ do: z.literal('type'), ...Target.shape, ...Common,
    value: z.string().describe('Text to type'),
    clear: z.boolean().optional().describe('Empty the field first'),
    submit: z.boolean().optional().describe('Press Enter afterwards') }),
  z.object({ do: z.literal('press'), ...Target.shape, ...Common,
    keys: z.string().describe('A key or chord: "Enter", "Control+a", "Shift+Tab", "ArrowDown"') }),
  z.object({ do: z.literal('select'), ...Target.shape, ...Common,
    value: z.union([z.string(), z.array(z.string())]).describe('Option label or value (array for multi-select)') }),
  z.object({ do: z.literal('check'), ...Target.shape, ...Common, checked: z.boolean().optional() }),
  z.object({ do: z.literal('fill'), ...Common,
    fields: z.array(z.object({ ...Target.shape, value: z.union([z.string(), z.boolean(), z.array(z.string())]) })) }),
  z.object({ do: z.literal('clear'), ...Target.shape, ...Common }),
  z.object({ do: z.literal('focus'), ...Target.shape, ...Common }),
  z.object({ do: z.literal('scroll'), ...Target.shape, ...Common,
    direction: z.enum(['up', 'down', 'left', 'right']).optional(),
    amount: z.union([z.number(), z.enum(['page', 'end'])]).optional().describe('Pixels, "page" or "end"') }),
  z.object({ do: z.literal('drag'), ...Common,
    from: Target, to: Target }),
  z.object({ do: z.literal('upload'), ...Target.shape, ...Common,
    paths: z.array(z.string()).min(1).describe('Absolute paths of local files') }),
  z.object({ do: z.literal('wait'), ...Target.shape,
    ms: z.number().optional().describe('Just wait this long'),
    gone: z.boolean().optional().describe('Wait for the target/text to disappear'),
    url: z.string().optional().describe('Wait until the URL contains this'),
    timeout: z.number().optional() }),
]);
export type Step = z.infer<typeof Step>;

export const StepResult = z.object({
  do: z.string(),
  ok: z.boolean(),
  note: z.string().optional(),
  error: z.string().optional(),
  /** Set when the step was handed to the user or needed approval. */
  gate: z.enum(['handoff-done', 'handoff-declined', 'approved', 'denied', 'timeout', 'stopped']).optional(),
});
export type StepResult = z.infer<typeof StepResult>;

/** What the content script says about an element an action is about to touch. */
export const Risk = z.object({
  level: z.enum(['none', 'approve', 'handoff']),
  reason: z.string().optional(),
  /** Short human description: `button "Place order"` */
  what: z.string().optional(),
});
export type Risk = z.infer<typeof Risk>;

export const BrowserKind = z.enum(['chrome', 'chromium', 'brave', 'edge', 'firefox', 'zen', 'other']);
export type BrowserKind = z.infer<typeof BrowserKind>;

export const Hello = z.object({
  kind: BrowserKind,
  name: z.string(),
  version: z.string(),
  extension: z.string(),
  engine: z.enum(['chromium', 'gecko']),
  profile: z.string(),
});
export type Hello = z.infer<typeof Hello>;

export const EventKind = z.enum(['dialog', 'download', 'tab-created', 'tab-removed', 'navigated', 'console', 'user-input']);

export const Geometry = z.object({
  innerWidth: z.number(), innerHeight: z.number(),
  outerWidth: z.number(), outerHeight: z.number(),
  title: z.string(), windowId: z.number(),
});
export type Geometry = z.infer<typeof Geometry>;
