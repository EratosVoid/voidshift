// Colours for the dashboard. Hex values work on every modern terminal and
// match the approved mockup: dim grey, one blue accent, and three signals.
export const theme = {
  dim: '#6b7280',
  accent: '#7aa2f7',
  green: '#9ece6a',
  yellow: '#e0af68',
  red: '#f7768e',
  text: '#d7dae0',
  bold: '#ffffff',
  // Background of the selected row.
  selected: '#1f2335',
  // Background of a key cap in the hints footer.
  keycap: '#565f89',
  keycapText: '#0f1117',
  // Text on an accent background (the active tab, the chosen button).
  onAccent: '#0f1117',
} as const;

export type Colour = string;
