/** Reads a user MID from a pasted LINE profile link (`line://nv/profilePopup/mid=<MID>`) or a bare user MID. It makes no request. */
const USER_MID = '(u[0-9a-fA-F]{32})';
const LINK = new RegExp(`^line://nv/profilePopup/mid=${USER_MID}$`, 'i');
const BARE = new RegExp(`^${USER_MID}$`);

export function parseLineContactLink(input: string): string | null {
  const text = input.trim();
  const match = LINK.exec(text) ?? BARE.exec(text);
  return match ? match[1]!.toLowerCase() : null;
}
