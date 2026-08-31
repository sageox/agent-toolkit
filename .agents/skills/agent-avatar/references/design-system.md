# Character design system

Use this reference to write or revise `avatar.md`. Keep every instruction here about
durable identity; leave rendering mechanics in `packages/cli/src/avatar-house-style.txt`.

## Translate the job into a character

Build the brief in this order:

1. **Role metaphor:** Turn the job into a trade, creature, explorer, craftsperson, or
   tall-tale figure whose purpose reads immediately.
2. **Silhouette:** Choose one head-and-shoulders shape distinct from neighboring agents.
3. **Signature prop:** Pick one oversized tool or object that belongs to the work. Route it
   behind or beside the face.
4. **Wardrobe and palette intent:** Describe function, mood, material, and one signature
   color. Avoid relying only on hex values.
5. **Background color:** Pick one flat, muted background hue that no other agent in the
   roster already uses, and record it as a hex. "Muted" alone under-constrains this — left
   unchecked, a roster converges on the same two or three easy colors, and a page of avatars
   that are all shades of sage green reads as one character repeated, not a team. The hex is
   what makes that comparable at a glance before generating; the CHAR brief still has to
   describe the same hue in words (see `avatar-house-style.txt`'s composition rules) so the
   identity survives a restyle.
6. **Expression and posture:** Encode the persona—patient, incisive, skeptical, buoyant,
   meticulous—without hiding the eyes.
7. **The joke:** Exaggerate scale, wear, or an occupational situation into one warm sight
   gag that survives thumbnail size.

## Apply the style-swap test

Mentally redraw the character as a clay model, ink sketch, pixel sprite, or photograph. If
the identity disappears, the brief contains rendering style rather than character design.
Strengthen the metaphor, silhouette, prop, expression, or joke.

Examples of durable instructions:

- “A field cartographer carrying a compass almost as wide as one shoulder.”
- “A careful repair technician whose patched satchel is organized with impossible rigor.”
- “A skeptical librarian holding one comically over-annotated index card.”

Examples that belong in house style instead:

- “Use thick charcoal outlines.”
- “Render with warm paper grain.”
- “Use a centered bust crop with soft rim light.”

## Optimize for chat scale

At 32 px, fine accessories and background details disappear. Preserve a large face, open
eyes, clear value separation, one dominant prop, and generous negative space around the
head. Avoid hands, labels, screens, scenery, and several competing objects unless the
identity truly depends on them.

## Keep the roster coherent without making clones

Share the rendering system, crop logic, and overall warmth across the roster. Vary role
metaphor, silhouette, signature prop, palette accent, background hue, expression, and joke.
Before approval, compare the candidate with existing agents at thumbnail size; reject a
design that could be mistaken for another character even if it is attractive in isolation —
and reject a background hue that only reads as distinct in isolation, not next to the rest
of the roster's thumbnails.
