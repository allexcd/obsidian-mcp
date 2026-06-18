export class NoteEditError extends Error {
  constructor(
    message: string,
    readonly code: "missing_text" | "ambiguous_text" | "invalid_occurrence"
  ) {
    super(message);
    this.name = "NoteEditError";
  }
}

export function appendNoteContent(existing: string, addition: string): string {
  if (!existing) {
    return addition;
  }
  return existing.endsWith("\n") ? `${existing}${addition}` : `${existing}\n${addition}`;
}

export function replaceExactText(existing: string, oldText: string, newText: string, occurrenceIndex?: number): string {
  const match = selectExactMatch(existing, oldText, occurrenceIndex);
  return `${existing.slice(0, match.index)}${newText}${existing.slice(match.index + oldText.length)}`;
}

export function deleteExactText(existing: string, text: string, occurrenceIndex?: number): string {
  return replaceExactText(existing, text, "", occurrenceIndex);
}

export function countExactMatches(existing: string, text: string): number {
  return findExactMatches(existing, text).length;
}

function selectExactMatch(existing: string, text: string, occurrenceIndex?: number): { index: number } {
  const matches = findExactMatches(existing, text);
  if (matches.length === 0) {
    throw new NoteEditError("Exact text was not found in the note. No changes were written.", "missing_text");
  }

  if (occurrenceIndex !== undefined) {
    const match = matches[occurrenceIndex];
    if (!match) {
      throw new NoteEditError(
        `Occurrence index ${occurrenceIndex} is out of range. The note contains ${matches.length} exact match(es).`,
        "invalid_occurrence"
      );
    }
    return match;
  }

  if (matches.length > 1) {
    throw new NoteEditError(
      `Exact text appears ${matches.length} times. Provide occurrenceIndex to choose which match to edit.`,
      "ambiguous_text"
    );
  }

  return matches[0]!;
}

function findExactMatches(existing: string, text: string): Array<{ index: number }> {
  if (!text) {
    return [];
  }
  const matches: Array<{ index: number }> = [];
  let start = 0;
  while (start <= existing.length) {
    const index = existing.indexOf(text, start);
    if (index < 0) {
      break;
    }
    matches.push({ index });
    start = index + text.length;
  }
  return matches;
}
