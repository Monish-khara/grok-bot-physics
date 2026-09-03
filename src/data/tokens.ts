/**
 * Grok Bot core (400) color tokens.
 *
 * Source (Sand-Toolkit, read-only):
 *   web/src/baby-grok/alphaLadder.ts — ALPHA_CORE_RGB, converted to hex.
 */

export type TokenName =
  | "black"
  | "white"
  | "brown"
  | "red"
  | "orange"
  | "yellow"
  | "green"
  | "cyan"
  | "blue"
  | "violet"
  | "magenta"
  | "gray";

export const TOKENS: Record<TokenName, string> = {
  black: "#000000",
  white: "#FFFFFF",
  brown: "#97683D",
  red: "#FF263C",
  orange: "#FF6700",
  yellow: "#FF9800",
  green: "#00C972",
  cyan: "#00BCA6",
  blue: "#1084FE",
  violet: "#9159FE",
  magenta: "#FF309B",
  gray: "#777777",
};

/** Hues used for bot bodies: everything but the neutrals. */
export const BOT_HUES: readonly TokenName[] = [
  "red",
  "orange",
  "yellow",
  "green",
  "cyan",
  "blue",
  "violet",
  "magenta",
  "brown",
];
