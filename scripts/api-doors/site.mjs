/**
 * site.mjs: where the site serves each door. No dependencies, because the site's build loads it too.
 */

/** The one source of which door does what. `docs-site` renders it, and so do the AI instruction files. */
export const IMPORT_MAP = 'ai-instructions/source/import-map.json';

/** The generated reference. A full address, so no site link router rewrites the `.html` of its pages. */
export const REFERENCE = 'https://footprintjs.github.io/footPrint/api/';

/** The record package has its own docs. This site does not document it twice. */
export const FOOTTRACE_DOCS = 'https://github.com/footprintjs/foottrace#readme';

/** The door that holds engine internals. It stays visible and every page marks it. */
export const INTERNALS_DOOR = 'footprintjs/advanced';

export const isEngineDoor = (door) => door === 'footprintjs' || door.startsWith('footprintjs/');

/** A door's page in the generated reference, from its root. TypeDoc writes `/` in a module name as `_`. */
export const doorPage = (door) => `modules/${door.replaceAll('/', '_')}.html`;

/** The sidebar's reference items, in import-map order. */
export const referenceSidebar = (rows) => [
  { label: 'All doors', link: REFERENCE },
  ...rows
    .filter(({ door }) => isEngineDoor(door))
    .map(({ door }) => ({
      label: door,
      link: `${REFERENCE}${doorPage(door)}`,
      ...(door === INTERNALS_DOOR ? { badge: { text: 'Engine internals', variant: 'caution' } } : {}),
    })),
  { label: 'foottrace', link: FOOTTRACE_DOCS, attrs: { target: '_blank', rel: 'noopener' } },
];
