// Row shapes of the tables and views the screens use. Numeric columns come back
// from the API as numbers or strings, so they are read with toNum().

export type Num = number | string;

export type Unit = { code: string; name: string; dimension: string; base_code: string; factor_to_base: Num; sort_order: number };

export type Organisation = {
  id: string; name: string; legal_name: string | null; gstin: string | null; phone: string | null; email: string | null;
  address_line1: string | null; address_line2: string | null; city: string | null; state: string | null; pincode: string | null;
  timezone: string; currency: string; is_active: boolean;
};

export type Outlet = {
  id: string; organisation_id: string; name: string; code: string | null; gstin: string | null; phone: string | null;
  address_line1: string | null; address_line2: string | null; city: string | null; state: string | null; pincode: string | null;
  is_active: boolean;
};

export type StorageLocation = { id: string; organisation_id: string; outlet_id: string; name: string; kind: string; is_active: boolean };

export type Category = { id: string; organisation_id: string; name: string; sort_order: number; is_active: boolean };

export type Item = {
  id: string; organisation_id: string; item_no: number | null; category_id: string | null; code: string | null; name: string;
  item_type: 'raw' | 'prep' | 'packaging' | 'consumable'; base_unit: string; alt_unit: string | null; alt_per_base: Num | null;
  default_yield_pct: Num; shelf_life_days: number | null; track_expiry: boolean; hsn_code: string | null; gst_rate: Num | null;
  deduct_ingredients_on_sale: boolean; is_active: boolean;
};

export type PackSize = { id: string; organisation_id: string; item_id: string; name: string; quantity_in_base: Num; is_active: boolean };

export type Vendor = {
  id: string; organisation_id: string; name: string; code: string | null; contact_person: string | null; phone: string | null;
  whatsapp: string | null; email: string | null; gstin: string | null; address_line1: string | null; address_line2: string | null;
  city: string | null; state: string | null; pincode: string | null; payment_terms_days: number; preferred_channel: string;
  notes: string | null; is_active: boolean;
};

export type VendorItem = {
  id: string; organisation_id: string; vendor_id: string; item_id: string; pack_size_id: string | null; price_unit: string | null;
  purchase_qty_in_base: Num; rate: Num; rate_per_base: Num; valid_from: string; valid_to: string | null;
  vendor_item_code: string | null; min_order_qty: Num | null;
};

export type ItemOutletSettings = {
  organisation_id: string; outlet_id: string; item_id: string; is_stocked: boolean; preferred_vendor_id: string | null;
  default_location_id: string | null; reorder_level: Num | null; reorder_qty: Num | null; max_level: Num | null; lead_time_days: number | null;
};

export type OutletStock = {
  organisation_id: string; outlet_id: string; item_id: string; quantity: Num; value: Num; average_cost: Num | null;
  reorder_level: Num | null; reorder_qty: Num | null; below_reorder_level: boolean; is_negative: boolean;
};

export type LocationStock = { organisation_id: string; outlet_id: string; location_id: string; item_id: string; quantity: Num; value: Num; last_movement_at: string };

export type LedgerRow = {
  id: string; outlet_id: string; location_id: string; item_id: string; movement_type: string; quantity: Num; unit_cost: Num; value: Num;
  source_type: string; source_id: string | null; source_line_id: string | null; reverses_entry_id: string | null;
  occurred_at: string; recorded_by: string | null; note: string | null; created_at: string;
};

export type Adjustment = {
  id: string; organisation_id: string; outlet_id: string; location_id: string; item_id: string; kind: 'opening' | 'adjustment';
  quantity: Num; unit_cost: Num | null; reason: string; status: 'pending' | 'posted' | 'rejected'; requested_by: string | null;
  requested_at: string; decided_by: string | null; decided_at: string | null; decision_note: string | null;
};

export type Transfer = {
  id: string; organisation_id: string; outlet_id: string; transfer_no: string | null; from_location_id: string; to_location_id: string;
  status: 'draft' | 'sent' | 'received' | 'cancelled'; note: string | null; created_by: string | null; sent_by: string | null;
  sent_at: string | null; received_by: string | null; received_at: string | null; created_at: string;
};

export type TransferLine = { id: string; transfer_id: string; item_id: string; quantity_sent: Num; quantity_received: Num | null; note: string | null };

export type Wastage = {
  id: string; outlet_id: string; location_id: string; item_id: string; quantity: Num; reason: string; note: string | null;
  occurred_at: string; recorded_by: string | null; voided_at: string | null; void_reason: string | null;
};

export type StockCount = {
  id: string; organisation_id: string; outlet_id: string; location_id: string | null; count_no: string | null; scope_category_ids: string[];
  status: 'in_progress' | 'submitted' | 'approved' | 'cancelled'; note: string | null; started_by: string | null; started_at: string;
  submitted_at: string | null; approved_at: string | null;
};

export type CountLine = {
  id: string; count_id: string; item_id: string; location_id: string; counted_qty: Num | null; counted_at: string | null;
  system_qty: Num | null; unit_cost: Num | null; variance_qty: Num | null;
};

export type MenuCategory = { id: string; organisation_id: string; name: string; sort_order: number; is_active: boolean };

export type MenuItem = {
  id: string; organisation_id: string; category_id: string | null; code: string | null; name: string; selling_price: Num;
  gst_rate: Num | null; is_active: boolean;
};

export type MenuItemOutlet = { organisation_id: string; menu_item_id: string; outlet_id: string; selling_price: Num | null; is_available: boolean };

export type Recipe = {
  id: string; organisation_id: string; menu_item_id: string | null; prep_item_id: string | null; version: number; yield_qty: Num;
  status: 'draft' | 'active' | 'retired'; activated_at: string | null; note: string | null; created_at: string;
};

export type RecipeLine = {
  id: string; organisation_id: string; recipe_id: string; item_id: string; quantity: Num; unit: string; yield_pct: Num | null;
  quantity_in_base: Num; sort_order: number; note: string | null;
};

export type PrepBatch = {
  id: string; outlet_id: string; location_id: string; prep_item_id: string; recipe_id: string; batches: Num; quantity_produced: Num;
  note: string | null; produced_by: string | null; produced_at: string; voided_at: string | null; void_reason: string | null;
};

export type SalesImport = {
  id: string; organisation_id: string; outlet_id: string; business_date: string; source: 'manual' | 'csv' | 'pos'; source_ref: string | null;
  status: 'draft' | 'posted' | 'voided'; line_count: number; total_amount: Num; note: string | null; created_at: string;
  posted_at: string | null; voided_at: string | null; void_reason: string | null;
};

export type SalesLine = {
  id: string; sales_import_id: string; menu_item_id: string | null; pos_item_code: string | null; item_name: string; quantity: Num;
  unit_price: Num; amount: Num; recipe_id: string | null;
};

export type Role = { id: string; organisation_id: string; key: string; name: string; description: string | null; is_system: boolean; is_active: boolean; sort_order: number };

export type Permission = { code: string; area: string; description: string; sort_order: number };

export type AppTab = { key: string; label: string; path: string; section: string; view_permission: string | null; sort_order: number };

export type Member = {
  membership_id: string; user_id: string; email: string; full_name: string | null; role_id: string; role_key: string; role_name: string;
  all_outlets: boolean; outlet_ids: string[]; is_active: boolean; created_at: string;
};

export type ItemCost = { item_id: string; unit_cost: Num };

export type RecipeCost = {
  recipe_id: string; menu_item_id: string | null; prep_item_id: string | null; version: number; status: string; yield_qty: Num;
  total_cost: Num; cost_per_unit: Num; selling_price: Num | null; food_cost_pct: Num | null;
};

export type MovementSummary = {
  item_id: string; opening_qty: Num; opening_value: Num; opening_entries: Num; receipts: Num; transfers_in: Num; transfers_out: Num;
  production: Num; sales: Num; prep_consumption: Num; wastage: Num; staff_meals: Num; adjustments: Num; count_variance: Num;
  vendor_returns: Num; sales_value: Num; prep_consumption_value: Num; wastage_value: Num; count_variance_value: Num;
  closing_qty: Num; closing_value: Num;
};
