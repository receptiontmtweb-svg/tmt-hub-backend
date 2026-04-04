-- ============================================================
-- TMT HUB v14 — Schéma SQL Supabase / PostgreSQL
-- ============================================================
-- Coller dans : Supabase → SQL Editor → Run
-- Ordre d'exécution : respecter les dépendances FK
-- ============================================================

-- Extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm"; -- recherche full-text

-- ============================================================
-- 1. COMPANIES (tenants SaaS)
-- ============================================================
CREATE TABLE IF NOT EXISTS companies (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         TEXT        UNIQUE NOT NULL,           -- ex: "tmt-web"
  name         TEXT        NOT NULL,
  siret        TEXT,
  email        TEXT,
  plan         TEXT        DEFAULT 'solo'             -- solo | pro | business | enterprise
    CHECK (plan IN ('solo','pro','business','enterprise')),
  status       TEXT        DEFAULT 'active'
    CHECK (status IN ('active','suspended','cancelled','trial')),
  settings     JSONB       DEFAULT '{}',
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_companies_slug   ON companies(slug);
CREATE INDEX IF NOT EXISTS idx_companies_status ON companies(status);

-- ============================================================
-- 2. USERS
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   TEXT        NOT NULL REFERENCES companies(slug) ON DELETE CASCADE,
  email        TEXT        UNIQUE NOT NULL,
  full_name    TEXT,
  role         TEXT        DEFAULT 'user'
    CHECK (role IN ('owner','admin','user','viewer')),
  status       TEXT        DEFAULT 'active'
    CHECK (status IN ('active','inactive','invited')),
  last_login   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_users_company ON users(company_id);
CREATE INDEX IF NOT EXISTS idx_users_email   ON users(email);

-- ============================================================
-- 3. MARKETPLACE_ACCOUNTS (credentials chiffrés)
-- ============================================================
CREATE TABLE IF NOT EXISTS marketplace_accounts (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   TEXT        NOT NULL REFERENCES companies(slug) ON DELETE CASCADE,
  marketplace  TEXT        NOT NULL,                  -- amazon | cdiscount | ebay | rakuten | wix | fnac
  credentials  TEXT        NOT NULL,                  -- AES-256-GCM chiffré, jamais exposé
  is_active    BOOLEAN     DEFAULT TRUE,
  sandbox_mode BOOLEAN     DEFAULT FALSE,
  last_sync    TIMESTAMPTZ,
  sync_status  TEXT        DEFAULT 'never'
    CHECK (sync_status IN ('never','ok','error','running')),
  error_msg    TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, marketplace)
);
CREATE INDEX IF NOT EXISTS idx_mp_accounts_company ON marketplace_accounts(company_id);

-- ============================================================
-- 4. PRODUCTS (catalogue maître)
-- ============================================================
CREATE TABLE IF NOT EXISTS products (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    TEXT        NOT NULL REFERENCES companies(slug) ON DELETE CASCADE,
  sku           TEXT        NOT NULL,
  ean           TEXT,
  asin          TEXT,
  title         TEXT        NOT NULL,
  brand         TEXT,
  category      TEXT,
  buy_price     INTEGER     DEFAULT 0,                -- centimes HT
  selling_price INTEGER     DEFAULT 0,                -- centimes HT
  weight_grams  INTEGER     DEFAULT 0,
  img1          TEXT,
  img2          TEXT,
  img3          TEXT,
  description   TEXT,
  keywords      TEXT,
  status        TEXT        DEFAULT 'active'
    CHECK (status IN ('active','inactive','deleted')),
  source_mp     TEXT,                                 -- marketplace d'origine de l'import
  quality_score INTEGER     DEFAULT 0 CHECK (quality_score BETWEEN 0 AND 100),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, sku)
);
CREATE INDEX IF NOT EXISTS idx_products_company  ON products(company_id);
CREATE INDEX IF NOT EXISTS idx_products_ean      ON products(ean);
CREATE INDEX IF NOT EXISTS idx_products_asin     ON products(asin);
CREATE INDEX IF NOT EXISTS idx_products_status   ON products(company_id, status);
CREATE INDEX IF NOT EXISTS idx_products_brand    ON products(company_id, brand);
-- Recherche full-text sur titre
CREATE INDEX IF NOT EXISTS idx_products_title_trgm ON products USING GIN (title gin_trgm_ops);

-- ============================================================
-- 5. PRODUCT_MARKETPLACE_DATA (prix/SKU par marketplace)
-- ============================================================
CREATE TABLE IF NOT EXISTS product_marketplace_data (
  id              UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id      UUID    NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  company_id      TEXT    NOT NULL,
  marketplace     TEXT    NOT NULL,
  marketplace_sku TEXT,
  marketplace_id  TEXT,                               -- ASIN, SellerProductId, etc.
  price           INTEGER DEFAULT 0,                  -- centimes TTC spécifique MP
  is_active       BOOLEAN DEFAULT TRUE,
  last_sync       TIMESTAMPTZ,
  sync_status     TEXT    DEFAULT 'never',
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(product_id, marketplace)
);
CREATE INDEX IF NOT EXISTS idx_pmd_product    ON product_marketplace_data(product_id);
CREATE INDEX IF NOT EXISTS idx_pmd_company_mp ON product_marketplace_data(company_id, marketplace);

-- ============================================================
-- 6. STOCK_ITEMS
-- ============================================================
CREATE TABLE IF NOT EXISTS stock_items (
  id           UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   TEXT    NOT NULL REFERENCES companies(slug) ON DELETE CASCADE,
  marketplace  TEXT    NOT NULL,
  sku          TEXT    NOT NULL,
  asin         TEXT,
  quantity     INTEGER DEFAULT 0,
  quantity_reserved INTEGER DEFAULT 0,
  alert_threshold   INTEGER DEFAULT 5,
  price        INTEGER DEFAULT 0,                     -- centimes, prix MP actuel
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, marketplace, sku)
);
CREATE INDEX IF NOT EXISTS idx_stock_company ON stock_items(company_id);
CREATE INDEX IF NOT EXISTS idx_stock_low     ON stock_items(company_id, quantity) WHERE quantity <= 5;

-- ============================================================
-- 7. ORDERS
-- ============================================================
CREATE TABLE IF NOT EXISTS orders (
  id               UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       TEXT    NOT NULL REFERENCES companies(slug) ON DELETE CASCADE,
  marketplace      TEXT    NOT NULL,
  marketplace_id   TEXT    NOT NULL,                  -- ID commande chez la MP
  buyer_name       TEXT,
  buyer_email      TEXT,
  buyer_address    JSONB   DEFAULT '{}',
  total_amount     NUMERIC(10,2) DEFAULT 0,
  currency         TEXT    DEFAULT 'EUR',
  status           TEXT    DEFAULT 'new'
    CHECK (status IN ('new','processing','shipped','delivered','cancelled','returned','refunded')),
  tracking_number  TEXT,
  carrier          TEXT,
  tracking_url     TEXT,
  notes            TEXT,
  raw_payload      JSONB,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW(),
  shipped_at       TIMESTAMPTZ,
  UNIQUE(company_id, marketplace, marketplace_id)
);
CREATE INDEX IF NOT EXISTS idx_orders_company    ON orders(company_id);
CREATE INDEX IF NOT EXISTS idx_orders_marketplace ON orders(company_id, marketplace);
CREATE INDEX IF NOT EXISTS idx_orders_status     ON orders(company_id, status);
CREATE INDEX IF NOT EXISTS idx_orders_date       ON orders(created_at DESC);

-- ============================================================
-- 8. ORDER_ITEMS
-- ============================================================
CREATE TABLE IF NOT EXISTS order_items (
  id           UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id     UUID    NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  company_id   TEXT    NOT NULL,
  sku          TEXT,
  ean          TEXT,
  asin         TEXT,
  title        TEXT,
  quantity     INTEGER DEFAULT 1,
  unit_price   NUMERIC(10,2) DEFAULT 0,
  total_price  NUMERIC(10,2) DEFAULT 0,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_order_items_order   ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_company ON order_items(company_id);

-- ============================================================
-- 9. TRANSPORTERS
-- ============================================================
CREATE TABLE IF NOT EXISTS transporters (
  id           UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   TEXT    NOT NULL REFERENCES companies(slug) ON DELETE CASCADE,
  carrier_id   TEXT    NOT NULL,                      -- colissimo | chronopost | mondialrelay | dpd | gls | ups
  carrier_name TEXT    NOT NULL,
  credentials  TEXT,                                  -- AES-256-GCM chiffré
  is_active    BOOLEAN DEFAULT TRUE,
  settings     JSONB   DEFAULT '{}',
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, carrier_id)
);

-- ============================================================
-- 10. SHIPMENTS
-- ============================================================
CREATE TABLE IF NOT EXISTS shipments (
  id               UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       TEXT    NOT NULL REFERENCES companies(slug) ON DELETE CASCADE,
  order_id         UUID    REFERENCES orders(id),
  marketplace      TEXT,
  carrier          TEXT    NOT NULL,
  carrier_name     TEXT,
  tracking_number  TEXT,
  label_url        TEXT,
  status           TEXT    DEFAULT 'created'
    CHECK (status IN ('created','picked_up','in_transit','out_for_delivery','delivered','failed','returned')),
  weight_kg        NUMERIC(8,3),
  cost_ht          NUMERIC(8,2),
  cost_ttc         NUMERIC(8,2),
  shipped_at       TIMESTAMPTZ,
  delivered_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_shipments_company  ON shipments(company_id);
CREATE INDEX IF NOT EXISTS idx_shipments_tracking ON shipments(tracking_number);
CREATE INDEX IF NOT EXISTS idx_shipments_status   ON shipments(company_id, status);

-- ============================================================
-- 11. SYNC_JOBS (queue persistée)
-- ============================================================
CREATE TABLE IF NOT EXISTS sync_jobs (
  id           UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   TEXT    NOT NULL,
  type         TEXT    NOT NULL,                      -- sync_orders | sync_stock | sync_products | etc.
  payload      JSONB   DEFAULT '{}',
  status       TEXT    DEFAULT 'pending'
    CHECK (status IN ('pending','running','done','failed','retry')),
  priority     TEXT    DEFAULT 'normal'
    CHECK (priority IN ('high','normal','low')),
  attempts     INTEGER DEFAULT 0,
  max_attempts INTEGER DEFAULT 3,
  result       JSONB,
  error        TEXT,
  duration_ms  INTEGER,
  scheduled_at TIMESTAMPTZ DEFAULT NOW(),
  started_at   TIMESTAMPTZ,
  finished_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_jobs_company  ON sync_jobs(company_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status   ON sync_jobs(status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_jobs_type     ON sync_jobs(company_id, type);

-- ============================================================
-- 12. SYNC_LOGS (audit trail des synchronisations)
-- ============================================================
CREATE TABLE IF NOT EXISTS sync_logs (
  id           UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   TEXT    NOT NULL,
  marketplace  TEXT    NOT NULL,
  job_type     TEXT    NOT NULL,
  status       TEXT    NOT NULL
    CHECK (status IN ('success','partial','error')),
  records_in   INTEGER DEFAULT 0,
  records_out  INTEGER DEFAULT 0,
  errors_count INTEGER DEFAULT 0,
  duration_ms  INTEGER,
  detail       TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sync_logs_company ON sync_logs(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_logs_mp      ON sync_logs(company_id, marketplace);

-- ============================================================
-- TRIGGERS — updated_at automatique
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['companies','users','marketplace_accounts','products',
    'product_marketplace_data','stock_items','orders','transporters','shipments']
  LOOP
    EXECUTE format('
      DROP TRIGGER IF EXISTS trg_%I_updated ON %I;
      CREATE TRIGGER trg_%I_updated
        BEFORE UPDATE ON %I
        FOR EACH ROW EXECUTE FUNCTION update_updated_at();
    ', t, t, t, t);
  END LOOP;
END $$;

-- ============================================================
-- RLS — Row Level Security (activer en multi-tenant)
-- ============================================================
-- Activer après avoir configuré l'authentification Supabase Auth
-- ALTER TABLE companies             ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE users                 ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE marketplace_accounts  ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE products              ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE product_marketplace_data ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE stock_items           ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE orders                ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE order_items           ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE transporters          ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE shipments             ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE sync_jobs             ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE sync_logs             ENABLE ROW LEVEL SECURITY;

-- Exemple policy (à décommenter après config Supabase Auth)
-- CREATE POLICY company_isolation ON products
--   USING (company_id = (SELECT slug FROM companies WHERE id = auth.uid()::uuid));

-- ============================================================
-- SEED — données de base
-- ============================================================
INSERT INTO companies (slug, name, plan, status)
VALUES ('tmt-web', 'TMT WEB', 'pro', 'active')
ON CONFLICT (slug) DO NOTHING;

-- ============================================================
-- VUES UTILES
-- ============================================================

-- Vue dashboard : stocks faibles
CREATE OR REPLACE VIEW v_low_stock AS
SELECT s.company_id, s.marketplace, s.sku, s.quantity, s.alert_threshold,
       p.title, p.ean, p.brand
FROM stock_items s
LEFT JOIN products p ON p.company_id = s.company_id AND p.sku = s.sku
WHERE s.quantity <= s.alert_threshold;

-- Vue dashboard : commandes récentes
CREATE OR REPLACE VIEW v_recent_orders AS
SELECT o.company_id, o.marketplace, o.marketplace_id, o.buyer_name,
       o.total_amount, o.currency, o.status, o.created_at
FROM orders o
WHERE o.created_at > NOW() - INTERVAL '30 days'
ORDER BY o.created_at DESC;

-- Vue sync health
CREATE OR REPLACE VIEW v_sync_health AS
SELECT company_id, marketplace,
       COUNT(*)                                          AS total_jobs,
       COUNT(*) FILTER (WHERE status = 'success')       AS success,
       COUNT(*) FILTER (WHERE status = 'error')         AS errors,
       MAX(created_at)                                  AS last_sync,
       AVG(duration_ms)::INTEGER                        AS avg_duration_ms
FROM sync_logs
WHERE created_at > NOW() - INTERVAL '7 days'
GROUP BY company_id, marketplace;
