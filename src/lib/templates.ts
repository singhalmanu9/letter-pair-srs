/**
 * Deck templates: starting points the user copies into their own storage.
 * The copy is fully independent; nothing links it back to the template.
 */

import { validateDeck, type Deck } from "./schemas";

export interface DeckTemplate {
  id: string;
  name: string;
  description: string;
  items: { term: string; answers: string[] }[];
}

export const EMPTY_TEMPLATE: DeckTemplate = {
  id: "empty",
  name: "My letter pairs",
  description: "Start from scratch and add your own letter pairs.",
  items: [],
};

/** Create a new user deck from a template, with fresh ids. */
export function createDeckFromTemplate(
  template: DeckTemplate,
  now: number,
  newId: () => string = () => crypto.randomUUID(),
): Deck {
  const deck: Deck = {
    id: newId(),
    name: template.name,
    templateId: template.id,
    createdAt: now,
    updatedAt: now,
    items: template.items.map((item) => ({
      id: newId(),
      term: item.term,
      answers: [...item.answers],
      updatedAt: now,
    })),
  };
  validateDeck(deck);
  return deck;
}
