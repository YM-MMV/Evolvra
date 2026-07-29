import type { Terminology } from "@/lib/types";
import { singularizeTerm } from "@/lib/utils";

export type TerminologyKey = keyof Terminology;

export interface TermForms {
  plural: string;
  singular: string;
  pluralLower: string;
  singularLower: string;
}

export type TerminologyForms = Record<TerminologyKey, TermForms>;

const TERM_KEYS: TerminologyKey[] = ["goals", "quests", "areas", "milestones", "stats"];

/** Build consistent singular, plural, and sentence-case forms for UI copy. */
export function terminologyForms(terminology: Terminology): TerminologyForms {
  return Object.fromEntries(TERM_KEYS.map((key) => {
    const plural = terminology[key].trim();
    const singular = singularizeTerm(plural);
    return [key, {
      plural,
      singular,
      pluralLower: plural.toLocaleLowerCase(),
      singularLower: singular.toLocaleLowerCase(),
    }];
  })) as TerminologyForms;
}
