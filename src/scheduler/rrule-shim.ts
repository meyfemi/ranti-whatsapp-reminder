// rrule ships CommonJS without named ESM exports, so named imports fail under Node ESM.
import rrulePkg from 'rrule';

export const { RRule } = rrulePkg as unknown as typeof import('rrule');
export type { Options } from 'rrule';
export type RRuleType = import('rrule').RRule;
