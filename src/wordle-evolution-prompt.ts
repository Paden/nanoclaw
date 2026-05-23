// Deterministic avatar-prompt template for pet evolutions. The agent-driven
// ceremony post is unreliable about including the image-generation prompt
// (Gemini-3-flash skips multi-step instructions), so the host posts the
// prompt directly as a sibling message to the ceremony task.
//
// Stage lineage palettes + motifs are per-pet, per-target-stage. If a
// specific stage isn't listed, falls back to the pet's general flavor.

interface PetFlavor {
  emoji: string;
  palette: string;
  defaultMotif: string;
  stages: Record<string, string>;
}

const PET_FLAVOR: Record<string, PetFlavor> = {
  Voss: {
    emoji: '🌋',
    palette: 'obsidian black, magma orange, ember gold, ash grey, deep crimson',
    defaultMotif: 'volcanic essence — molten lineage, ash and ember in its presence',
    stages: {
      Beast: 'volcanic-rock skin with glowing fissures across its body, ember claws, a slow plume of smoke from its shoulders',
      Spirit:
        'a half-flesh half-flame Spirit-form fire-walker, ember-eyed, ash trailing every movement, heat warping the air around it',
      Elemental:
        'obsidian plates cracked with rivers of molten gold, a core of compressed white-hot pressure that bends the air around it, ash and ember swirling in low tectonic waves at its feet, twin calderas for eyes — full of slow patient heat',
      Chimera:
        'a many-headed volcanic apex with rivers of magma fusing each form into one, obsidian armor laced with veins of gold, each head a different elemental temperament',
      Wyrm: 'a serpentine titan of compressed lava and obsidian, miles of coiled molten body, eyes like collapsing stars',
    },
  },
  Nyx: {
    emoji: '🌙',
    palette: 'deep indigo, cosmic violet, bioluminescent teal, silver-white',
    defaultMotif: 'lunar/cosmic essence — moonlight, vapor, drifting starlight',
    stages: {
      Beast: 'congealed moonlight in feline shape, silver-furred with constellations across its flanks, eyes like twin moons',
      Spirit:
        'a Moonfang Specter — half-corporeal lunar essence, claws of crystalline silver, a halo of cold blue starlight, drifting just above the ground',
      Elemental:
        'a flowing bioluminescent vapor pulsing with the rhythm of galactic tides, vast abyssal wells containing rotating star-clusters for eyes, ozone and stardust shimmering around her, electronic devices flickering in her presence',
      Chimera:
        'a constellation made flesh — multiple moons orbiting a central nebular form, each lunar phase manifested as a different facet of her body',
      Wyrm: 'a celestial leviathan of compressed dark matter and lunar light, miles long, body marked with the orbits of dead stars',
    },
  },
  Zima: {
    emoji: '❄️',
    palette: 'ice blue, glacial cyan, frost white, deep arctic shadow, silver',
    defaultMotif: 'cryogenic essence — frost, glass, ancient cold',
    stages: {
      Beast: 'crystalline ice scales over a powerful frame, frost-breath fogging the air, claws of clear glacial ice',
      Spirit:
        'a Spirit-form winter wraith, half-snow half-flesh, eyes like frozen lakes, an aurora of ice-particles drifting in its wake',
      Elemental:
        'a body of compressed glacial ice over a heart of impossible-blue arctic light, exhaling clouds that crystallize into geometric snowflakes, every step leaving a sheet of frost, fangs of clear sub-zero ice',
      Chimera:
        'multiple winter forms fused — wolf, owl, leviathan — joined by veins of frozen aurora light, shards of ancient ice plating its armor',
      Wyrm: 'a serpentine titan of fractal ice, miles of coiled glacial mass, eyes like the deepest part of a frozen sea',
    },
  },
};

interface AvatarPromptInput {
  owner: string;
  petName: string;
  prevStage: string;
  newStage: string;
}

export function buildAvatarPromptMessage({ owner, petName, prevStage, newStage }: AvatarPromptInput): string {
  const flavor = PET_FLAVOR[petName];
  const motif = flavor?.stages[newStage] ?? flavor?.defaultMotif ?? `a creature at the ${newStage} stage`;
  const palette = flavor?.palette ?? 'evocative thematic colors';

  return [
    `**${petName} has evolved → ${newStage}.** ${owner}, here's your image-generation prompt — paste it into ChatGPT / DALL-E / Midjourney / Imagen, then reply with the image (attachment or URL):`,
    '',
    '```',
    `A square portrait avatar of an ${newStage}-tier mythological creature.`,
    `Once a ${prevStage}-form bonded to ${owner}, ${petName} has crossed`,
    `the threshold into ${newStage}. Lineage: ${motif}. Color palette:`,
    `${palette}. Cinematic painterly fantasy style, clean background,`,
    `centered composition, suitable for use as a Discord profile avatar.`,
    '```',
    '',
    `Reply with the image and I'll update ${petName}'s persona so future webhook posts use it.`,
  ].join('\n');
}
