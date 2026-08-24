/**
 * Identifiers, shortened to the part a reader actually uses.
 *
 * Measured on a live `overlaps` answer: 7,890 bytes, of which 98 identifier mentions were
 * about 4,116 bytes -- **52% of the answer was raw UUID**. `agent_3ed6292e-24ff-47e6-8c30-
 * 59719e4ba803` is 42 characters, and a reader deciding whether two changes came from the same
 * worker needs exactly enough of it to tell it apart from the other ids in front of them.
 *
 * That is the whole rule: shorten, then lengthen again only where shortening would make two
 * different workers look like one. An answer is the unit because that is the only place the
 * comparison happens -- ids from different answers are never set side by side.
 */

/** Enough hex to be unique across far more agents than one repository's ledger will hold. */
const SHORT_SLUG_LENGTH = 8;

/**
 * The readable stem of an id, keeping any structure that carries meaning.
 *
 * Subagent ids are `agent_<session>.sub.<delegate>` and the `.sub.` marker is the thing that
 * says "this was delegated work" -- `patchmesh agents` groups a family by it. Truncating
 * through it would turn a subagent into what looks like an unrelated agent, so both halves are
 * shortened and the marker is kept.
 */
function shorten(id: string, slugLength: number): string {
  const separator = id.indexOf("_");
  if (separator === -1) return id;
  const prefix = id.slice(0, separator + 1);
  const rest = id.slice(separator + 1);

  const subagent = rest.indexOf(".sub.");
  if (subagent !== -1) {
    const session = rest.slice(0, subagent);
    const delegate = rest.slice(subagent + ".sub.".length);
    return `${prefix}${session.slice(0, slugLength)}.sub.${delegate.slice(0, slugLength)}`;
  }
  return `${prefix}${rest.slice(0, slugLength)}`;
}

/**
 * Shorten every id in one answer, keeping distinct ids distinct.
 *
 * On a collision the length grows for **everything**, not just the pair that collided. Mixed
 * lengths in one answer read as mixed kinds of thing, and the reader cannot tell which of two
 * neighbouring ids was the one that needed more of itself.
 *
 * Falls back to the full id rather than looping forever: two ids that are equal for their whole
 * length are the same id, so the loop always terminates, but saying so explicitly is cheaper
 * than making a reader prove it.
 */
export function shortIds(ids: Iterable<string>): ReadonlyMap<string, string> {
  const distinct = [...new Set(ids)];
  for (let length = SHORT_SLUG_LENGTH; length <= 36; length += 8) {
    const shortened = new Map<string, string>();
    const taken = new Set<string>();
    let collided = false;
    for (const id of distinct) {
      const short = shorten(id, length);
      if (taken.has(short)) {
        collided = true;
        break;
      }
      taken.add(short);
      shortened.set(id, short);
    }
    if (!collided) return shortened;
  }
  return new Map(distinct.map((id) => [id, id]));
}

/**
 * A shortener for one answer, with a lookup that never returns undefined.
 *
 * Renderers reach for ids in several passes -- a header, a per-row line, an evidence sentence -
 * and an id that appears in only one of them must still shorten. Anything not seen up front is
 * shortened on its own terms rather than reported as missing.
 */
export function idShortener(ids: Iterable<string>): (id: string) => string {
  const table = shortIds(ids);
  return (id: string) => table.get(id) ?? shorten(id, SHORT_SLUG_LENGTH);
}
