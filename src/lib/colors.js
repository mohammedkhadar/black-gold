export const C = {
  reset:  "\x1b[0m",
  bold:   "\x1b[1m",
  dim:    "\x1b[2m",
  red:    "\x1b[91m",
  green:  "\x1b[92m",
  yellow: "\x1b[93m",
};

export const col = (c, s) => `${c}${s}${C.reset}`;
