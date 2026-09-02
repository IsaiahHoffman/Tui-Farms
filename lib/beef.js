// ============================================================================
// lib/beef.js — beef catalog categories (pure functions, no I/O).
//
// The /beef page groups in-stock items into customer-friendly sections
// instead of one long list. Items carry an OPTIONAL `category` field
// ("ground" | "steaks" | "roasts"); the live data predates that field, so a
// name-based fallback covers the current cut names. An explicit category
// always wins over inference.
// ============================================================================

// Display order and labels. "Ground & Everyday" leads — cheap ground is the
// traffic draw. Items that are uncategorized AND unrecognizable by name fall
// into a trailing "More" section (rendered only when non-empty).
const BEEF_CATEGORIES = [
  { slug: 'ground', label: 'Ground & Everyday' },
  { slug: 'steaks', label: 'Steaks' },
  { slug: 'roasts', label: 'Roasts & Slow Cooking' },
];
const MORE_CATEGORY = { slug: 'more', label: 'More' };
const BEEF_CATEGORY_SLUGS = BEEF_CATEGORIES.map(c => c.slug);

// Name-based fallback for data without a category field. Covers every cut
// currently on the live list; anything unrecognized returns null ("More").
function inferBeefCategory(name) {
  const n = String(name || '').toLowerCase();
  if (n.includes('ground')) return 'ground';
  if (n.includes('roast') || n.includes('brisket') || n.includes('chuck tender')) return 'roasts';
  if (n.includes('steak') || n.includes('tri tip') || n.includes('filet mignon')
      || n.includes('delmonico') || n.includes('flat iron')
      || n.includes('petite tender')) return 'steaks';
  return null;
}

// The category an item displays under: explicit field first, then inference.
function beefCategoryOf(item) {
  if (item && BEEF_CATEGORY_SLUGS.includes(item.category)) return item.category;
  return inferBeefCategory(item && item.name);
}

// Group items into ordered display sections; empty sections are dropped and
// "More" trails only when something lands in it.
function groupBeefSections(items) {
  const sections = BEEF_CATEGORIES.map(c => ({ ...c, items: [] }));
  const more = { ...MORE_CATEGORY, items: [] };
  for (const item of items) {
    const slug = beefCategoryOf(item);
    const section = sections.find(s => s.slug === slug) || more;
    section.items.push(item);
  }
  sections.push(more);
  return sections.filter(s => s.items.length > 0);
}

module.exports = {
  BEEF_CATEGORIES,
  BEEF_CATEGORY_SLUGS,
  inferBeefCategory,
  beefCategoryOf,
  groupBeefSections,
};
