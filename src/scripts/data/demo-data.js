// Demo data for the Phase 1 UI shell. Clearly labelled as demo so we don't
// pretend to be reading from a real DB. Numeric values are static so the
// layout renders deterministically.

export const DEMO_TRANSACTIONS = [
  { id: 'INV-10247', time: '09:42', customer: 'Walk-in', items: 6, total: 184.50,  status: 'Paid'    },
  { id: 'INV-10246', time: '10:15', customer: 'Aisha K.', items: 3, total:  62.20,  status: 'Paid'    },
  { id: 'INV-10245', time: '10:31', customer: 'Walk-in', items: 9, total: 311.00,  status: 'Paid'    },
  { id: 'INV-10244', time: '11:08', customer: 'Marco D.', items: 2, total:  24.75,  status: 'Refunded'},
  { id: 'INV-10243', time: '11:54', customer: 'Walk-in', items: 11, total: 458.90, status: 'Paid'    },
  { id: 'INV-10242', time: '12:22', customer: 'Priya R.', items: 4, total:  97.40,  status: 'Paid'    }
];

export const DEMO_LOW_STOCK = [
  { sku: 'DAIR-004', name: 'Whole Milk 1L',     stock:  3, reorder: 10 },
  { sku: 'BAK-012',  name: 'Sourdough Loaf',    stock:  5, reorder: 12 },
  { sku: 'BEV-031',  name: 'Sparkling Water',   stock:  4, reorder: 15 },
  { sku: 'SNK-077',  name: 'Dark Chocolate Bar',stock:  6, reorder: 20 }
];

export const DEMO_TODAY = {
  sales: 4287.55,
  bills: 38,
  products: 612,
  lowStock: 7,
  avgTicket: 112.83
};

export const DEMO_TOP_PRODUCTS = [
  { name: 'Bananas (1 kg)',      sold: 84 },
  { name: 'Olive Oil 500ml',     sold: 61 },
  { name: 'Toilet Paper 9-pack', sold: 54 },
  { name: 'Brown Rice 1kg',      sold: 47 },
  { name: 'Greek Yogurt 500g',   sold: 39 }
];

export const DEMO_SALES_TREND = [
  { hour: '08', value: 220 },
  { hour: '09', value: 410 },
  { hour: '10', value: 360 },
  { hour: '11', value: 520 },
  { hour: '12', value: 690 },
  { hour: '13', value: 740 },
  { hour: '14', value: 480 },
  { hour: '15', value: 530 },
  { hour: '16', value: 610 },
  { hour: '17', value: 720 }
];
