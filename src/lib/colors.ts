export const C = {
  reset:  "\x1b[0m",
  bold:   "\x1b[1m",
  dim:    "\x1b[2m",
  red:    "\x1b[91m",
  green:  "\x1b[92m",
  yellow: "\x1b[93m",
} as const;

export type ColorCode = (typeof C)[keyof typeof C];

export const col = (c: ColorCode, s: string): string => `${c}${s}${C.reset}`;
