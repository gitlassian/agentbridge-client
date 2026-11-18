// Much of what the commands print was written by teammates and their agents: message bodies,
// statuses, names of files, parts and tasks. Printed as it is, such text could act on the terminal
// it is shown in: an escape sequence moves the cursor and rewrites lines already there, a
// carriage return overwrites the line it is on, and the characters that change the direction of
// text make a name read differently from what it is.

/** One line of text with nothing hidden in it: no control characters, no direction marks. */
export const bare = (text: string) =>
  text.replace(/[\p{Cc}\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu, "");

/** Text shown on one line: any run of whitespace becomes one space, and nothing hidden stays. */
export const oneLine = (text: string) => bare(text.replace(/\s+/g, " ")).trim();

/** Text of several lines as it can be shown to a person: `bare`, but line breaks and tabs stay. */
export const printable = (text: string) =>
  text.replace(/(?![\n\t])[\p{Cc}\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu, "");
