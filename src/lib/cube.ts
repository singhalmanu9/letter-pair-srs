/**
 * Cube model for letter schemes: sticker positions, which stickers form each
 * piece, the Speffz default letters, and face colors for an orientation.
 *
 * Stickers are indexed 0-23 per piece type, face by face (U, L, F, R, B, D),
 * clockwise from each face's top-left as seen in the standard net. That is
 * exactly Speffz order, so the default letter for index i is "ABC…X"[i].
 */

export type Face = "U" | "L" | "F" | "R" | "B" | "D";
export type PieceType = "corner" | "edge";
export type Color = "white" | "yellow" | "green" | "blue" | "red" | "orange";

export const FACES: readonly Face[] = ["U", "L", "F", "R", "B", "D"];
export const COLORS: readonly Color[] = ["white", "yellow", "green", "blue", "red", "orange"];
export const STICKERS_PER_TYPE = 24;
export const SPEFFZ = "ABCDEFGHIJKLMNOPQRSTUVWX".split("");

/** Face a sticker index sits on. */
export function faceOf(index: number): Face {
  return FACES[Math.floor(index / 4)]!;
}

/**
 * Corner pieces as sticker-index triples (Speffz: UBL = A E R, UBR = B N Q,
 * UFR = C J M, UFL = D F I, DFL = U G L, DFR = V K P, DBR = W O T, DBL = X H S).
 */
export const CORNER_PIECES: readonly (readonly number[])[] = [
  [0, 4, 17],
  [1, 13, 16],
  [2, 9, 12],
  [3, 5, 8],
  [20, 6, 11],
  [21, 10, 15],
  [22, 14, 19],
  [23, 7, 18],
];

/**
 * Edge pieces as sticker-index pairs (Speffz: UB = A Q, UR = B M, UF = C I,
 * UL = D E, LF = F L, LD = G X, LB = H R, FR = J P, FD = K U, RB = N T,
 * RD = O V, BD = S W).
 */
export const EDGE_PIECES: readonly (readonly number[])[] = [
  [0, 16],
  [1, 12],
  [2, 8],
  [3, 4],
  [5, 11],
  [6, 23],
  [7, 17],
  [9, 15],
  [10, 20],
  [13, 19],
  [14, 21],
  [18, 22],
];

export function piecesOf(type: PieceType): readonly (readonly number[])[] {
  return type === "corner" ? CORNER_PIECES : EDGE_PIECES;
}

/** Index of the piece a sticker belongs to. */
export function pieceIndexOf(type: PieceType, sticker: number): number {
  return piecesOf(type).findIndex((p) => p.includes(sticker));
}

/** Piece name from its faces, U/D first then F/B, e.g. "UFR", "DB". */
export function pieceName(type: PieceType, pieceIndex: number): string {
  const order: Face[] = ["U", "D", "F", "B", "R", "L"];
  const faces = piecesOf(type)[pieceIndex]!.map(faceOf);
  return faces.sort((a, b) => order.indexOf(a) - order.indexOf(b)).join("");
}

// --- Orientation and colors --------------------------------------------------

export interface Orientation {
  top: Color;
  front: Color;
}

/** WCA scramble orientation. */
export const SCRAMBLE_ORIENTATION: Orientation = { top: "white", front: "green" };

type Vec = readonly [number, number, number];

// Standard (Western) color scheme as axes: white up, green front, red right.
const COLOR_AXIS: Record<Color, Vec> = {
  white: [0, 1, 0],
  yellow: [0, -1, 0],
  green: [0, 0, 1],
  blue: [0, 0, -1],
  red: [1, 0, 0],
  orange: [-1, 0, 0],
};

const cross = (a: Vec, b: Vec): Vec => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const neg = (a: Vec): Vec => [-a[0], -a[1], -a[2]];
const colorOf = (v: Vec): Color => COLORS.find((c) => COLOR_AXIS[c].every((x, i) => x === v[i]))!;

/** Front colors that can go with a top color (not the top or its opposite). */
export function frontOptions(top: Color): Color[] {
  const t = COLOR_AXIS[top];
  return COLORS.filter((c) => COLOR_AXIS[c].every((x, i) => x * t[i]! === 0));
}

export function isValidOrientation(o: Orientation): boolean {
  return frontOptions(o.top).includes(o.front);
}

/** The color of each face when holding the cube in this orientation. */
export function faceColors(o: Orientation): Record<Face, Color> {
  if (!isValidOrientation(o)) throw new Error(`Invalid orientation: ${o.top} top, ${o.front} front`);
  const up = COLOR_AXIS[o.top];
  const front = COLOR_AXIS[o.front];
  const right = cross(up, front);
  return {
    U: o.top,
    D: colorOf(neg(up)),
    F: o.front,
    B: colorOf(neg(front)),
    R: colorOf(right),
    L: colorOf(neg(right)),
  };
}
