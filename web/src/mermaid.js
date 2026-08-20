// Models occasionally compress a Mermaid flowchart into one long line. Mermaid
// requires statement boundaries after the direction, edges, and style rules.
// Restore only those unambiguous boundaries; valid multiline input is unchanged.
export function normalizeMermaid(source) {
  const input = String(source).trim();
  if (input.includes("\n")) return input;
  return input
    .replace(/^(flowchart|graph)\s+(TD|TB|BT|RL|LR)\s+(?=\S)/i, "$1 $2\n")
    .replace(/([\]\)}])\s+([A-Za-z_][\w-]*)\s+(?=(?:-->|---|-.->|==>))/g, "$1\n$2 ")
    .replace(/\s+(?=(?:style|classDef|class|linkStyle)\s+[A-Za-z_])/g, "\n");
}
