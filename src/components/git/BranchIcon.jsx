// TASK-18.13 D9: the branch glyph as an inline SVG sized with the text (the
// «⎇» character, U+2387, is missing from the UI fonts and rendered as a tiny
// stray mark). Same drawing as «⋯ → Git» (ChatMenu GitIcon); currentColor —
// light and dark alike.
export default function BranchIcon() {
  return (
    <svg class="branch-ic" width="1.1em" height="1.1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
      <circle cx="6" cy="5" r="2" />
      <circle cx="6" cy="19" r="2" />
      <circle cx="18" cy="8" r="2" />
      <path d="M6 7v10M18 10c0 4-6 3-11.5 7.5" />
    </svg>
  );
}
