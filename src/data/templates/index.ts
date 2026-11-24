import { EMPTY_TEMPLATE, type DeckTemplate } from "../../lib/templates";
import sample from "./sample.json";

/** Bundled starting decks, shown when a user creates a deck. */
export const TEMPLATES: readonly DeckTemplate[] = [sample, EMPTY_TEMPLATE];
