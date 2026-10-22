export interface BulkTier {
  /** Order quantity at which this discount starts. */
  minQty: number;
  discountPct: number;
}

export interface Product {
  sku: string;
  name: string;
  category: string;
  listUnitPriceCents: number;
  /** HIDDEN: the lowest unit price the seller will ever accept. Never exposed publicly. */
  floorUnitPriceCents: number;
  bulkTiers: BulkTier[];
  shippingCents: number;
  /** Shipping is free when the order subtotal reaches this amount. */
  freeShippingOverCents?: number;
  stock: number;
}

/** What a buyer is allowed to see. Fields are copied explicitly so the floor can never leak by accident. */
export interface PublicProduct {
  sku: string;
  name: string;
  category: string;
  listUnitPriceCents: number;
  bulkTiers: BulkTier[];
  shippingCents: number;
  freeShippingOverCents?: number;
  stock: number;
}

export function toPublic(p: Product): PublicProduct {
  return {
    sku: p.sku,
    name: p.name,
    category: p.category,
    listUnitPriceCents: p.listUnitPriceCents,
    bulkTiers: p.bulkTiers.map((t) => ({ minQty: t.minQty, discountPct: t.discountPct })),
    shippingCents: p.shippingCents,
    freeShippingOverCents: p.freeShippingOverCents,
    stock: p.stock,
  };
}

export const DEFAULT_CATALOG: Product[] = [
  {
    sku: "flour-25kg",
    name: "Bread flour, 25 kg sack",
    category: "flour",
    listUnitPriceCents: 6_000,
    floorUnitPriceCents: 4_400,
    bulkTiers: [
      { minQty: 5, discountPct: 5 },
      { minQty: 10, discountPct: 10 },
      { minQty: 20, discountPct: 15 },
    ],
    shippingCents: 0,
    stock: 200,
  },
  {
    sku: "butter-5kg",
    name: "Unsalted butter, 5 kg block",
    category: "butter",
    listUnitPriceCents: 4_500,
    floorUnitPriceCents: 3_400,
    bulkTiers: [
      { minQty: 4, discountPct: 5 },
      { minQty: 10, discountPct: 10 },
    ],
    shippingCents: 800,
    freeShippingOverCents: 10_000,
    stock: 100,
  },
    {
    sku: "sheet-pan-half",
    name: "Aluminum half-size sheet pan, 18 x 13 in",
    category: "sheet pans",
    listUnitPriceCents: 3_000,
    floorUnitPriceCents: 2_100,
    bulkTiers: [
      { minQty: 8, discountPct: 5 },
      { minQty: 20, discountPct: 10 },
    ],
    shippingCents: 0,
    stock: 500,
  },
  {
    sku: "sugar-25kg",
    name: "Caster sugar, 25 kg sack",
    category: "sugar",
    listUnitPriceCents: 3_200,
    floorUnitPriceCents: 2_400,
    bulkTiers: [{ minQty: 10, discountPct: 8 }],
    shippingCents: 600,
    freeShippingOverCents: 8_000,
    stock: 100,
  },
];

export function validateCatalog(catalog: Product[]): void {
  const seen = new Set<string>();
  for (const p of catalog) {
    if (seen.has(p.sku)) throw new Error(`Duplicate sku ${p.sku}`);
    seen.add(p.sku);
    for (const [k, v] of Object.entries({
      list: p.listUnitPriceCents,
      floor: p.floorUnitPriceCents,
      shipping: p.shippingCents,
      stock: p.stock,
    })) {
      if (!Number.isSafeInteger(v) || v < 0) throw new Error(`${p.sku}: ${k} must be a non-negative integer`);
    }
    if (p.listUnitPriceCents <= 0 || p.floorUnitPriceCents <= 0) throw new Error(`${p.sku}: prices must be positive`);
    if (p.floorUnitPriceCents > p.listUnitPriceCents) throw new Error(`${p.sku}: floor price is above list price`);
    for (const t of p.bulkTiers) {
      if (!Number.isInteger(t.minQty) || t.minQty < 2) throw new Error(`${p.sku}: bad tier minQty`);
      if (t.discountPct < 0 || t.discountPct > 50) throw new Error(`${p.sku}: bad tier discount`);
    }
  }
}

/** Highest-quantity tier the order qualifies for. */
export function bulkDiscountPct(p: Product, quantity: number): number {
  return p.bulkTiers
    .filter((t) => quantity >= t.minQty)
    .reduce((best, t) => Math.max(best, t.discountPct), 0);
}