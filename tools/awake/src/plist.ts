// Absolute paths in the watchdog's ProgramArguments, so doctor can spot a
// plist that points at something that was moved or removed.
export function programPaths(plist: string): string[] {
  const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist);
  if (!array) return [];
  const unxml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  return [...array[1].matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => unxml(m[1])).filter((v) => v.startsWith('/'));
}
