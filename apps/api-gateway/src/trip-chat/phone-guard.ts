/**
 * A Nigerian mobile number in a chat message, however it is typed:
 * 08031234567, 0803 123 4567, 0803-123-4567, +234 803 123 4567, 234.803.123.4567,
 * 8031234567, and O for zero (O8O3...).
 *
 * Drivers already have the rider's number. What this stops is a driver handing
 * the rider theirs, so the next trip is booked around Wheelers.
 */
export function containsPhoneNumber(text: string): boolean {
  const collapsed = text
    // O or o standing in for a zero next to a digit.
    .replace(/[oO](?=[\s\-.()/]*\d)|(?<=\d[\s\-.()/]*)[oO]/g, '0')
    // Spaces, dashes, dots, brackets and slashes between digits.
    .replace(/(?<=[\d+])[\s\-.()/]+(?=\d)/g, '');
  return /(?:\+?234|0)[789][01]\d{8}(?!\d)/.test(collapsed) || /(?<![\d+])[789][01]\d{8}(?!\d)/.test(collapsed);
}
